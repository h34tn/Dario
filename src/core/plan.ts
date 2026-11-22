import { z } from 'zod';
import type { ProjectSettings } from './config.js';
import type { RoleBook } from './roles.js';
import { normalizeScopePath } from './scope.js';
import type { LeadDecision, Plan, PlanStep } from './types.js';

/** 取文本里最后一个能解析的 JSON：优先 ```json 代码块，其次整段文本。 */
export function extractJson(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const v: unknown = JSON.parse(blocks[i]!);
      if (v && typeof v === 'object') return v;
    } catch {
      // 换下一个代码块
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // 不是 JSON
    }
  }
  // 最后一个以 { 开头并能解析到文末的片段
  for (let i = trimmed.lastIndexOf('{'); i >= 0; i = trimmed.lastIndexOf('{', i - 1)) {
    try {
      const v: unknown = JSON.parse(trimmed.slice(i));
      if (v && typeof v === 'object') return v;
    } catch {
      // 继续向前找
    }
    if (i === 0) break;
  }
  return undefined;
}

/**
   * 去掉回复末尾的 JSON 计划，留下前面的正文。主控直接回答问题时，正文就是答案。
   */
export function proseBeforeJson(text: string): string {
  const blocks = [...text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const m = blocks[i]!;
    try {
      const v: unknown = JSON.parse(m[1]!.trim());
      if (v && typeof v === 'object') return (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim();
    } catch {
      // 换下一个代码块
    }
  }
  const trimmed = text.trim();
  for (let i = trimmed.lastIndexOf('{'); i >= 0; i = trimmed.lastIndexOf('{', i - 1)) {
    try {
      const v: unknown = JSON.parse(trimmed.slice(i));
      if (v && typeof v === 'object') return trimmed.slice(0, i).trim();
    } catch {
      // 继续向前找
    }
    if (i === 0) break;
  }
  return trimmed;
}

const planSchema = z.object({
  summary: z.string().default(''),
  answer: z.string().nullish(),
  steps: z
    .array(
      z.object({
        role: z.string().min(1),
        task: z.string().min(1),
        writes: z.boolean().default(false),
        acceptance: z.string().nullish(),
        files: z.array(z.string()).nullish(),
      }),
    )
    .default([]),
});

export interface PlanContext extends Pick<ProjectSettings, 'leadRole' | 'leadImplements' | 'maxPlanSteps'> {
  roles: RoleBook;
}

/** 解析并校验主控给出的计划。校验不通过时返回给主控看的错误说明。 */
export function parsePlan(text: string, ctx: PlanContext): { plan: Plan } | { error: string } {
  const raw = extractJson(text);
  if (raw === undefined) return { error: '回复里没有找到 JSON 计划。请在回复最后输出一个 ```json 代码块。' };
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '（顶层）'}: ${i.message}`).join('；');
    return { error: `计划的格式不对：${detail}` };
  }
  const errors: string[] = [];
  const steps: PlanStep[] = [];
  parsed.data.steps.forEach((s, i) => {
    const n = i + 1;
    const roleId = ctx.roles.resolve(s.role);
    if (!roleId) {
      errors.push(`第 ${n} 步的角色 "${s.role}" 不存在，可用角色：${ctx.roles.ids().join('、')}`);
      return;
    }
    if (roleId === ctx.leadRole) {
      if (!ctx.leadImplements) {
        errors.push(`第 ${n} 步不能交给主控自己（${roleId}）`);
        return;
      }
      if (!s.writes) {
        errors.push(`第 ${n} 步：交给主控自己的步骤必须是要改文件的小改动；只需要阅读和判断的事直接写在思路或答案里`);
        return;
      }
    } else if (s.writes && ctx.roles.get(roleId).access !== 'write') {
      errors.push(`第 ${n} 步要改文件，但角色 ${roleId} 是只读的`);
      return;
    }
    const files = s.writes ? [...new Set((s.files ?? []).map(normalizeScopePath).filter(Boolean))] : [];
    steps.push({ role: roleId, task: s.task, writes: s.writes, acceptance: s.acceptance ?? undefined, ...(files.length > 0 && { files }) });
  });
  if (steps.length > ctx.maxPlanSteps) errors.push(`计划有 ${steps.length} 步，超过上限 ${ctx.maxPlanSteps} 步`);
  // 没有步骤就是直接回答：答案是 JSON 之前的正文，只写一遍。JSON 里另外写了 answer 的（旧写法）以它为准
  const answer = parsed.data.answer || (parsed.data.steps.length === 0 ? proseBeforeJson(text) : '') || null;
  if (parsed.data.steps.length === 0 && !answer && !parsed.data.summary) {
    errors.push('计划既没有步骤，也没有给出答案');
  }
  if (errors.length > 0) return { error: errors.join('；') };
  return { plan: { summary: parsed.data.summary, answer, steps } };
}

const verdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  issues: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
});

export interface Verdict {
  verdict: 'pass' | 'fail';
  /** 必须修改的问题，不通过时据此返工。 */
  issues: string[];
  /** 可改可不改、或要发起人取舍的建议，不要求返工。 */
  suggestions: string[];
}

/** 解析审查结论。没有给出明确结论时返回 undefined。 */
const decisionSchema = z.object({
  action: z.enum(['continue', 'correct', 'stop']),
  message: z.string().default(''),
  snooze_minutes: z.number().positive().default(10),
});

/** 解析主控对监控告警的判断。纠偏没有写说明时算解析失败：没法告诉干活的一方要改什么。 */
export function parseLeadDecision(text: string): LeadDecision | undefined {
  const parsed = decisionSchema.safeParse(extractJson(text));
  if (!parsed.success) return undefined;
  const { action, message, snooze_minutes } = parsed.data;
  if (action === 'correct' && !message.trim()) return undefined;
  return { action, message: message.trim(), snoozeMinutes: snooze_minutes };
}

export function parseVerdict(text: string): Verdict | undefined {
  const parsed = verdictSchema.safeParse(extractJson(text));
  return parsed.success ? parsed.data : undefined;
}

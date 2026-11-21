import fs from 'node:fs';
import path from 'node:path';
import type { Activity } from '../plugin.js';
import type { RoleView } from './roles.js';
import { exitCodeForJob, STATUS_LABEL, type Job } from './types.js';
import { formatDuration } from './util.js';

export function formatActivity(activity: Activity): string {
  if (activity.kind === 'say') return activity.text;
  if (activity.kind === 'think') return '思考中';
  const label = { read: '读', search: '搜', run: '执行', edit: '改', tool: '工具' };
  return `${label[activity.kind]} ${activity.target}`;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已遮盖的私钥]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[已遮盖]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[已遮盖]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[已遮盖]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[已遮盖]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[已遮盖]'],
  [/\b[tu]-[A-Za-z0-9_.-]{24,}/g, '[已遮盖]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer [已遮盖]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[已遮盖]'],
  [
    /((?:api[_-]?key|app[_-]?secret|secret|access[_-]?token|token|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
    '$1[已遮盖]',
  ],
];

/** 遮盖形似密钥、令牌的内容。extra 是已知的具体密钥值。 */
export function redact(text: string, extra: string[] = []): string {
  let out = text;
  for (const secret of extra) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[已遮盖]');
  }
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** 超长时只保留开头，全文写入文件。返回要发送的文字。 */
export function clip(text: string, maxChars: number, fullFile: string): string {
  if (text.length <= maxChars) return text;
  try {
    fs.mkdirSync(path.dirname(fullFile), { recursive: true });
    fs.writeFileSync(fullFile, text, 'utf8');
  } catch {
    // 落盘失败时仍然返回截断后的内容
  }
  return `${text.slice(0, maxChars)}\n\n…（内容过长已截断，全文共 ${text.length} 字，保存在本机 ${fullFile}）`;
}

export interface JobJson {
  job_id: string;
  status: string;
  exit_code: number;
  mode: string;
  conclusion: string;
  changed_files: string[];
  fallback_happened: boolean;
  warnings: string[];
  branch: string | null;
  unfinished: string | null;
  plan: { summary: string; steps: Array<{ role: string; task: string; writes: boolean }> } | null;
  steps: Array<{
    index: number;
    kind: string;
    role: string;
    agent: string | null;
    outcome: string;
    reason: string | null;
    duration_ms: number;
    changed_files: string[];
    /** 这一步是否续接了该角色在本任务里已有的会话。 */
    resumed: boolean;
    attempts: Array<{ agent: string; outcome: string; reason: string | null }>;
  }>;
}

/** 无头方式 JSON 输出的固定结构。 */
export function jobToJson(job: Job): JobJson {
  return {
    job_id: job.id,
    status: job.status,
    exit_code: exitCodeForJob(job),
    mode: job.mode,
    conclusion: job.result?.conclusion ?? '',
    changed_files: job.result?.changedFiles ?? job.changedFiles,
    fallback_happened: job.result?.fallbackHappened ?? false,
    warnings: job.result?.warnings ?? job.warnings,
    branch: job.result?.branch ?? job.branch ?? null,
    unfinished: job.result?.unfinished ?? null,
    plan: job.plan
      ? { summary: job.plan.summary, steps: job.plan.steps.map((s) => ({ role: s.role, task: s.task, writes: s.writes })) }
      : null,
    steps: job.steps.map((s) => ({
      index: s.index,
      kind: s.kind,
      role: s.role,
      agent: s.agent ?? null,
      outcome: s.outcome,
      reason: s.reason ?? null,
      duration_ms: s.durationMs,
      changed_files: s.changedFiles,
      resumed: s.resumed === true,
      attempts: s.attempts.map((a) => ({ agent: a.agent, outcome: a.outcome, reason: a.reason ?? null })),
    })),
  };
}

const KIND_LABEL: Record<string, string> = { plan: '计划', step: '执行', review: '审查', rework: '返工', summary: '汇总' };
const OUTCOME_LABEL: Record<string, string> = {
  ok: '完成',
  unavailable: '不可用',
  task_failed: '未完成',
  timeout: '超时',
  all_unavailable: '无可用 AI',
  skipped: '跳过',
};

/** 各步由谁完成、耗时、是否换过人。 */
export function formatSteps(job: Job): string {
  return job.steps
    .map((s) => {
      const switched = s.agent ? s.attempts.filter((a) => a.agent !== s.agent && a.outcome !== 'ok') : [];
      const note = switched.length ? `（${switched.map((a) => `${a.agent} 不可用`).join('，')}，已换人）` : '';
      return `  ${s.index + 1}. ${KIND_LABEL[s.kind] ?? s.kind} · ${s.role} · ${s.agent ?? '-'} · ${OUTCOME_LABEL[s.outcome] ?? s.outcome} · ${formatDuration(s.durationMs)}${note}`;
    })
    .join('\n');
}

/** 给人看的任务结果。 */
export function formatJob(job: Job): string {
  const r = job.result;
  const lines: string[] = [`[${job.id}] ${STATUS_LABEL[job.status]}`];
  if (job.status === 'awaiting_approval') {
    lines.push('计划含改文件的步骤，等待确认。');
  }
  if (r?.conclusion) lines.push('', r.conclusion.trim());
  const changed = r?.changedFiles ?? job.changedFiles;
  if (changed.length) lines.push('', `改动的文件（${changed.length}）：`, ...changed.map((f) => `  ${f}`));
  if (r?.branch) lines.push('', `产出所在分支：${r.branch}`);
  if (job.steps.length) lines.push('', '各步：', formatSteps(job));
  const warnings = r?.warnings ?? job.warnings;
  if (warnings.length) lines.push('', '注意：', ...warnings.map((w) => `  - ${w}`));
  return lines.join('\n');
}

const STATE_LABEL: Record<string, string> = {
  ok: '可用',
  unknown: '未配置',
  disabled: '已停用',
  not_installed: '未安装',
  unavailable: '暂时不可用',
};

export function formatRoles(views: RoleView[], fallback: string): string {
  const lines: string[] = [];
  for (const v of views) {
    const name = v.alias[0] ? `${v.alias[0]}（${v.id}）` : v.id;
    const holder = v.holder ?? '无可用 AI';
    const pinned = v.override ? `，已临时指定 ${v.override}` : '';
    lines.push(`${name} · ${v.access === 'write' ? '可写' : '只读'} · 当前担当：${holder}${pinned}`);
    lines.push(`  候选：${v.candidates.map((c) => `${c.agent}[${STATE_LABEL[c.state] ?? c.state}]`).join(' → ')}`);
  }
  lines.push('', `不可用时：${fallback === 'auto' ? '自动换下一家' : '只报告，不自动换人'}`);
  return lines.join('\n');
}

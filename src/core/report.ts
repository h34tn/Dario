import { displayWidth } from './display-width.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Activity, QuotaWindow } from '../plugin.js';
import type { AgentView } from './engine.js';
import type { RoleView } from './roles.js';
import { exitCodeForJob, STATUS_LABEL, type ConsultRecord, type FallbackQuestion, type Job, type StepKind, type StepRecord } from './types.js';
import { formatDuration, formatLocalTime, formatTokens } from './util.js';

function isQuotaWindowActive(window: QuotaWindow, now: Date): boolean {
  return !window.resetsAt || Date.parse(window.resetsAt) > now.getTime();
}

export function quotaPercent(quota: AgentView['quota'], now: Date): number | undefined {
  if (quota?.free) return 0;
  if (!quota?.windows.length) return undefined;
  const primary = quota.windows.find(w => w.primary);
  if (primary) return isQuotaWindowActive(primary, now) ? Math.round(primary.usedPercent) : undefined;
  const active = quota.windows.filter(w => isQuotaWindowActive(w, now));
  return active.length ? Math.round(Math.max(...active.map(w => w.usedPercent))) : undefined;
}

export function formatQuota(quota: AgentView['quota'], now: Date): string {
  if (quota?.free) return '额度 0%（免费）';
  const windows = quota?.windows.filter(w => isQuotaWindowActive(w, now));
  if (!windows?.length) return '额度未知';
  windows.sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const lengthOf = (w: QuotaWindow): string => {
    const minutes = w.windowMinutes;
    return minutes === undefined ? w.id : minutes < 60 ? `${minutes} 分钟` :
      minutes < 1440 ? `${minutes / 60} 小时` : `${minutes / 1440} 天`;
  };
  // 两个窗口长度相同（例如 Claude 的两个 7 天窗口）时只写长度分不清，补上工具报告的窗口标识
  const seen = new Map<string, number>();
  for (const w of windows) seen.set(lengthOf(w), (seen.get(lengthOf(w)) ?? 0) + 1);
  return '额度 ' + windows.map(w => {
    const length = lengthOf(w);
    const name = seen.get(length)! > 1 && length !== w.id ? `${length}（${w.id}）` : length;
    // 名称以全角括号结尾时，后面不再加空格
    const usage = `${name}${name.endsWith('）') ? '' : ' '}${Math.round(w.usedPercent)}%`;
    if (!w.resetsAt) return usage;
    const today = new Date(w.resetsAt).toDateString() === now.toDateString();
    const time = formatLocalTime(w.resetsAt).slice(today ? 11 : 5);
    return `${usage}（${time} 重置）`;
  }).join('、');
}

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

export type ModelLabel = (agent: string, model: string) => string;

export function formatModel(agent: string, model?: string, effort?: string, label?: ModelLabel): string {
  return (model ? label?.(agent, model) ?? model : agent) + (effort ? `[${effort}]` : '');
}

export function formatModelTable(views: RoleView[], label?: ModelLabel, wide = false): string[] {
  const sources = { local: '本机', project: '项目', default: '默认', tool: '工具默认' };
  const rows = views.map(view => {
    const name = view.alias[0] ?? view.id;
    const c = view.candidates.find(c => c.agent === view.holder);
    return c ? [name, c.agent, formatModel(c.agent, c.model, c.effort, label), sources[c.modelSource]]
      : [name, '无可用 AI'];
  });
  const widths = [0, 0, 0];
  for (const row of rows) {
    row.slice(0, -1).forEach((cell, i) => { widths[i] = Math.max(widths[i]!, displayWidth(cell, wide)); });
  }
  return rows.map(row => row.map((cell, i) => i === row.length - 1 ? cell
    : cell + ' '.repeat(widths[i]! - displayWidth(cell, wide) + 3)).join(''));
}

function agentName(a: { agent: string; model?: string; modelLabel?: string; effort?: string }, label?: ModelLabel): string {
  return a.model || a.effort ? `${a.agent}（${formatModel(a.agent, a.modelLabel ?? a.model, a.effort, label)}）` : a.agent;
}

/** 换人之前问发起人的话：谁不可用、为什么、打算改用谁，都带上具体的模型。两行，第二行是问题本身。 */
export function formatFallbackQuestion(q: FallbackQuestion): [string, string] {
  const role = q.roleLabel.replace(/（[^（）]*）$/, '');
  const down = q.from.map((f) => `${agentName(f)} 不可用（${f.reason}）`).join('；');
  return [`${role}的担当者 ${down}。`, `改用备选 ${agentName(q.to)} 继续这个任务吗？`];
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
  /** steps[].files 是计划给这一步的预计改动范围，refs 是主控标出、派活时附上的代码位置，没写时为 null。 */
  plan: { summary: string; steps: Array<{ role: string; task: string; writes: boolean; files: string[] | null; refs: string[] | null; git: boolean }> } | null;
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
    /**
     * token 用量；工具不报用量时为 null。input 含命中缓存的部分 cached_input。
     * requests 是请求次数，first_input 是第一次请求的输入，工具不报时为 null。
     */
    tokens: { input: number; cached_input: number; output: number; requests: number | null; first_input: number | null } | null;
    cost_usd: number | null;
    /** 从启动工具到它输出第一行的时间；不可知时为 null。 */
    startup_ms: number | null;
    /** Dario 交给工具的任务说明的字数；没有启动工具时为 null。 */
    prompt_chars: number | null;
    /** 运行中监控发现的问题，按发现的先后排列；没有时为空数组。decision 是 ask_lead 时主控的判断，没有时为 null。 */
    alerts: Array<{ rule: string; action: string; at_ms: number; detail: string; decision: { action: string; message: string } | null }>;
    /** 运行中请主控判断的记录；没有时为空数组。 */
    consults: Array<{
      rule: string;
      agent: string | null;
      outcome: string;
      reason: string | null;
      duration_ms: number;
      tokens: { input: number; cached_input: number; output: number } | null;
      cost_usd: number | null;
      decision: { action: string; message: string } | null;
    }>;
    attempts: Array<{ agent: string; outcome: string; reason: string | null }>;
  }>;
  /**
   * 按步骤种类（plan、step、rework、review、summary）汇总的耗时和用量，按流程先后排列，只列出现过的种类。
   * 请主控判断的开销单列为 supervise，steps 是判断的次数；它和干活的一方同时进行，耗时不计入各步耗时之和。
   */
  phases: PhaseJson[];
}

export interface PhaseJson {
  kind: string;
  steps: number;
  duration_ms: number;
  startup_ms: number;
  /** 这一阶段的步骤都不报用量时，这四项为 null；只有部分步骤报时，是报了的那些步骤之和。 */
  input: number | null;
  cached_input: number | null;
  output: number | null;
  requests: number | null;
  cost_usd: number | null;
}

/** 步骤种类，加上"监督"：请主控判断监控告警的开销。 */
export type PhaseKind = StepKind | 'supervise';

const PHASE_ORDER: PhaseKind[] = ['plan', 'step', 'rework', 'review', 'summary', 'supervise'];

export interface PhaseTotal {
  kind: PhaseKind;
  steps: number;
  durationMs: number;
  startupMs: number;
  input: number;
  cachedInput: number;
  output: number;
  requests: number;
  /** 有一步报了用量。 */
  metered: boolean;
  /** 有一步报了费用就算；都没报时为空。 */
  costUsd?: number;
}

/** ownRow 为 false 时只计用量和费用：合计里判断与干活同时进行，次数和耗时不重复计。 */
function addConsult(total: PhaseTotal, c: ConsultRecord, ownRow = true): void {
  if (ownRow) {
    total.steps += 1;
    total.durationMs += c.durationMs;
  }
  if (c.tokens) total.metered = true;
  total.input += c.tokens?.input ?? 0;
  total.cachedInput += c.tokens?.cachedInput ?? 0;
  total.output += c.tokens?.output ?? 0;
  total.requests += c.tokens?.requests ?? 0;
  if (c.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + c.costUsd;
}

function addPhase(total: PhaseTotal, s: StepRecord): void {
  total.steps += 1;
  total.durationMs += s.durationMs;
  total.startupMs += s.startupMs ?? 0;
  if (s.tokens) total.metered = true;
  total.input += s.tokens?.input ?? 0;
  total.cachedInput += s.tokens?.cachedInput ?? 0;
  total.output += s.tokens?.output ?? 0;
  total.requests += s.tokens?.requests ?? 0;
  if (s.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + s.costUsd;
}

const emptyPhase = (kind: PhaseKind): PhaseTotal =>
  ({ kind, steps: 0, durationMs: 0, startupMs: 0, input: 0, cachedInput: 0, output: 0, requests: 0, metered: false });

/** 按步骤种类汇总耗时和用量，看清时间和 token 花在流程的哪一段。 */
export function phaseTotals(job: Job): PhaseTotal[] {
  const byKind = new Map<PhaseKind, PhaseTotal>();
  for (const s of job.steps) {
    let total = byKind.get(s.kind);
    if (!total) byKind.set(s.kind, (total = emptyPhase(s.kind)));
    addPhase(total, s);
    for (const c of s.consults ?? []) {
      let sup = byKind.get('supervise');
      if (!sup) byKind.set('supervise', (sup = emptyPhase('supervise')));
      addConsult(sup, c);
    }
  }
  return PHASE_ORDER.filter((k) => byKind.has(k)).map((k) => byKind.get(k)!);
}

function formatPhase(label: string, p: Omit<PhaseTotal, 'kind'>, unit = '步'): string {
  const fresh = Math.max(0, p.input - p.cachedInput);
  const parts = [
    `${label}  ${p.steps} ${unit}`,
    formatDuration(p.durationMs) + (p.startupMs ? `（启动 ${formatDuration(p.startupMs)}）` : ''),
  ];
  if (p.metered) parts.push(`新输入 ${formatTokens(fresh)} · 缓存 ${formatTokens(p.cachedInput)} · 输出 ${formatTokens(p.output)} token`);
  if (p.requests) parts.push(`${p.requests} 次请求`);
  if (p.costUsd !== undefined) parts.push(`$${p.costUsd.toFixed(2)}`);
  return '  ' + parts.join(' · ');
}

/** 各阶段一行，最后一行合计。少于两个阶段时只有一行，没有合计。 */
export function formatPhases(job: Job): string {
  const phases = phaseTotals(job);
  const lines = phases.map((p) => formatPhase(KIND_LABEL[p.kind] ?? p.kind, p, p.kind === 'supervise' ? '次' : '步'));
  if (phases.length > 1) {
    const sum = emptyPhase('step');
    for (const s of job.steps) {
      addPhase(sum, s);
      // 判断和干活的一方同时进行：用量和费用算进合计，耗时不重复计
      for (const c of s.consults ?? []) addConsult(sum, c, false);
    }
    lines.push(formatPhase('合计', sum));
  }
  return lines.join('\n');
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
      ? { summary: job.plan.summary, steps: job.plan.steps.map((s) => ({ role: s.role, task: s.task, writes: s.writes, files: s.files ?? null, refs: s.refs ?? null, git: s.git === true })) }
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
      tokens: s.tokens
        ? {
          input: s.tokens.input, cached_input: s.tokens.cachedInput, output: s.tokens.output,
          requests: s.tokens.requests ?? null, first_input: s.tokens.firstInput ?? null,
        }
        : null,
      cost_usd: s.costUsd ?? null,
      startup_ms: s.startupMs ?? null,
      prompt_chars: s.promptChars ?? null,
      alerts: (s.alerts ?? []).map((a) => ({ rule: a.rule, action: a.action, at_ms: a.atMs, detail: a.detail, decision: a.decision ?? null })),
      consults: (s.consults ?? []).map((c) => ({
        rule: c.rule,
        agent: c.agent ?? null,
        outcome: c.outcome,
        reason: c.reason ?? null,
        duration_ms: c.durationMs,
        tokens: c.tokens ? { input: c.tokens.input, cached_input: c.tokens.cachedInput, output: c.tokens.output } : null,
        cost_usd: c.costUsd ?? null,
        decision: c.decision ? { action: c.decision.action, message: c.decision.message } : null,
      })),
      attempts: s.attempts.map((a) => ({ agent: a.agent, outcome: a.outcome, reason: a.reason ?? null })),
    })),
    phases: phaseTotals(job).map((p) => ({
      kind: p.kind, steps: p.steps, duration_ms: p.durationMs, startup_ms: p.startupMs,
      input: p.metered ? p.input : null, cached_input: p.metered ? p.cachedInput : null, output: p.metered ? p.output : null,
      requests: p.requests || null, cost_usd: p.costUsd ?? null,
    })),
  };
}

const KIND_LABEL: Record<string, string> = { plan: '计划', step: '执行', review: '审查', rework: '返工', summary: '汇总', supervise: '监督' };
const DECISION_LABEL: Record<string, string> = { continue: '主控判断继续', correct: '主控要求纠偏', stop: '主控中止' };
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
      // 输入分开写：新发送的，和重发历史时命中缓存的。后者随请求次数累加，价格很低
      const tokens = s.tokens
        ? ` · 输入 ${formatTokens(Math.max(0, s.tokens.input - s.tokens.cachedInput))}（另有缓存命中 ${formatTokens(s.tokens.cachedInput)}）输出 ${formatTokens(s.tokens.output)} token`
        : '';
      // 起这一步的固定开销：启动用了多久、第一次请求就带了多少输入、其中 Dario 的任务说明多长
      const fixed = [
        s.startupMs !== undefined && `启动 ${formatDuration(s.startupMs)}`,
        s.tokens?.requests && `${s.tokens.requests} 次请求`,
        s.tokens?.firstInput && `首次输入 ${formatTokens(s.tokens.firstInput)}`,
        s.promptChars && `任务说明 ${formatTokens(s.promptChars)} 字`,
      ].filter(Boolean).join('，');
      const time = formatDuration(s.durationMs) + (fixed ? `（${fixed}）` : '');
      const head = `  ${s.index + 1}. ${KIND_LABEL[s.kind] ?? s.kind} · ${s.role} · ${s.agent ?? '-'} · ${OUTCOME_LABEL[s.outcome] ?? s.outcome} · ${time}${tokens}${note}`;
      const alerts = (s.alerts ?? []).map((a) => {
        const decided = a.decision ? `；${DECISION_LABEL[a.decision.action] ?? a.decision.action}${a.decision.message ? `：${a.decision.message}` : ''}` : '';
        return `     ! ${formatDuration(a.atMs)}：${a.detail}${a.action === 'stop' ? '，已中断' : ''}${decided}`;
      });
      return [head, ...alerts].join('\n');
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
  if (job.steps.length) lines.push('', '各步：', formatSteps(job), '', '按阶段：', formatPhases(job));
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

export function formatRoles(views: RoleView[], fallback: string, label?: ModelLabel): string {
  const lines: string[] = [];
  for (const v of views) {
    const name = v.alias[0] ? `${v.alias[0]}（${v.id}）` : v.id;
    const current = v.candidates.find(c => c.agent === v.holder);
    const holder = current ? agentName(current, label) : '无可用 AI';
    const pinned = v.override ? `，已临时指定 ${v.override}` : '';
    lines.push(`${name} · ${v.access === 'write' ? '可写' : '只读'} · 当前担当：${holder}${pinned}`);
    lines.push(`  候选：${v.candidates.map((c) => `${agentName(c, label)}[${STATE_LABEL[c.state] ?? c.state}]`).join(' → ')}`);
  }
  lines.push('', `不可用时：${fallback === 'auto' ? '自动换下一家' : fallback === 'ask' ? '先询问，同意后换下一家' : '只报告，不自动换人'}`);
  return lines.join('\n');
}

/**
 * Dario 插件接口：接入一家 AI 命令行工具所需实现的全部内容。
 *
 * 插件只描述"怎么调用、怎么读结果"，不自己启动进程。进程的启动、超时、
 * 进程树终止、环境变量名单与换人都由 Dario 统一负责。
 */

import { open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN_API_VERSION = 1 as const;

export type Access = 'read-only' | 'write';
export type Activity =
  | { kind: 'read'; target: string }
  | { kind: 'search'; target: string }
  | { kind: 'run'; target: string }
  | { kind: 'edit'; target: string }
  | { kind: 'tool'; target: string }
  | { kind: 'say'; text: string }
  | { kind: 'think' };
export type FailureKind = 'unavailable' | 'task_failed' | 'timeout';

/** 一次运行到目前为止的 token 用量。 */
export interface TokenUsage {
  /** 各次请求发给模型的 token 之和，命中缓存的部分也算在内。 */
  input: number;
  /** input 里命中缓存的部分。 */
  cachedInput: number;
  /** 模型输出的 token，含推理。 */
  output: number;
  /**
   * 这几个数是整个会话的累计值，而不是这一次运行的。只有工具只报累计值时才这样标，
   * 续接时 Dario 会减去上一轮结束时的累计值。
   */
  sessionTotal?: boolean;
  /** 这次运行向模型发了几次请求。工具不报每次请求的用量时为空。 */
  requests?: number;
  /**
   * 第一次请求的输入 token（含命中缓存的部分）：工具的系统提示、工具定义、项目说明加上 Dario 发的任务说明，
   * 是每起一次进程都要付的固定开销。续接会话时还包括之前的对话。工具不报时为空。
   */
  firstInput?: number;
}

/** 工具自己报告的一个限额窗口。 */
export interface QuotaWindow {
  /** 工具报告的窗口标识。 */
  id: string;
  /** 已用百分数（0–100，超额时大于 100）。 */
  usedPercent: number;
  /** 窗口长度，单位为分钟。 */
  windowMinutes?: number;
  /** 窗口的重置时刻，ISO 8601 字符串。 */
  resetsAt?: string;
  /** 标记当前起约束作用的窗口。 */
  primary?: true;
}

export interface QuotaReader {
  /** 逐行读取标准输出，有额度报告时返回全部窗口。 */
  onLine?(line: string): QuotaWindow[] | undefined;
  /** 运行结束后读取会话记录，有额度报告时返回全部窗口。 */
  afterRun?(info: { sessionId?: string; env: NodeJS.ProcessEnv }): Promise<QuotaWindow[] | undefined> | QuotaWindow[] | undefined;
}

export interface InvokeRequest {
  access: Access;
  /** AI 的工作目录（绝对路径）。 */
  cwd: string;
  /** 完整的任务说明。 */
  prompt: string;
  /** 本轮任务附带的本机图片绝对路径。 */
  images?: string[];
  model?: string;
  effort?: string;
  /** 本次放行的工具清单；不支持该概念的工具忽略即可。 */
  allowedTools: string[];
  /**
   * 可写方式下不再逐项审批：这一步需要什么工具、命令都放行，由工具自己的"全部放行"方式实现。
   * 只在可写方式出现；用户把权限设为按清单放行（permissions: listed）时不出现。不支持的工具忽略即可。
   */
  unrestricted?: boolean;
  /** 可供 AI 写入最终答复的文件路径（位于任务目录内，调用前不存在）。 */
  resultFile: string;
  /** 用户在 agents.yaml 的 options 里给这个 AI 写的自由配置。 */
  options: Record<string, unknown>;
  /** 要续接的会话号。只有声明了 resumes 的插件会收到；有值时 prompt 只是这一轮的增量说明。 */
  resume?: string;
}

export interface Invocation {
  /** 命令行参数，不含可执行文件本身。 */
  args: string[];
  /** 写入标准输入的内容。任务说明应当从这里传入，而不是拼进参数。 */
  stdin?: string;
  /** 额外设置的环境变量。 */
  env?: Record<string, string>;
}

export interface RawResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** resultFile 的内容；文件不存在时为 undefined。 */
  resultFileText?: string;
  /** 进程无法启动时的原因。 */
  spawnError?: string;
  timedOut: boolean;
  /** 启动后在限定时间内没有任何输出。 */
  startupTimedOut: boolean;
}

export interface AgentOutput {
  /** 最终答复。 */
  text: string;
  /** 工具自己报告本次运行出错。 */
  isError?: boolean;
  costUsd?: number;
  usage?: unknown;
  /** 这次运行所在的会话号，下一次续接时原样传回 InvokeRequest.resume。 */
  sessionId?: string;
}

export type Classification = { outcome: 'ok' } | { outcome: FailureKind; reason: string };

export interface ModelChoice {
  id: string;
  resolved?: string;
  label?: string;
  efforts?: string[];
}

export interface AgentPlugin {
  /** 支持的强度，从低到高。型号可以另给自己的档位。 */
  efforts?: string[];
  models?: ModelChoice[];
  modelsQuery?: { args: string[]; stdin?: string; parse(stdout: string): ModelChoice[] };
  apiVersion: typeof PLUGIN_API_VERSION;
  /** 插件标识，小写字母、数字、连字符。 */
  id: string;
  displayName: string;
  /** 默认的可执行文件名，用户可在 agents.yaml 里用 command 覆盖。 */
  defaultCommand: string;
  /** 查询版本用的参数，默认 ['--version']。 */
  versionArgs?: string[];
  /** 运行开始后是否很快就有输出。为 true 时才启用"启动后无输出即判不可用"。 */
  streams: boolean;
  /**
   * 是否支持续接会话。为 true 时 build 要处理 req.resume，parse 要返回 sessionId。
   * 读写权限仍然每次按 req.access 给出，不能沿用会话上一轮的权限。
   */
  resumes?: boolean;
  /** 该工具需要的环境变量名，支持以 * 结尾的前缀写法。 */
  envPass?: string[];
  /** 仅在任务附图时追加到默认清单；用户自定清单仍优先。 */
  imageTools?: string[];
  defaultAllowedTools?: { readOnly: string[]; write: string[] };
  build(req: InvokeRequest): Invocation;
  parse(raw: RawResult): AgentOutput;
  /** 把一行标准输出翻译成零到多条活动。只用于显示，不参与任何判断。可选。 */
  progress?(line: string): Activity[] | undefined;
  /**
   * 可选：统计 token 用量。每次运行调用一次，返回的函数逐行接收标准输出，
   * 用量有变化时返回到目前为止的累计值，否则返回 undefined。只用于显示和记录，不参与任何判断。
   */
  meter?(): (line: string) => TokenUsage | undefined;
  /** 每次运行创建一次，只采集工具自己报告的额度。 */
  quota?(): QuotaReader;
  /** 可选：自行判断失败类别。返回 undefined 时使用 Dario 的默认判断。 */
  classify?(raw: RawResult, output: AgentOutput): Classification | undefined;
}

export function defineAgent(plugin: AgentPlugin): AgentPlugin {
  return plugin;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function quotaReset(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number') return undefined;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function claudeQuotaReader(): QuotaReader {
  return {
    onLine(line) {
      if (!line.includes('"rate_limit_event"')) return undefined;
      const record = jsonRecord(line);
      if (record?.type !== 'rate_limit_event') return undefined;
      const info = object(record.rate_limit_info);
      if (!info) return undefined;
      const primary = info.rateLimitType;
      const entries = object(info.unifiedWindows) ?? (typeof primary === 'string' ? { [primary]: info } : {});
      const windows: QuotaWindow[] = [];
      for (const [id, value] of Object.entries(entries)) {
        const data = object(value);
        if (typeof data?.utilization !== 'number' || !Number.isFinite(data.utilization * 100)) continue;
        const windowMinutes = id === 'five_hour' ? 300 : id.startsWith('seven_day') ? 10080 : undefined;
        const resetsAt = quotaReset(data.resetsAt);
        windows.push({
          id, usedPercent: Number((data.utilization * 100).toPrecision(15)),
          ...(windowMinutes && { windowMinutes }), ...(resetsAt && { resetsAt }), ...(id === primary && { primary: true }),
        });
      }
      return windows.length ? windows : undefined;
    },
  };
}

function codexWindows(limits: Record<string, unknown>): QuotaWindow[] | undefined {
  const windows: QuotaWindow[] = [];
  for (const id of ['primary', 'secondary']) {
    const data = object(limits[id]);
    if (typeof data?.used_percent !== 'number' || !Number.isFinite(data.used_percent)) continue;
    const resetsAt = quotaReset(data.resets_at);
    windows.push({
      id, usedPercent: data.used_percent,
      ...(typeof data.window_minutes === 'number' && { windowMinutes: data.window_minutes }),
      ...(resetsAt && { resetsAt }), ...(id === 'primary' && { primary: true }),
    });
  }
  return windows.length ? windows : undefined;
}

export function codexQuotaReader(): QuotaReader {
  return {
    async afterRun({ sessionId, env }) {
      if (!sessionId) return undefined;
      const root = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
      try {
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        const file = entries.find(e => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(`-${sessionId}.jsonl`));
        if (!file) return undefined;
        const handle = await open(path.join(file.parentPath, file.name), 'r');
        let windows: QuotaWindow[] | undefined;
        try {
          for await (const line of handle.readLines()) {
            if (!line.includes('"rate_limits"')) continue;
            const record = jsonRecord(line);
            const payload = object(record?.payload);
            if (record?.type !== 'event_msg' || !payload || !Object.hasOwn(payload, 'rate_limits')) continue;
            const limits = object(payload.rate_limits);
            windows = limits ? codexWindows(limits) : undefined;
          }
        } finally {
          await handle.close();
        }
        return windows;
      } catch {
        return undefined;
      }
    },
  };
}

function toolActivity(name: string, input: Record<string, unknown>): Activity {
  let kind: 'read' | 'edit' | 'run' | 'search';
  let target: unknown;
  switch (name) {
    case 'Read':
      kind = 'read';
      target = input.file_path;
      break;
    case 'Grep':
    case 'Glob':
      kind = 'search';
      target = input.pattern;
      break;
    case 'Bash':
    case 'PowerShell':
      kind = 'run';
      target = input.command;
      break;
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      kind = 'edit';
      target = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
      break;
    default:
      return { kind: 'tool', target: name };
  }
  return typeof target === 'string' ? { kind, target } : { kind: 'tool', target: name };
}

/** 提取 Claude Code 和 CodeBuddy 的助手活动，保留内容块的顺序。 */
export function streamJsonActivities(line: string): Activity[] {
  // 分段输出的行占绝大多数，不含活动，不必解析
  if (line.startsWith('{"type":"stream_event"')) return [];
  const record = jsonRecord(line);
  if (record?.type === 'system' && record.subtype === 'compact_boundary') {
    // 会话历史超过工具自己的上限，被它压缩成摘要
    const meta = object(record.compact_metadata);
    const size = typeof meta?.pre_tokens === 'number' && typeof meta.post_tokens === 'number' ? `（${meta.pre_tokens} → ${meta.post_tokens} token）` : '';
    return [{ kind: 'say', text: `会话历史已压缩${size}` }];
  }
  if (record?.type !== 'assistant') return [];
  const blocks = object(record.message)?.content;
  if (!Array.isArray(blocks)) return [];
  const activities: Activity[] = [];
  for (const value of blocks) {
    const block = object(value);
    if (block?.type === 'thinking') activities.push({ kind: 'think' });
    else if (block?.type === 'text' && typeof block.text === 'string') activities.push({ kind: 'say', text: block.text });
    else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      activities.push(toolActivity(block.name, object(block.input) ?? {}));
    }
  }
  return activities;
}

/**
 * 统计 Claude Code 风格 stream-json 输出里主对话的 token 用量，按消息累加，运行中随时可读。
 * 加了 --include-partial-messages 时每条消息结束都有准确的数；最后以 result 记录为准。
 * inputIncludesCache：工具报的 input_tokens 是否已经包含命中缓存的部分（Claude Code 不含，CodeBuddy 含）。
 */
export function streamJsonMeter(opts: { inputIncludesCache: boolean }): (line: string) => TokenUsage | undefined {
  const read = (value: unknown): TokenUsage | undefined => {
    const u = object(value);
    if (!u) return undefined;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const cached = n(u.cache_read_input_tokens);
    const input = opts.inputIncludesCache ? n(u.input_tokens) : n(u.input_tokens) + n(u.cache_creation_input_tokens) + cached;
    return { input, cachedInput: cached, output: n(u.output_tokens) };
  };
  // 一次运行可能有多条 result（后台命令结束的通知会引出新一轮回答），每条只统计上一条之后的那一段。
  // settled 是已有 result 结算过的各段之和；messages 只放最后一条 result 之后的消息
  const messages = new Map<string, TokenUsage>();
  const settled: TokenUsage = { input: 0, cachedInput: 0, output: 0 };
  let settledRequests = 0;
  let firstId: string | undefined;
  let firstInput = 0;
  let current: string | undefined;
  let reported = '';

  return (line) => {
    // 分段输出的行很多，绝大多数不带用量，先用字符串判断挡掉
    if (!line.includes('"usage"')) return undefined;
    const record = jsonRecord(line);
    if (!record) return undefined;
    if (record.type === 'result') {
      // 这一段以 result 记录为准；记录里没有用量时按已收到的消息结算
      const segment = read(record.usage) ?? [...messages.values()].reduce(
        (sum, m) => ({ input: sum.input + m.input, cachedInput: sum.cachedInput + m.cachedInput, output: sum.output + m.output }),
        { input: 0, cachedInput: 0, output: 0 },
      );
      settled.input += segment.input;
      settled.cachedInput += segment.cachedInput;
      settled.output += segment.output;
      settledRequests += messages.size;
      messages.clear();
    }
    // 子代理的消息不计入，与 result 记录的口径一致
    else if (record.parent_tool_use_id == null) {
      let id: string | undefined;
      let usage: TokenUsage | undefined;
      const event = object(record.event);
      const message = object(record.type === 'assistant' ? record.message : event?.message);
      if (record.type === 'assistant' || (record.type === 'stream_event' && event?.type === 'message_start')) {
        id = typeof message?.id === 'string' ? message.id : undefined;
        usage = read(message?.usage);
        if (record.type === 'stream_event') current = id;
      } else if (record.type === 'stream_event' && event?.type === 'message_delta') {
        id = typeof record.api_message_id === 'string' ? record.api_message_id : current;
        usage = read(event.usage);
      }
      if (id && usage) {
        // 同一条消息的数只增不减：开头报的输出是占位值，有的工具开头报的输入是 0
        const seen = messages.get(id);
        const merged = seen
          ? { input: Math.max(seen.input, usage.input), cachedInput: Math.max(seen.cachedInput, usage.cachedInput), output: Math.max(seen.output, usage.output) }
          : usage;
        messages.set(id, merged);
        firstId ??= id;
        if (id === firstId) firstInput = merged.input;
      }
    }
    const total: TokenUsage = { ...settled };
    for (const m of messages.values()) {
      total.input += m.input;
      total.cachedInput += m.cachedInput;
      total.output += m.output;
    }
    // 有的工具在消息开头报的全是 0，等有了真实的数再显示
    if (total.input === 0 && total.output === 0) return undefined;
    const requests = settledRequests + messages.size;
    if (requests > 0) total.requests = requests;
    if (firstInput > 0) total.firstInput = firstInput;
    // 只按 token 数去重：新消息开头报的 0 只让请求次数加一，等它报出真实用量时一起报
    const key = `${total.input}/${total.cachedInput}/${total.output}`;
    if (key === reported) return undefined;
    reported = key;
    return { ...total };
  };
}

/** Codex 只在一轮结束时报用量，而且报的是整个会话的累计值。 */
export function codexMeter(): (line: string) => TokenUsage | undefined {
  return (line) => {
    if (!line.includes('"turn.completed"')) return undefined;
    const record = jsonRecord(line);
    const usage = record?.type === 'turn.completed' ? object(record.usage) : undefined;
    if (!usage) return undefined;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return { input: n(usage.input_tokens), cachedInput: n(usage.cached_input_tokens), output: n(usage.output_tokens), sessionTotal: true };
  };
}

/** 去掉已知外壳的启动参数，未识别的命令完整保留。 */
function innerCommand(command: string): string {
  const parts = /^(?:"([^"]+)"|'([^']+)'|([^\s'"]+))\s+(.+)$/s.exec(command);
  if (!parts) return command;
  const program = (parts[1] ?? parts[2] ?? parts[3]!).split(/[\\/]/).at(-1)!.toLowerCase();
  const args = parts[4]!;
  let inner;
  if (/^(powershell|pwsh)(\.exe)?$/.test(program)) {
    inner = /^(?:-(?!command\b)[\w-]+\s+)*-command\s+(["'])(.*)\1$/is.exec(args);
  } else if (program === 'bash' || program === 'sh') {
    inner = /^-(?:lc|c)\s+(["'])(.*)\1$/s.exec(args);
  } else if (/^cmd(\.exe)?$/.test(program)) {
    inner = /^(?:\/[ds]\s+)*\/c\s+(["'])(.*)\1$/is.exec(args);
  }
  return inner?.[2] ?? command;
}

/** 提取 Codex 的活动，工具只在开始时报告一次。 */
export function codexActivities(line: string): Activity[] {
  const record = jsonRecord(line);
  if (record?.type !== 'item.started' && record?.type !== 'item.completed') return [];
  const item = object(record.item);
  if (!item) return [];
  if (item.type === 'reasoning') return [{ kind: 'think' }];
  if (record.type === 'item.completed') {
    return item.type === 'agent_message' && typeof item.text === 'string' ? [{ kind: 'say', text: item.text }] : [];
  }
  if (item.type === 'command_execution' && typeof item.command === 'string') {
    // 外壳的包装对读的人没有信息量，纯文本和动态界面都只显示内层命令；原始命令在任务目录的原始输出里
    return [{ kind: 'run', target: innerCommand(item.command) }];
  }
  if (item.type === 'mcp_tool_call' && typeof item.server === 'string' && typeof item.tool === 'string') {
    return [{ kind: 'tool', target: `${item.server}.${item.tool}` }];
  }
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    return item.changes.flatMap((change) => {
      const target = object(change)?.path;
      return typeof target === 'string' ? [{ kind: 'edit', target }] : [];
    });
  }
  return [];
}

/** 把逐行 JSON 的输出解析成对象数组，忽略不是 JSON 的行。 */
export function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const v: unknown = JSON.parse(s);
      if (v && typeof v === 'object') out.push(v as Record<string, unknown>);
    } catch {
      // 非 JSON 行直接跳过
    }
  }
  return out;
}

/**
 * 这一次运行的费用。续接会话时 total_cost_usd 是整个会话到目前为止的累计值，
 * 所以优先用只统计本次运行的 model_usage_since_last_result；没有这个字段的工具或旧版本退回 total_cost_usd。
 */
function runCostUsd(result: Record<string, unknown>): number | undefined {
  const since = object(result.model_usage_since_last_result);
  if (since) {
    let sum = 0;
    for (const usage of Object.values(since)) {
      const cost = object(usage)?.costUSD;
      if (typeof cost === 'number') sum += cost;
    }
    return sum;
  }
  return typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined;
}

/**
 * 解析 Claude Code 风格的 stream-json 输出：答复取最后一条 type 为 result 的记录。
 * Claude Code 与 CodeBuddy 都使用这种格式。
 * 一次运行可能有多条 result：AI 先答一次，后台命令结束的通知又引出一轮新的回答。
 * 每条只统计它自己那一段，所以费用要把各段加起来；没有分段字段时 total_cost_usd 是累计值，取最后一条。
 */
export function parseStreamJsonResult(stdout: string): AgentOutput {
  const results = parseJsonLines(stdout).filter((e) => e.type === 'result');
  const e = results.at(-1);
  if (e) {
    const segmented = results.every((r) => object(r.model_usage_since_last_result));
    const costUsd = segmented ? results.reduce((sum, r) => sum + runCostUsd(r)!, 0) : runCostUsd(e);
    return {
      text: typeof e.result === 'string' ? e.result : '',
      isError: e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success'),
      costUsd,
      usage: e.usage,
      sessionId: typeof e.session_id === 'string' && e.session_id ? e.session_id : undefined,
    };
  }
  // 没有 result 记录：多半是启动阶段就报错了，把非 JSON 的输出当作报错文字保留下来
  const plain = stdout
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('{'))
    .join('\n')
    .trim();
  return { text: plain.slice(-2000), isError: true };
}

const UNAVAILABLE_RE = new RegExp(
  [
    'not logged in',
    'please (?:run .{0,40})?log ?in',
    'login required',
    'unauthori[sz]ed',
    'authentication (?:failed|error|required)',
    'invalid (?:api[ _-]?key|x-api-key|credentials?|token)',
    'api key (?:is )?(?:missing|not (?:set|found)|invalid)',
    'expired (?:token|credentials?|session)',
    '(?:token|credentials?|session) (?:has )?expired',
    'rate[ _-]?limit',
    'too many requests',
    'quota (?:exceeded|exhausted|reached|limit)',
    '(?:exceeded|out of|over) (?:your |the )?(?:current )?quota',
    'insufficient_quota',
    'usage limit',
    // 各家订阅的限额提示：按时段（会话、5 小时、每天、每周）计，通常带着什么时候恢复
    "(?:hit|reached|exceeded) (?:your |the )?(?:(?:usage|session|weekly|daily|monthly|hourly|[\\d.]+[- ]?hour|messages?|requests?|plan|subscription|spending|account) ){0,2}limit\\b",
    '(?:usage|session|weekly|daily|monthly|hourly|[\\d.]+[- ]?hour) limit (?:reached|exceeded|hit)',
    '\\blimit\\b.{0,40}\\bresets?\\b',
    'credit balance',
    'insufficient (?:credit|balance|quota|funds)',
    'billing (?:hard )?limit',
    'payment required',
    'overloaded',
    'service (?:is )?(?:temporarily )?unavailable',
    'bad gateway',
    'gateway time-?out',
    // 状态码必须带上下文，避免把报错里的行号（如 file.ts:429）当成状态码
    '(?:status(?: code)?|http(?:/[\\d.]+)?|error(?: code)?|code)[ :=]+\\(?(?:401|402|429|502|503|504|529)\\b',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'network (?:error|is unreachable)',
    'connection (?:error|refused|reset|timed out)',
    'fetch failed',
    'is not recognized as an internal or external command',
    'command not found',
    '未登录',
    '请先登录',
    '登录(?:已)?(?:过期|失效)',
    '额度(?:已)?(?:用尽|用完|不足|耗尽)',
    '(?:次数|配额|用量)(?:已)?(?:用尽|用完|不足|超限)',
    '(?:已)?达到?(?:使用|用量|调用|请求|次数)?上限',
    '请求(?:过于|太)频繁',
    '余额不足',
    '服务(?:繁忙|不可用|过载)',
    '网络(?:错误|异常|不可用)',
  ].join('|'),
  'i',
);

/** 判断一段报错文字是否像"这家 AI 当前用不了"（登录、额度、过载、网络）。 */
export function looksUnavailable(text: string): boolean {
  return UNAVAILABLE_RE.test(text);
}

const SESSION_LOST_RE = new RegExp(
  [
    // Claude Code、CodeBuddy
    'no conversation found',
    // Codex
    'no rollout found',
    '(?:session|conversation|thread|rollout)\\b.{0,80}\\b(?:not found|does not exist|no longer exists|could not be found)',
    '(?:找不到|没有找到)(?:该|这个)?(?:会话|对话)',
    '(?:会话|对话)(?:不存在|已失效|已过期)',
  ].join('|'),
  'i',
);

/** 判断一段报错文字是否像"要续接的会话已经不在了"。只在续接失败时使用。 */
export function looksSessionLost(text: string): boolean {
  return SESSION_LOST_RE.test(text);
}

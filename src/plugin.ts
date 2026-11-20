/**
 * Dario 插件接口：接入一家 AI 命令行工具所需实现的全部内容。
 *
 * 插件只描述"怎么调用、怎么读结果"，不自己启动进程。进程的启动、超时、
 * 进程树终止、环境变量名单与换人都由 Dario 统一负责。
 */

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

export interface InvokeRequest {
  access: Access;
  /** AI 的工作目录（绝对路径）。 */
  cwd: string;
  /** 完整的任务说明。 */
  prompt: string;
  model?: string;
  /** 本次放行的工具清单；不支持该概念的工具忽略即可。 */
  allowedTools: string[];
  /** 可供 AI 写入最终答复的文件路径（位于任务目录内，调用前不存在）。 */
  resultFile: string;
  /** 用户在 agents.yaml 的 options 里给这个 AI 写的自由配置。 */
  options: Record<string, unknown>;
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
}

export type Classification = { outcome: 'ok' } | { outcome: FailureKind; reason: string };

export interface AgentPlugin {
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
  /** 该工具需要的环境变量名，支持以 * 结尾的前缀写法。 */
  envPass?: string[];
  defaultAllowedTools?: { readOnly: string[]; write: string[] };
  build(req: InvokeRequest): Invocation;
  parse(raw: RawResult): AgentOutput;
  /** 把一行标准输出翻译成零到多条活动。只用于显示，不参与任何判断。可选。 */
  progress?(line: string): Activity[] | undefined;
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
  const record = jsonRecord(line);
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
 * 解析 Claude Code 风格的 stream-json 输出：取最后一条 type 为 result 的记录。
 * Claude Code 与 CodeBuddy 都使用这种格式。
 */
export function parseStreamJsonResult(stdout: string): AgentOutput {
  const events = parseJsonLines(stdout);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'result') continue;
    return {
      text: typeof e.result === 'string' ? e.result : '',
      isError: e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success'),
      costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined,
      usage: e.usage,
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
    '额度(?:已)?(?:用尽|不足|耗尽)',
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

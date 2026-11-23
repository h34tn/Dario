/**
 * 核心对外的两个接口：AI 目录与渠道。核心只依赖这里的类型，
 * 具体的适配器和渠道在核心之外实现并注入。
 */
import type { Access, Activity, FailureKind, ModelChoice, QuotaWindow, TokenUsage } from '../plugin.js';
import type { ModelSettings } from './config.js';

export interface AgentDetect {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface AgentRunRequest extends ModelSettings {
  access: Access;
  cwd: string;
  prompt: string;
  images?: string[];
  timeoutMs: number;
  /** 存放本次运行原始输出的目录。 */
  workDir: string;
  /** 原始输出文件名的前缀，如 step-2-codex。 */
  label: string;
  /** AI 子进程启动和结束时回调，结束时传 undefined。 */
  onPid?: (pid: number | undefined) => void;
  onActivity?: (activity: Activity) => void;
  onQuota?: (windows: QuotaWindow[]) => void;
  /** token 用量有变化时回调，给出这一次运行到目前为止的累计值。 */
  onUsage?: (usage: TokenUsage) => void;
  /** 工具每输出一行就回调一次，不论这一行是否能认出活动。用来判断它还有没有动静。 */
  onLine?: () => void;
  /** 触发时终止这次运行，结果为 task_failed，原因取 signal.reason。 */
  signal?: AbortSignal;
  /** 要续接的会话号。只对 resumes 为 true 的 AI 有效，此时 prompt 是这一轮的增量说明。 */
  resume?: string;
  /** 这一次运行另外设置的环境变量（例如收尾时临时禁用推送的 git 配置）。 */
  env?: Record<string, string>;
}

export interface AgentRunResult {
  outcome: 'ok' | FailureKind;
  text: string;
  reason?: string;
  durationMs: number;
  /** 从启动工具到它输出第一行的时间；工具不逐行输出时为空。 */
  startupMs?: number;
  costUsd?: number;
  /** 这次运行最终的 token 用量；工具不报用量时为空。 */
  tokens?: TokenUsage;
  quota?: QuotaWindow[];
  /** 这次运行所在的会话号，可用于下一次续接。 */
  sessionId?: string;
  /** 续接失败，且原因是会话已经不在了。调用方应当不带 resume、用完整的任务说明重跑。 */
  sessionLost?: boolean;
  /** 实际启动的命令与参数，写入审计日志。任务说明走标准输入，不在其中。 */
  command?: string[];
}

export function findModel<T extends ModelChoice>(models: T[], model?: string): T | undefined {
  if (!model) return undefined;
  return models.find(m => m.id === model) ?? models.find(m => m.resolved === model);
}

export interface ModelList {
  models: ModelChoice[];
  error?: string;
}

export interface AgentPort {
  id: string;
  displayName: string;
  pluginId: string;
  enabled: boolean;
  free: boolean;
  /** 是否支持续接会话。 */
  resumes: boolean;
  model?: string;
  effort?: string;
  roles?: Record<string, ModelSettings>;
  efforts?: string[];
  listModels(): Promise<ModelList>;
  /** 该 AI 自己的时限，优先于角色和项目的时限。 */
  timeoutMinutes?: number;
  /** 运行中是否逐行输出。不逐行输出的工具到结束才有输出，无法判断它有没有动静。 */
  streams?: boolean;
  /** 判断"没动静"时阈值乘以这个数，本机 agents.yaml 的 idle_factor，默认 1。 */
  idleFactor?: number;
  detect(): Promise<AgentDetect>;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}

export interface AgentCatalog {
  get(id: string): AgentPort | undefined;
  list(): AgentPort[];
}

export interface InboundMessage {
  channel: string;
  /** 渠道内唯一的消息编号，用于去重。 */
  messageId: string;
  /** 会话（群、私聊）的编号。 */
  conversation: string;
  /** 话题的标识：同一话题下的消息相同。 */
  threadKey: string;
  senderId: string;
  senderName?: string;
  text: string;
  /** 是否为私聊。 */
  isDirect: boolean;
}

export interface ChannelPort {
  id: string;
  /** 开始接收消息。onMessage 必须很快返回，实际处理在后台进行。 */
  start(onMessage: (message: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  /** 回复到某条消息所在的话题。key 用于幂等，同一个 key 只发一次。 */
  reply(to: { conversation: string; messageId: string }, text: string, key: string): Promise<void>;
}

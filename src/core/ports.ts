/**
 * 核心对外的两个接口：AI 目录与渠道。核心只依赖这里的类型，
 * 具体的适配器和渠道在核心之外实现并注入。
 */
import type { Access, FailureKind } from '../plugin.js';

export interface AgentDetect {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface AgentRunRequest {
  access: Access;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  /** 存放本次运行原始输出的目录。 */
  workDir: string;
  /** 原始输出文件名的前缀，如 step-2-codex。 */
  label: string;
  /** AI 子进程启动和结束时回调，结束时传 undefined。 */
  onPid?: (pid: number | undefined) => void;
}

export interface AgentRunResult {
  outcome: 'ok' | FailureKind;
  text: string;
  reason?: string;
  durationMs: number;
  costUsd?: number;
  /** 实际启动的命令与参数，写入审计日志。任务说明走标准输入，不在其中。 */
  command?: string[];
}

export interface AgentPort {
  id: string;
  displayName: string;
  pluginId: string;
  enabled: boolean;
  model?: string;
  /** 该 AI 自己的时限，优先于角色和项目的时限。 */
  timeoutMinutes?: number;
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

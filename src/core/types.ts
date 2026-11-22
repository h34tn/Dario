import type { Access, Activity, FailureKind, QuotaWindow } from '../plugin.js';
import type { Alert } from './watch.js';

export type { Access, FailureKind };

export type JobStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'interrupted'
  | 'out_of_scope';

/** 有进程正在推进的状态。 */
export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'planning', 'running', 'reviewing'];

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排队',
  planning: '计划中',
  awaiting_approval: '等待确认',
  running: '执行中',
  reviewing: '审查中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时',
  interrupted: '中断',
  out_of_scope: '越界',
};

export type Strategy = 'in-place' | 'isolated';

export interface Origin {
  /** 渠道标识，如 terminal、feishu。 */
  channel: string;
  conversation?: string;
  threadKey?: string;
  messageId?: string;
  senderId: string;
  senderName?: string;
}

export interface Attempt {
  agent: string;
  outcome: 'ok' | FailureKind | 'skipped';
  reason?: string;
  durationMs?: number;
}

export type StepKind = 'plan' | 'step' | 'review' | 'rework' | 'summary';

export type StepOutcome = 'ok' | FailureKind | 'all_unavailable';

export interface StepRecord {
  index: number;
  kind: StepKind;
  role: string;
  access: Access;
  /** 实际完成这一步的 AI；全部不可用时为空。 */
  agent?: string;
  outcome: StepOutcome;
  reason?: string;
  attempts: Attempt[];
  durationMs: number;
  text: string;
  changedFiles: string[];
  costUsd?: number;
  /** 交给该角色的任务说明（不含 Dario 附加的前言）。 */
  task?: string;
  /** 这一步续接了该角色在本任务里已有的会话，收到的是增量说明。 */
  resumed?: boolean;
  /** 这一步的 token 用量；工具不报用量时为空。 */
  tokens?: StepTokens;
  /** 从启动工具到它输出第一行的时间，即进程启动、加载插件与 MCP 的开销；不可知时为空。 */
  startupMs?: number;
  /** Dario 交给工具的任务说明有多少字（续接时是增量说明）。 */
  promptChars?: number;
  /** 这一步运行中监控发现的问题；没有时为空。 */
  alerts?: Alert[];
}

/** 一步的 token 用量。input 是各次请求发给模型的 token 之和，其中 cachedInput 是命中缓存的部分。 */
export interface StepTokens {
  input: number;
  cachedInput: number;
  output: number;
  /** 向模型发了几次请求；工具不报时为空。 */
  requests?: number;
  /** 第一次请求的输入 token，即起这一步要付的固定开销；工具不报时为空。 */
  firstInput?: number;
}

/** 一个角色在本任务里的 AI 会话。担当者换了，会话就不能再续。 */
export interface RoleSession {
  agent: string;
  sessionId: string;
  /**
   * 最近一次用到这个会话的步骤下标：这之后发生的事，会话里还不知道。
   * -1 表示会话是从同一次交互的上一个任务带过来的，在本任务里还没有上过场，连本任务是什么都不知道。
   */
  step: number;
  /** 工具只报会话累计用量时，记下上一轮结束时的累计值，下一轮减去它才是那一步的用量。 */
  tokens?: StepTokens;
  /**
   * 这个会话已经收到过的固定说明（角色、工作规则、项目约定、输出格式等）的指纹。
   * 续接时指纹没变就不再重发这些内容；项目配置改了，指纹跟着变，会重发一次。
   */
  brief?: string;
  /** 这个会话最近一次做成一步所在的任务。那个任务的经过和结论它已经知道，之后不必再当作"上文"发给它。 */
  job?: string;
}

export interface PlanStep {
  role: string;
  task: string;
  writes: boolean;
  acceptance?: string;
  /** 这一步预计改动的文件、目录或 glob，相对项目根目录。只有改文件的步骤才有；是估计，不是限制。 */
  files?: string[];
}

export interface Plan {
  summary: string;
  /** 任务只是提问、不需要分派时，主控直接给出的答案。 */
  answer?: string | null;
  steps: PlanStep[];
}

export type FailureCode =
  | 'all_unavailable'
  | 'task_failed'
  | 'plan_invalid'
  | 'review_rejected'
  | 'workspace'
  | 'out_of_scope';

export interface JobResult {
  conclusion: string;
  changedFiles: string[];
  fallbackHappened: boolean;
  warnings: string[];
  /** 隔离执行时产出所在的本地分支。 */
  branch?: string;
  /** 未完成或失败部分的说明。 */
  unfinished?: string;
}

/** 开工前拉取远端时变化的文件。 */
export interface PulledUpdate {
  upstream: string;
  commits: number;
  /** 拉取之前的提交。 */
  from: string;
  /** 相对项目根目录、使用正斜杠的路径；项目根目录之外的文件不列。 */
  files: string[];
}

export interface Job {
  images?: { n: number; path: string }[];
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  mode: 'direct' | 'lead';
  task: string;
  /** 直派时指定的角色。 */
  role?: string;
  projectRoot: string;
  strategy: Strategy;
  origin: Origin;
  /** context 是哪个任务的结论。用来判断带过来的会话是否已经知道这段上文。 */
  contextJob?: string;
  /** 同一话题上一个任务的结论摘要。 */
  context?: string;
  /** 开工前从远端拉取带来的更新；没有拉取、或拉取没有带来变化时不填。 */
  pulled?: PulledUpdate;
  plan?: Plan;
  /** 计划里下一个要执行的步骤下标。 */
  cursor: number;
  steps: StepRecord[];
  reworkRounds: number;
  changedFiles: string[];
  /** 最近一次改动之后是否已经审查过。 */
  reviewedSinceChange: boolean;
  lastWriter?: { role: string; agent: string; task: string };
  /** 本任务里已经同意过的换人，写成 "原来的 AI>备选的 AI"。同一对不再重复询问。 */
  fallbackApproved?: string[];
  /** 各角色可以续接的会话，键是角色 id。每个角色最多一个。 */
  sessions?: Record<string, RoleSession>;
  /** 只读角色改动了文件。 */
  readOnlyViolation?: boolean;
  /** 目录不是 git 仓库，无法检测改动，但有可写步骤执行过。 */
  unknownChanges?: boolean;
  /** 隔离执行时的任务分支。 */
  branch?: string;
  failureCode?: FailureCode;
  warnings: string[];
  result?: JobResult;
  /** 正在推进该任务的 Dario 进程。 */
  ownerPid?: number;
  /** 正在运行的 AI 子进程。 */
  activePid?: number;
  cancelRequested?: boolean;
}

/** 角色表的 fallback 为 ask 时，换人之前问发起人的问题。 */
export interface FallbackQuestion {
  jobId: string;
  role: string;
  roleLabel: string;
  /** 不可用的那几家，按候选顺序；通常只有一家。 */
  from: Array<{ agent: string; model?: string; modelLabel?: string; effort?: string; reason: string }>;
  /** 打算改用的备选。 */
  to: { agent: string; model?: string; modelLabel?: string; effort?: string };
}

export type ProgressKind = 'accepted' | 'phase' | 'plan' | 'step_start' | 'step_end' | 'fallback' | 'finished' | 'activity' | 'usage' | 'quota' | 'watch';

export interface ProgressStepInfo {
  index: number;
  kind: StepKind;
  role: string;
  roleLabel: string;
  agent?: string;
  outcome?: StepOutcome;
  durationMs?: number;
  /** 这一步到目前为止的 token 用量。随 usage 事件更新，step_end 时是最终值。 */
  tokens?: StepTokens;
}

export interface ProgressEvent {
  jobId: string;
  kind: ProgressKind;
  quota?: { agent: string; windows: QuotaWindow[] };
  text: string;
  step?: ProgressStepInfo;
  /** 换人时，多个被放弃的 AI 用顿号连接。 */
  fallback?: { from: string; reason: string; to: string };
  activity?: Activity;
  /** watch 事件：监控发现的问题。 */
  alert?: Alert;
}

/** 无头方式的退出码，与规格第 4 节一致。 */
export function exitCodeForJob(job: Job): number {
  switch (job.status) {
    case 'done':
      return 0;
    case 'awaiting_approval':
      return 4;
    case 'cancelled':
    case 'timeout':
      return 5;
    case 'failed':
      return job.failureCode === 'all_unavailable' ? 3 : 1;
    default:
      return 1;
  }
}

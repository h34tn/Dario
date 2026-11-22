import path from 'node:path';
import { HELP_TEXT, runModel, parseCommand, requiresAdmin, type Command } from './commands.js';
import type { AccessEntry } from './config.js';
import type { Engine } from './engine.js';
import type { ChannelPort, InboundMessage } from './ports.js';
import { clip, formatModel, formatJob, formatRoles, redact } from './report.js';
import { ACTIVE_STATUSES, STATUS_LABEL, type Job, type ProgressEvent } from './types.js';
import { DarioError, ellipsis, shortHash, sleep, truncate } from './util.js';

export interface RouterOptions {
  /** 允许使用的会话。私聊不受此限制，只看发送人是否在名单里。 */
  conversations: string[];
  rateLimitPerMinute: number;
  maxQueue: number;
  /** 含改文件步骤的计划是否免确认。 */
  autoApprove: boolean;
  replyMaxChars: number;
  /** 已知的具体密钥值，回复前强制遮盖。 */
  secrets: string[];
  /** 两条回复之间的最小间隔（毫秒）。 */
  sendIntervalMs?: number;
}

type Level = 'admin' | 'member';

interface Queued {
  job: Job;
  message: InboundMessage;
  approve: boolean;
}

const YES = /^(确认|同意|批准|执行|ok|yes|y)$/i;
const NO = /^(取消|放弃|不执行|no|n)$/i;

/**
 * 把一个渠道接到引擎上：鉴权、去重、指令解析、排队、回复。
 * 与具体渠道无关，飞书和以后的其他渠道共用。
 */
export class ChannelRouter {
  private readonly queue: Queued[] = [];
  private working = false;
  private paused = false;
  private readonly recent = new Map<string, number[]>();
  private sendChain: Promise<void> = Promise.resolve();
  private pending = 0;
  private seq = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly engine: Engine,
    private readonly channel: ChannelPort,
    private readonly access: AccessEntry | undefined,
    private readonly opts: RouterOptions,
  ) {}

  async start(): Promise<void> {
    // 上次运行中被打断的任务：如实报告，不自动重跑
    for (const job of this.engine.recoverInterrupted(this.channel.id)) {
      if (job.origin.conversation && job.origin.messageId) {
        this.reply(
          { conversation: job.origin.conversation, messageId: job.origin.messageId },
          `[${job.id}] Dario 在任务执行过程中重启，任务被中断，没有自动重跑。需要的话请重新下达。`,
          job.id,
        );
      }
    }
    await this.channel.start((m) => this.onMessage(m));
  }

  async stop(): Promise<void> {
    await this.channel.stop();
  }

  /** 所有已收到的消息都处理完、回复都发出后返回（测试用）。 */
  async idle(): Promise<void> {
    while (this.pending > 0 || this.working || this.queue.length > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
    await this.sendChain;
  }

  private settle(): void {
    if (this.pending === 0 && !this.working && this.queue.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private levelOf(senderId: string): Level | undefined {
    if (this.access?.admins.includes(senderId)) return 'admin';
    if (this.access?.members.includes(senderId)) return 'member';
    return undefined;
  }

  /** 渠道的事件回调：只做鉴权、去重、登记，立即返回。 */
  onMessage(m: InboundMessage): void {
    const state = this.engine.state;
    const level = this.levelOf(m.senderId);
    const conversationOk = m.isDirect || this.opts.conversations.includes(m.conversation);
    if (!level || !conversationOk) {
      state.audit('message_rejected', {
        channel: m.channel,
        conversation: m.conversation,
        sender: m.senderId,
        message: m.messageId,
        reason: !level ? '发送人不在名单内' : '会话不在名单内',
      });
      return;
    }
    if (!state.firstSeen(m.channel, m.messageId)) {
      state.audit('message_duplicate', { channel: m.channel, message: m.messageId });
      return;
    }
    state.audit('message_accepted', { channel: m.channel, conversation: m.conversation, sender: m.senderId, message: m.messageId, level });
    this.pending++;
    // 回调必须立即返回（飞书要求 3 秒内处理完事件），实际处理放到下一轮事件循环
    void new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.handle(m, level))
      .catch((e: unknown) => {
        state.audit('handler_error', { message: m.messageId, error: String((e as Error)?.message ?? e) });
        this.reply(m, e instanceof DarioError ? e.message : `处理这条消息时出错：${(e as Error).message}`);
      })
      .finally(() => {
        this.pending--;
        this.settle();
      });
  }

  private reply(to: { conversation: string; messageId: string }, text: string, jobId?: string): void {
    const state = this.engine.state;
    const n = ++this.seq;
    const file = path.join(jobId ? state.jobDir(jobId) : path.join(state.dir, 'replies'), `reply-${Date.now()}-${n}.txt`);
    const safe = clip(redact(text, this.opts.secrets), this.opts.replyMaxChars, file);
    const key = `${shortHash(`${to.messageId}:${n}:${safe.length}`)}-${n}`.slice(0, 50);
    const gap = this.opts.sendIntervalMs ?? 250;
    this.sendChain = this.sendChain
      .then(() => this.channel.reply(to, safe, key))
      .then(() => sleep(gap))
      .catch((e: unknown) => {
        state.audit('reply_failed', { message: to.messageId, error: String((e as Error)?.message ?? e) });
      });
  }

  private async handle(m: InboundMessage, level: Level): Promise<void> {
    const state = this.engine.state;
    const text = m.text.trim();
    const threadJobId = state.getThreadJob(m.channel, m.threadKey);

    // 在等待确认的任务话题里回复"确认 / 取消"
    if (threadJobId && (YES.test(text) || NO.test(text))) {
      const job = this.engine.job(threadJobId);
      if (job.status === 'awaiting_approval' && YES.test(text)) {
        this.approve(m, level, job.id);
        return;
      }
      // 等待确认、排队或正在运行时，回复"取消"就是取消这个任务
      if (NO.test(text) && (job.status === 'awaiting_approval' || ACTIVE_STATUSES.includes(job.status))) {
        this.cancel(m, level, job.id);
        return;
      }
    }

    const cmd = parseCommand(text);
    if (requiresAdmin(cmd) && level !== 'admin') {
      state.audit('command_denied', { sender: m.senderId, command: cmd.kind });
      this.reply(m, '这个操作需要管理员权限。');
      return;
    }
    await this.execute(m, level, cmd, threadJobId);
  }

  private async execute(m: InboundMessage, level: Level, cmd: Command, threadJobId: string | undefined): Promise<void> {
    switch (cmd.kind) {
      case 'invalid':
        this.reply(m, cmd.message);
        return;
      case 'help':
        this.reply(m, HELP_TEXT);
        return;
      case 'roles':
        this.reply(m, formatRoles(await this.engine.rolesView(), this.engine.roles.fallback, this.engine.roles.modelLabel));
        return;
      case 'agents': {
        const lines = (await this.engine.agentsView()).map((a) => {
          const st = !a.enabled ? '已停用' : !a.installed ? '未安装' : a.unavailable ? `暂时不可用（${a.unavailable}）` : '可用';
          return `${a.id}${a.model || a.effort ? `（${formatModel(a.id, a.model, a.effort, this.engine.roles.modelLabel)}）` : ''}：${st}`;
        });
        this.reply(m, lines.join('\n'));
        return;
      }
      case 'pause':
        this.paused = true;
        this.reply(m, '已暂停接收新任务。排队中和运行中的任务不受影响。');
        return;
      case 'resume':
        this.paused = false;
        this.reply(m, '已恢复接收新任务。');
        return;
      case 'model':
        this.reply(m, await runModel(this.engine, cmd));
        return;
      case 'role':
        this.reply(m, cmd.reset ? this.engine.resetRole(cmd.role) : this.engine.setRole(cmd.role, cmd.agent!, cmd.save));
        return;
      case 'health': {
        this.reply(m, '正在检查，稍候。');
        const results = await this.engine.health(cmd.agent);
        this.reply(m, results.map((r) => `${r.agent}：${r.ok ? '可用' : '不可用'} — ${r.detail}`).join('\n'));
        return;
      }
      case 'status': {
        if (cmd.jobId) {
          const job = this.engine.job(cmd.jobId);
          this.reply(m, formatJob(job), job.id);
          return;
        }
        const jobs = this.engine.jobs(30).filter((j) => j.origin.channel === this.channel.id);
        const live = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status) || j.status === 'awaiting_approval');
        const list = (live.length ? live : jobs.slice(0, 5)).map(
          (j) => `${j.id} ${STATUS_LABEL[j.status]} · ${ellipsis(j.task, 40)}`,
        );
        this.reply(m, list.length ? `${live.length ? '进行中的任务' : '最近的任务'}：\n${list.join('\n')}` : '还没有任务。');
        return;
      }
      case 'approve': {
        const id = cmd.jobId ?? threadJobId;
        if (!id) {
          this.reply(m, '请写明任务号，例如 /approve J0001。');
          return;
        }
        this.approve(m, level, id);
        return;
      }
      case 'cancel': {
        const id = cmd.jobId ?? threadJobId;
        if (!id) {
          this.reply(m, '请写明任务号，例如 /cancel J0001。');
          return;
        }
        this.cancel(m, level, id);
        return;
      }
      case 'task':
        this.accept(m, cmd, threadJobId);
        return;
    }
  }

  private mayManage(m: InboundMessage, level: Level, job: Job): boolean {
    return level === 'admin' || job.origin.senderId === m.senderId;
  }

  private approve(m: InboundMessage, level: Level, jobId: string): void {
    const job = this.engine.job(jobId);
    if (job.status !== 'awaiting_approval') {
      this.reply(m, `[${job.id}] 当前是"${STATUS_LABEL[job.status]}"状态，不在等待确认。`, job.id);
      return;
    }
    if (!this.mayManage(m, level, job)) {
      this.reply(m, `[${job.id}] 只有发起人或管理员可以批准。`, job.id);
      return;
    }
    if (this.queue.some((q) => q.job.id === job.id)) return;
    this.reply(m, `[${job.id}] 已确认，开始执行。`, job.id);
    this.enqueue({ job, message: m, approve: true });
  }

  private cancel(m: InboundMessage, level: Level, jobId: string): void {
    const job = this.engine.job(jobId);
    if (!this.mayManage(m, level, job)) {
      this.reply(m, `[${job.id}] 只有发起人或管理员可以取消。`, job.id);
      return;
    }
    const queuedAt = this.queue.findIndex((q) => q.job.id === job.id);
    if (queuedAt >= 0) this.queue.splice(queuedAt, 1);
    const after = this.engine.cancel(job.id);
    this.reply(m, after.status === 'cancelled' ? `[${job.id}] 已取消。` : `[${job.id}] 正在终止，稍后会给出结果。`, job.id);
  }

  private accept(m: InboundMessage, cmd: Extract<Command, { kind: 'task' }>, threadJobId: string | undefined): void {
    const state = this.engine.state;
    if (this.paused) {
      this.reply(m, '当前已暂停接收新任务。');
      return;
    }
    const now = Date.now();
    const times = (this.recent.get(m.senderId) ?? []).filter((t) => now - t < 60000);
    if (times.length >= this.opts.rateLimitPerMinute) {
      state.audit('rate_limited', { sender: m.senderId });
      this.reply(m, `下达得太快了：每人每分钟最多 ${this.opts.rateLimitPerMinute} 个任务，请稍后再试。`);
      return;
    }
    if (this.queue.length >= this.opts.maxQueue) {
      this.reply(m, `排队的任务已满（${this.opts.maxQueue} 个），请等前面的任务完成。`);
      return;
    }

    // 同一话题里的后续任务，带上上一个任务的结论
    let context: string | undefined;
    if (threadJobId) {
      const prev = state.loadJob(threadJobId);
      if (prev?.result?.conclusion) context = `同一话题里上一个任务（${prev.id}）的结论：\n${truncate(prev.result.conclusion, 3000)}`;
    }

    const job = this.engine.create({
      task: cmd.text,
      role: cmd.role,
      context,
      origin: {
        channel: m.channel,
        conversation: m.conversation,
        threadKey: m.threadKey,
        messageId: m.messageId,
        senderId: m.senderId,
        senderName: m.senderName,
      },
    });
    times.push(now);
    this.recent.set(m.senderId, times);
    state.setThreadJob(m.channel, m.threadKey, job.id);

    const ahead = this.queue.length + (this.working ? 1 : 0);
    const target = job.mode === 'direct' ? `交给${this.engine.roles.label(job.role!)}` : '交给主控安排';
    this.reply(m, `[${job.id}] 已接收，${target}${ahead > 0 ? `。前面还有 ${ahead} 个任务` : ''}。`, job.id);
    this.enqueue({ job, message: m, approve: false });
  }

  private enqueue(item: Queued): void {
    this.queue.push(item);
    void this.work();
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        await this.runOne(item);
      }
    } finally {
      this.working = false;
      this.settle();
    }
  }

  private async runOne(item: Queued): Promise<void> {
    const { job, message } = item;
    const state = this.engine.state;
    const forward = (e: ProgressEvent): void => {
      if (e.jobId !== job.id) return;
      if (e.kind === 'plan') this.reply(message, `[${job.id}] 计划：\n${e.text}`, job.id);
      else if (e.kind === 'step_start' || e.kind === 'step_end' || e.kind === 'fallback' || e.kind === 'watch') this.reply(message, `[${job.id}] ${e.text}`, job.id);
    };
    const off = this.engine.onProgress(forward);
    try {
      const done = item.approve
        ? await this.engine.approve(job.id)
        : await this.engine.advance(job, { autoApprove: this.opts.autoApprove });
      if (done.status === 'awaiting_approval') {
        this.reply(message, `[${done.id}] 这份计划会改动文件。在本话题回复"确认"开始执行，回复"取消"放弃。`, done.id);
      } else {
        this.reply(message, formatJob(done), done.id);
      }
    } catch (e) {
      state.audit('job_error', { job: job.id, error: String((e as Error)?.message ?? e) });
      this.reply(message, `[${job.id}] 执行出错：${(e as Error).message}`, job.id);
    } finally {
      off();
    }
  }
}

import os from 'node:os';
import path from 'node:path';
import { HELP_TEXT, parseCommand, type Command } from '../core/commands.js';
import type { Engine } from '../core/engine.js';
import { formatJob, formatRoles } from '../core/report.js';
import { STATUS_LABEL, type Job, type Plan } from '../core/types.js';
import { DarioError, ellipsis } from '../core/util.js';
import type { CompletionContext } from './completion.js';
import { colorizeDiff, readDiff } from './diff.js';
import { EMPTY_FEED, markStopping, reduceFeed, shortRole, type FeedState, type StepView } from './feed.js';
import { formatConclusion } from './markdown.js';
import { paint } from './theme.js';

type TextKind = 'banner' | 'input' | 'title' | 'notice' | 'error' | 'text';
export type HistoryItem = { [K in TextKind]: { id: number; type: K; text: string } }[TextKind]
  | { id: number; type: 'step'; step: StepView };

export interface StatusView {
  project: string;
  roles: Array<{ label: string; holder?: string; model?: string; degraded: boolean; priority: boolean }>;
}

export interface SessionSnapshot {
  history: HistoryItem[];
  feed: FeedState;
  runningJobId?: string;
  queued: number;
  plan?: Plan;
  contextJobId?: string;
  status: StatusView;
  exiting?: 'exit' | 'plain';
}

export interface SessionOptions {
  engine: Engine;
  color: boolean;
  senderId?: string;
  now?: () => number;
  readDiff?: typeof readDiff;
}

type Work = Extract<Command, { kind: 'task' }> | { kind: 'approve'; jobId: string };

function resultCard(job: Job, color: boolean) {
  const tone = job.status === 'done' ? 'done' : job.status === 'awaiting_approval' ? 'warn' : 'fail';
  const lines = [paint(tone, `[${job.id}] ${STATUS_LABEL[job.status]}`, color)];
  const result = job.result;
  if (result?.conclusion.trim()) lines.push('', formatConclusion(result.conclusion, color));
  const files = result?.changedFiles ?? job.changedFiles;
  if (files.length) lines.push(`改动的文件（${files.length}）：`, ...files.map(file => '  ' + file));
  const branch = result?.branch ?? job.branch;
  if (branch) lines.push(`产出所在分支：${branch}`);
  const warnings = result?.warnings ?? job.warnings;
  if (warnings.length) lines.push(paint('warn', ['注意：', ...warnings.map(w => '  - ' + w)].join('\n'), color));
  return lines.join('\n') + '\n';
}

export class Session {
  private readonly engine: Engine;
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionSnapshot;
  private off?: () => void;
  private readonly queue: Work[] = [];
  private working = false;
  private readonly waiters = new Set<() => void>();
  private answer?: (approved: boolean) => void;
  private exitKind?: 'exit' | 'plain';
  private context?: string;
  private contextVersion = 0;
  private statusVersion = 0;
  private files: string[] = [];
  private completion: CompletionContext = { roles: [], agents: [] };

  constructor(private readonly opts: SessionOptions) {
    this.engine = opts.engine;
    this.snapshot = { history: [], feed: EMPTY_FEED, queued: 0, status: { project: path.basename(this.engine.project.root), roles: [] } };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  completionContext() { return this.completion; }
  roleLabel = (id: string) => this.engine.roles.label(id);

  private update(patch: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private append(type: TextKind, text: string) {
    const { history } = this.snapshot;
    this.update({ history: [...history, { id: history.length, type, text }] });
  }

  private error(error: unknown) {
    this.append('error', error instanceof DarioError ? error.message : `出错：${error instanceof Error ? error.message : String(error)}`);
  }

  async start() {
    this.append('banner', `Dario · ${this.snapshot.status.project}        输入任务直接交给主控，/ 开头是指令，/help 查看全部`);
    this.off = this.engine.onProgress(event => {
      if (event.jobId !== this.snapshot.runningJobId) return;
      const { feed, history } = this.snapshot;
      const next = reduceFeed(feed, event, (this.opts.now ?? Date.now)());
      if (next === feed) return;
      if (!next.lines.length) return this.update({ feed: next });
      const items = next.lines.map((line, i): HistoryItem => {
        const id = history.length + i;
        return line.type === 'step' ? { id, type: 'step', step: line.step } : { id, type: 'notice', text: line.text };
      });
      this.update({ history: [...history, ...items], feed: { ...next, lines: [] } });
    });
    await this.refreshStatus();
  }

  private async loadAgents(version: number) {
    try {
      const agents = await this.engine.agentsView();
      if (version === this.statusVersion) this.completion = { ...this.completion, agents: agents.map(a => a.id) };
      return new Map(agents.map(a => [a.id, a.model]));
    } catch { return undefined; }
  }

  private async refreshStatus() {
    const version = ++this.statusVersion;
    try {
      const [views, models] = await Promise.all([this.engine.rolesView(), this.loadAgents(version)]);
      const { leadRole, reviewRole } = this.engine.project.settings;
      const writer = views.find(v => v.access === 'write' && v.id !== leadRole && v.id !== reviewRole);
      const priorityIds = new Set([leadRole, writer?.id, reviewRole]);
      const roles = views.map(view => ({
        label: shortRole(this.roleLabel(view.id)), holder: view.holder, model: view.holder ? models?.get(view.holder) : undefined,
        degraded: view.candidates[0]?.state !== 'ok', priority: priorityIds.has(view.id),
      }));
      if (version !== this.statusVersion) return;
      this.completion = { ...this.completion, roles: views.map(({ id, alias }) => ({ id, alias })) };
      this.update({ status: { project: this.snapshot.status.project, roles } });
    } catch { /* 探测失败时保留上次的状态。 */ }
  }

  dispose() { this.off?.(); }

  submit(raw: string) {
    if (this.exitKind) return;
    const lines = raw.split(/\r?\n/);
    this.append('input', lines.length > 1 ? `${lines[0]}（共 ${lines.length} 行）` : raw);
    void this.execute(raw.trim()).catch(error => this.error(error));
  }

  private async execute(line: string) {
    if (line === '/exit' || line === '/quit') return this.requestExit('exit');
    if (line === '/plain') return this.requestExit('plain');
    if (line === '/new') {
      this.context = undefined;
      this.contextVersion++;
      this.update({ contextJobId: undefined });
      return this.append('notice', '已清空会话上文，下一个任务从头开始。');
    }
    if (line === '/diff') return this.showDiff();
    const cmd = parseCommand(line);
    const engine = this.engine;
    switch (cmd.kind) {
      case 'invalid': return this.append('error', cmd.message);
      case 'help': return this.append('text', [HELP_TEXT, '/diff                  查看上一个任务的改动',
        '/new                   清空会话上文', '/plain                 切换到逐行交互', '/exit                  退出'].join('\n'));
      case 'roles': return this.append('text', formatRoles(await engine.rolesView(), engine.roles.fallback));
      case 'agents':
        for (const a of await engine.agentsView()) {
          const st = !a.enabled ? '已停用' : !a.installed ? '未安装' : a.unavailable ? `暂时不可用（${a.unavailable}）` : '可用';
          this.append('text', `${a.id}${a.model ? `（${a.model}）` : ''}：${st}${a.version ? ` · ${a.version}` : ''}`);
        }
        return;
      case 'role':
        this.append('text', cmd.reset ? engine.resetRole(cmd.role) : engine.setRole(cmd.role, cmd.agent!, cmd.save));
        return this.refreshStatus();
      case 'health':
        this.append('notice', '正在检查，会实际调用一次 AI…');
        for (const r of await engine.health(cmd.agent)) this.append('text', `${r.agent}：${r.ok ? '可用' : '不可用'} — ${r.detail}`);
        return this.refreshStatus();
      case 'status':
        if (cmd.jobId) this.append('text', formatJob(engine.job(cmd.jobId)));
        else for (const j of engine.jobs(10)) this.append('text', `${j.id} ${STATUS_LABEL[j.status]} · ${ellipsis(j.task, 50)}`);
        return;
      case 'cancel':
        if (cmd.jobId) this.append('notice', `[${engine.cancel(cmd.jobId).id}] 已取消。`);
        else if (this.snapshot.runningJobId) this.interrupt();
        else this.append('notice', '当前没有正在运行的任务。');
        return;
      case 'approve': return cmd.jobId ? this.enqueue({ kind: 'approve', jobId: cmd.jobId }) : this.append('error', '用法：/approve <任务号>');
      case 'task': return this.enqueue(cmd);
      case 'pause':
      case 'resume': return this.append('notice', '这个指令只在常驻运行的渠道里有意义。');
    }
  }

  private async showDiff() {
    if (!this.files.length) return this.append('notice', '上一个任务没有改动文件。');
    const data = await (this.opts.readDiff ?? readDiff)(this.engine.project.root, this.files);
    if (data.error) return this.append('error', data.error);
    const { text, truncated } = colorizeDiff(data.diff, this.opts.color, 200);
    const lines = [data.stat.replace(/\r?\n$/, ''), text.replace(/\r?\n$/, '')].filter(Boolean);
    const details = [lines.join('\n\n')].filter(Boolean);
    if (truncated) details.push(paint('dim', `…还有 ${truncated} 行，用 git diff 查看完整内容。`, this.opts.color));
    if (data.untracked.length) details.push(`新文件（尚未被 git 跟踪，不在上面的差异里）：${data.untracked.join('、')}`);
    this.append('text', details.join('\n'));
  }

  private enqueue(work: Work) {
    this.queue.push(work);
    if (!this.working) { void this.drain(); return; }
    this.update({ queued: this.queue.length });
    this.append('notice', `已排队，前面还有 ${this.queue.length} 个任务。`);
  }

  private async drain() {
    this.working = true;
    for (let work = this.queue.shift(); work; work = this.queue.shift()) {
      this.update({ queued: this.queue.length });
      try { await this.runOne(work); } catch (error) { this.error(error); }
      this.update({ runningJobId: undefined, feed: EMPTY_FEED, plan: undefined });
      await this.refreshStatus();
    }
    this.working = false;
    if (this.exitKind) this.update({ exiting: this.exitKind });
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  private async runOne(work: Work) {
    const version = this.contextVersion;
    let done: Job;
    if (work.kind === 'approve') {
      this.update({ runningJobId: work.jobId });
      this.append('title', `${work.jobId} · 继续执行已批准的计划`);
      done = await this.engine.approve(work.jobId);
    } else {
      const job = this.engine.create({ task: work.text, role: work.role, ...(this.context && { context: this.context }),
        origin: { channel: 'terminal', senderId: this.opts.senderId ?? os.userInfo().username } });
      this.update({ runningJobId: job.id });
      const owner = job.role ? `交给 ${shortRole(this.roleLabel(job.role))}` : '主控安排';
      this.append('title', `${job.id} · ${owner} · ${job.task.split(/\r?\n/, 1)[0]}`);
      done = await this.engine.advance(job, { autoApprove: false, confirm: record => {
        if (!record.plan || this.snapshot.feed.stopping) return Promise.resolve(false);
        return new Promise(resolve => {
          this.answer = resolve;
          this.update({ plan: record.plan });
        });
      } });
    }
    this.files = done.result?.changedFiles ?? done.changedFiles;
    this.append('text', resultCard(done, this.opts.color));
    const conclusion = done.result?.conclusion;
    if (version === this.contextVersion && done.status === 'done' && conclusion?.trim()) {
      this.context = `同一次会话里上一个任务（${done.id}）的结论：\n${conclusion.slice(0, 3000)}`;
      this.update({ contextJobId: done.id });
    }
  }

  decidePlan(approved: boolean) {
    if (!this.answer) return;
    const resolve = this.answer;
    this.answer = undefined;
    this.update({ plan: undefined });
    resolve(approved);
  }

  interrupt() {
    const id = this.snapshot.runningJobId;
    if (!id) return;
    if (this.answer) return this.decidePlan(false);
    this.update({ feed: markStopping(this.snapshot.feed) });
    try { this.engine.cancel(id); } catch { /* 任务可能刚刚结束。 */ }
  }

  requestExit(kind: 'plain' | 'exit') {
    if (this.exitKind) return;
    this.exitKind = kind;
    const n = this.queue.length;
    if (n) {
      this.queue.length = 0;
      this.update({ queued: 0 });
      this.append('notice', `已放弃排队中的 ${n} 个任务。`);
    }
    if (this.working) this.interrupt();
    else this.update({ exiting: kind });
  }

  whenIdle(): Promise<void> {
    return this.working ? new Promise(resolve => this.waiters.add(resolve)) : Promise.resolve();
  }
}

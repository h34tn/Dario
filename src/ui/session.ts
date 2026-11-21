import type { RoleView } from '../core/roles.js';
import { findModel, type ModelList } from '../core/ports.js';
import os from 'node:os';
import path from 'node:path';
import { HELP_TEXT, refreshHolderModels, runModel, parseCommand, type Command } from '../core/commands.js';
import type { AgentView, Engine } from '../core/engine.js';
import { formatJob, formatQuota, formatModel, formatRoles, quotaPercent } from '../core/report.js';
import { ACTIVE_STATUSES, STATUS_LABEL, type FallbackQuestion, type Job, type Plan } from '../core/types.js';
import type { SavedSession } from '../core/state.js';
import { DarioError, ellipsis, formatLocalTime, normPath, nowIso } from '../core/util.js';
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
  roles: Array<{ label: string; holder?: string; model?: string; modelId?: string; effort?: string; quotaPercent?: number; degraded: boolean; priority: boolean }>;
}

interface RolePicker {
  roles: RoleView[];
  modelLabel: Engine['roles']['modelLabel'];
  roleIndex: number;
  direct: boolean;
  message?: string;
}
export type ModelPicker = RolePicker & ({ step: 'roles' } | {
  step: 'models';
  loading: boolean;
  saving?: boolean;
  list: ModelList;
  outside?: string;
  modelIndex: number;
  toolEfforts: string[];
  effort?: string;
});
export type ModelKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'back';

export function pickerEfforts(p: Extract<ModelPicker, { step: 'models' }>) {
  return p.toolEfforts.length ? p.list.models[p.modelIndex]?.efforts ?? p.toolEfforts : [];
}

export interface SessionSnapshot {
  history: HistoryItem[];
  feed: FeedState;
  runningJobId?: string;
  queued: number;
  picker?: ModelPicker;
  plan?: Plan;
  /** 正在等发起人回答的换人询问。 */
  ask?: FallbackQuestion;
  contextJobId?: string;
  status: StatusView;
  exiting?: 'exit' | 'plain';
}

export interface SessionOptions {
  engine: Engine;
  color: boolean;
  senderId?: string;
  /** 启动时直接接上会话（`dario --continue`）：true 接上这个项目上一次的会话，任务号则从那个任务接着做。 */
  continueLast?: boolean | string;
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
  private answerFallback?: (approved: boolean) => void;
  private exitKind?: 'exit' | 'plain';
  private context?: string;
  /** 各角色的 AI 会话，随任务一路带下去，`/new` 时丢弃。 */
  private roleSessions?: Job['sessions'];
  /** 当前任务里各角色实际上场的 AI：换人之后状态栏要显示真正在干活的那家，而不是角色表的首选。任务结束时清空。 */
  private readonly actual = new Map<string, string>();
  private contextVersion = 0;
  private quotas = new Map<string, AgentView['quota']>();
  /** 探测期间到达的额度事件优先于本次探测的快照。 */
  private pendingQuotas?: Map<string, NonNullable<AgentView['quota']>>;
  private resetTimer?: NodeJS.Timeout;
  private pickerVersion = 0;
  private disposed = false;
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
      if (event.kind === 'quota' && event.quota) {
        const { agent, windows } = event.quota;
        const quota = { free: false, windows };
        this.quotas.set(agent, quota);
        this.pendingQuotas?.set(agent, quota);
        this.updateStatusQuotas(this.snapshot.status.roles);
        return;
      }
      const who = event.step;
      if (who?.agent && (event.kind === 'step_start' || event.kind === 'fallback') && this.actual.get(who.role) !== who.agent) {
        this.actual.set(who.role, who.agent);
        void this.refreshStatus();
      }
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
    const saved = this.loadSaved();
    if (typeof this.opts.continueLast === 'string') this.continueFrom(this.opts.continueLast);
    else if (saved && this.opts.continueLast) this.restore(saved);
    else if (saved) this.append('notice', `上一次会话停在 ${saved.jobId}（${formatLocalTime(saved.savedAt)}）：${ellipsis(saved.task, 50)}。输入 /continue 接着做。`);
    else if (this.opts.continueLast) this.append('notice', '这个项目没有可以接着做的会话，从头开始。');
    await this.refreshStatus(true);
  }

  /** 存档读写失败不影响干活：读不到当作没有，写不了就不存。 */
  private loadSaved(): SavedSession | undefined {
    try { return this.engine.state?.getSavedSession(this.engine.project.root); } catch { return undefined; }
  }

  private persist(session: SavedSession | undefined) {
    try { this.engine.state?.saveSession(this.engine.project.root, session); } catch { /* 见上 */ }
  }

  /** 一个任务结束后留给下一个任务的上文。只有做成的任务才有。 */
  private static contextOf(job: Job): string | undefined {
    const conclusion = job.result?.conclusion;
    return job.status === 'done' && conclusion?.trim()
      ? `同一次会话里上一个任务（${job.id}）的结论：\n${conclusion.slice(0, 3000)}` : undefined;
  }

  /**
   * 从指定的任务接着做：把会话还原成那个任务刚结束时的样子。
   * 做成的任务，上文是它的结论；没做成的，上文沿用它当时收到的上文（没做成的任务不改变上文）。
   * 各角色的 AI 会话取任务记录里的，包括它从更早的任务带过来的。
   */
  private continueFrom(id: string) {
    try {
      const job = this.engine.job(id);
      if (normPath(job.projectRoot) !== normPath(this.engine.project.root)) {
        throw new DarioError(`${job.id} 是在另一个项目里做的（${job.projectRoot}），不能在这里接着做。`);
      }
      if (ACTIVE_STATUSES.includes(job.status)) throw new DarioError(`${job.id} 还没有结束（${STATUS_LABEL[job.status]}），结束后才能接着做。`);
      // 旧的任务记录没有 contextJob 字段时，从上文开头的“上一个任务（J…）”里取
      const own = Session.contextOf(job);
      this.restore({
        savedAt: job.updatedAt, jobId: job.id, task: job.task.split(/\r?\n/, 1)[0] ?? '',
        files: job.result?.changedFiles ?? job.changedFiles,
        ...(own ? { context: own, contextJobId: job.id } : job.context
          ? { context: job.context, contextJobId: job.contextJob ?? /上一个任务（(J\d+)）/.exec(job.context)?.[1] } : {}),
        ...(job.sessions && { sessions: job.sessions }),
      });
    } catch (error) {
      this.error(error);
      this.append('notice', '没有接上，从头开始。');
    }
  }

  /** 接上存档的会话：上文、各角色的 AI 会话、上一个任务改动的文件。 */
  private restore(saved: SavedSession) {
    this.context = saved.context;
    this.roleSessions = saved.sessions;
    this.files = saved.files ?? [];
    this.contextVersion++;
    this.update({ contextJobId: saved.context ? saved.contextJobId ?? saved.jobId : undefined });
    try {
      const last = this.engine.job(saved.jobId);
      this.append('title', `${last.id} · ${last.task.split(/\r?\n/, 1)[0]}`);
      this.append('text', resultCard(last, this.opts.color));
    } catch { /* 任务记录不在了，只是少一段回顾 */ }
    const roles = Object.keys(saved.sessions ?? {}).map(id => shortRole(this.roleLabel(id)));
    this.append('notice', `已接上 ${formatLocalTime(saved.savedAt)} 的会话（${saved.jobId}）${roles.length ? `，${roles.join('、')}的 AI 会话接着用` : ''}。/new 从头开始。`);
  }

  private async loadAgents(version: number) {
    try {
      const agents = await this.engine.agentsView();
      if (version === this.statusVersion) this.completion = { ...this.completion, agents: agents.map(a => a.id) };
      return new Map(agents.map(a => [a.id, a]));
    } catch { return undefined; }
  }

  private async refreshStatus(loadModels = false) {
    const version = ++this.statusVersion;
    const pending = this.pendingQuotas = new Map<string, NonNullable<AgentView['quota']>>();
    try {
      const [views, agents] = await Promise.all([this.engine.rolesView(), this.loadAgents(version)]);
      if (version !== this.statusVersion) return;
      this.quotas = new Map(Array.from(agents?.values() ?? [], a => [a.id, a.quota]));
      for (const [agent, quota] of pending) this.quotas.set(agent, quota);
      const { leadRole, reviewRole } = this.engine.project.settings;
      const writer = views.find(v => v.access === 'write' && v.id !== leadRole && v.id !== reviewRole);
      const priorityIds = new Set([leadRole, writer?.id, reviewRole]);
      const roles = views.map(view => {
        const first = view.candidates[0];
        const holder = this.actual.get(view.id) ?? view.holder;
        const choice = view.candidates.find(c => c.agent === holder);
        const model = holder && choice && (choice.model || choice.effort) ? formatModel(holder, choice.model, choice.effort, this.engine.roles.modelLabel) : undefined;
        return { label: shortRole(this.roleLabel(view.id)), holder, model, modelId: choice?.model, effort: choice?.effort,
          degraded: first?.state !== 'ok' || holder !== first.agent, priority: priorityIds.has(view.id) };
      });
      this.completion = { ...this.completion, roles: views.map(({ id, alias }) => ({ id, alias })) };
      this.updateStatusQuotas(roles);
      if (loadModels) {
        const candidates = new Set(views.flatMap(v => v.candidates.map(c => c.agent)));
        for (const agent of candidates) {
          void this.engine.roles.listModels(agent).then(list => {
            if (!list.error) this.refreshModelLabels(agent);
          }).catch(() => { /* 后台查询失败时保留原来的显示名。 */ });
        }
      }
    } catch { /* 探测失败时保留上次的状态。 */ }
    finally { if (version === this.statusVersion) this.pendingQuotas = undefined; }
  }

  private refreshModelLabels(agent: string) {
    if (this.disposed) return;
    const status = this.snapshot.status;
    const roles = status.roles.map(role => role.holder === agent && role.modelId
      ? { ...role, model: formatModel(agent, role.modelId, role.effort, this.engine.roles.modelLabel) }
      : role);
    this.update({ status: { ...status, roles } });
  }

  private updateStatusQuotas(roles: StatusView['roles']) {
    clearTimeout(this.resetTimer);
    const now = new Date();
    let nextReset = Infinity;
    const updated = roles.map(role => {
      const quota = role.holder ? this.quotas.get(role.holder) : undefined;
      for (const window of quota?.windows ?? []) {
        if (!window.resetsAt) continue;
        const reset = Date.parse(window.resetsAt);
        if (reset > now.getTime()) nextReset = Math.min(nextReset, reset);
      }
      return { ...role, quotaPercent: quotaPercent(quota, now) };
    });
    if (Number.isFinite(nextReset)) {
      this.resetTimer = setTimeout(() => this.updateStatusQuotas(this.snapshot.status.roles),
        Math.min(nextReset - now.getTime(), 2_147_483_647)).unref();
    }
    this.update({ status: { ...this.snapshot.status, roles: updated } });
  }

  dispose() {
    this.disposed = true;
    this.off?.();
    this.statusVersion++;
    clearTimeout(this.resetTimer);
  }

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
      this.roleSessions = undefined;
      this.contextVersion++;
      this.update({ contextJobId: undefined });
      this.persist(undefined);
      return this.append('notice', '已清空会话上文，各角色的 AI 会话也重新开始，下一个任务从头开始。');
    }
    if (line === '/continue' || line.startsWith('/continue ')) {
      if (this.working) return this.append('error', '有任务在运行，等它结束后再接上之前的会话。');
      const id = line.slice('/continue'.length).trim();
      if (id) return this.continueFrom(id);
      const saved = this.loadSaved();
      return saved ? this.restore(saved) : this.append('notice', '这个项目没有可以接着做的会话。');
    }
    if (line === '/diff') return this.showDiff();
    const cmd = parseCommand(line);
    const engine = this.engine;
    switch (cmd.kind) {
      case 'invalid': return this.append('error', cmd.message);
      case 'help': return this.append('text', [HELP_TEXT, '/diff                  查看上一个任务的改动',
        '/continue [任务号]     接上这个项目上一次的会话；给出任务号则从那个任务接着做',
        '/new                   清空会话上文，各角色的 AI 会话重新开始', '/plain                 切换到逐行交互', '/exit                  退出'].join('\n'));
      case 'roles': return this.append('text', formatRoles(await engine.rolesView(), engine.roles.fallback, engine.roles.modelLabel));
      case 'agents':
        for (const a of await engine.agentsView()) {
          const st = !a.enabled ? '已停用' : !a.installed ? '未安装' : a.unavailable ? `暂时不可用（${a.unavailable}）` : '可用';
          this.append('text', `${a.id}${a.model || a.effort ? `（${formatModel(a.id, a.model, a.effort, engine.roles.modelLabel)}）` : ''}：${st}${a.version ? ` · ${a.version}` : ''} · ${formatQuota(a.quota, new Date())}`);
        }
        return;
      case 'model':
        if (!cmd.value && !cmd.effort && !cmd.reset) return this.openModels(cmd.role);
        this.append('text', await runModel(engine, cmd));
        return this.refreshStatus();
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

  private async openModels(name?: string) {
    if (this.snapshot.plan || this.snapshot.ask) return;
    const version = ++this.pickerVersion;
    const roles = await this.engine.rolesView();
    if (version !== this.pickerVersion) return;
    const id = name && this.engine.roles.resolve(name);
    const roleIndex = name ? roles.findIndex(r => r.id === id) : 0;
    if (roleIndex < 0) return this.append('error', `没有这个角色：${name}`);
    const picker: ModelPicker = { step: 'roles', roles, roleIndex, modelLabel: this.engine.roles.modelLabel, direct: !!name };
    this.update({ picker });
    if (name) await this.selectModelRole(picker);
    else void refreshHolderModels(this.engine, roles, agent => {
      if (!this.disposed && version === this.pickerVersion) this.refreshModelLabels(agent);
    });
  }

  private async selectModelRole(p: RolePicker) {
    const role = p.roles[p.roleIndex];
    const current = role?.candidates.find(c => c.agent === role.holder);
    if (!current || !role) {
      const why = role?.candidates.map(c => c.note).filter(Boolean).join('、');
      const message = '角色目前没有可用的 AI' + (why ? '：' + why : '。');
      if (p.direct) this.append('error', message);
      this.update({ picker: p.direct ? undefined : { ...p, step: 'roles', message } });
      return;
    }
    const loading: ModelPicker = { ...p, message: undefined, step: 'models', loading: true, list: { models: [] },
      modelIndex: 0, toolEfforts: this.engine.roles.efforts(current.agent) };
    this.update({ picker: loading });
    const list = await this.engine.roles.listModels(current.agent).catch(error => ({ models: [], error: String(error) }));
    if (!list.error) this.refreshModelLabels(current.agent);
    if (this.snapshot.picker !== loading) return;
    const models = list.error ? [] : [...list.models];
    const match = findModel(models, current.model);
    const outside = match ? undefined : current.model;
    if (outside) {
      const label = this.engine.roles.modelLabel(current.agent, outside);
      models.unshift({ id: outside, ...(label !== outside && { label }) });
    }
    const picker = { ...loading, loading: false, list: { ...list, models }, outside,
      modelIndex: match ? models.indexOf(match) : 0 };
    this.update({ picker: { ...picker, effort: pickerEfforts(picker).includes(current.effort ?? '') ? current.effort : undefined } });
  }

  async modelKey(key: ModelKey) {
    const p = this.snapshot.picker;
    if (!p || (p.step === 'models' && p.saving)) return;
    if (key === 'back') {
      this.update({ picker: p.step === 'models' && !p.direct
        ? { step: 'roles', roles: p.roles, modelLabel: p.modelLabel, roleIndex: p.roleIndex, direct: false } : undefined });
      return;
    }
    const delta = key === 'up' || key === 'left' ? -1 : 1;
    if (p.step === 'roles') {
      if (key === 'enter') return this.selectModelRole(p);
      if (key === 'up' || key === 'down') this.update({ picker: { ...p, message: undefined,
        roleIndex: Math.max(0, Math.min(p.roles.length - 1, p.roleIndex + delta)) } });
      return;
    }
    if (p.loading) return;
    if (key === 'up' || key === 'down') {
      const next = { ...p, message: undefined, modelIndex: Math.max(0, Math.min(p.list.models.length - 1, p.modelIndex + delta)) };
      if (!pickerEfforts(next).includes(next.effort ?? '')) next.effort = undefined;
      this.update({ picker: next });
    } else if (key === 'left' || key === 'right') {
      const choices = [undefined, ...pickerEfforts(p)];
      this.update({ picker: { ...p, message: undefined, effort: choices[(choices.indexOf(p.effort) + delta + choices.length) % choices.length] } });
    } else if (key === 'enter') {
      const model = p.list.models[p.modelIndex]?.id;
      const settings = { ...(model && model !== p.outside && { model }), effort: p.effort ?? null };
      if (!model && !p.toolEfforts.length && !settings.effort) {
        this.update({ picker: { ...p, message: '没有可保存的型号或强度。' } });
        return;
      }
      const saving = { ...p, saving: true };
      this.update({ picker: saving });
      try {
        const message = await this.engine.setModel(p.roles[p.roleIndex]!.id, settings, 'local');
        if (this.snapshot.picker === saving) this.update({ picker: undefined });
        this.append('text', message);
        await this.refreshStatus();
      } catch (error) {
        if (this.snapshot.picker === saving) this.update({ picker: { ...p, message: error instanceof Error ? error.message : String(error) } });
        else this.error(error);
      }
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
      this.update({ runningJobId: undefined, feed: EMPTY_FEED, plan: undefined, ask: undefined });
      this.actual.clear();
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
      done = await this.engine.approve(work.jobId, { confirmFallback: this.confirmFallback });
    } else {
      const job = this.engine.create({ task: work.text, role: work.role,
        ...(this.context && { context: this.context, contextJob: this.snapshot.contextJobId }),
        ...(this.roleSessions && { sessions: this.roleSessions }),
        origin: { channel: 'terminal', senderId: this.opts.senderId ?? os.userInfo().username } });
      this.update({ runningJobId: job.id });
      const owner = job.role ? `交给 ${shortRole(this.roleLabel(job.role))}` : '主控安排';
      this.append('title', `${job.id} · ${owner} · ${job.task.split(/\r?\n/, 1)[0]}`);
      done = await this.engine.advance(job, { autoApprove: false, confirmFallback: this.confirmFallback, confirm: record => {
        if (!record.plan || this.snapshot.feed.stopping) return Promise.resolve(false);
        return new Promise(resolve => {
          this.answer = resolve;
          this.pickerVersion++;
          this.update({ plan: record.plan, picker: undefined });
        });
      } });
    }
    this.files = done.result?.changedFiles ?? done.changedFiles;
    this.append('text', resultCard(done, this.opts.color));
    const conclusion = done.result?.conclusion;
    // 会话不看任务成败：做成的那几轮仍然有效，没做成的那一轮执行时已经作废
    if (version === this.contextVersion && done.sessions) this.roleSessions = done.sessions;
    const own = Session.contextOf(done);
    if (version === this.contextVersion && own) {
      this.context = own;
      this.update({ contextJobId: done.id });
    }
    // 每个任务结束都存档，退出（包括更新 Dario 后重进）再进来可以用 --continue 或 /continue 接上
    if (version === this.contextVersion && (this.context || this.roleSessions)) {
      this.persist({ savedAt: nowIso(), jobId: done.id, task: done.task.split(/\r?\n/, 1)[0] ?? '', files: this.files,
        ...(this.context && { context: this.context, contextJobId: this.snapshot.contextJobId }),
        ...(this.roleSessions && { sessions: this.roleSessions }) });
    }
  }

  /** 换人之前问一句，等界面按键回答。任务正在终止时不再问，直接当作不同意。 */
  private confirmFallback = (question: FallbackQuestion): Promise<boolean> => {
    if (this.snapshot.feed.stopping) return Promise.resolve(false);
    return new Promise(resolve => {
      this.answerFallback = resolve;
      this.pickerVersion++;
      this.update({ ask: question, picker: undefined });
    });
  };

  decideFallback(approved: boolean) {
    if (!this.answerFallback) return;
    const resolve = this.answerFallback;
    this.answerFallback = undefined;
    this.update({ ask: undefined });
    resolve(approved);
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
    if (this.answerFallback) return this.decideFallback(false);
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

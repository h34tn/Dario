import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, UserConfig } from './config.js';
import { HEALTH_PROMPT } from './defaults.js';
import { Orchestrator, type RunOptions } from './orchestrator.js';
import type { AgentCatalog } from './ports.js';
import { killProcessTree } from './proc.js';
import { RoleBook, type RoleView } from './roles.js';
import { StepRunner } from './runner.js';
import type { StateStore } from './state.js';
import { ACTIVE_STATUSES, type Job, type Origin, type ProgressEvent, type RoleSession, type Strategy } from './types.js';
import { ConfigError, DarioError, isPidAlive, normPath, nowIso } from './util.js';
import { InPlaceWorkspace, IsolatedWorkspace, type IsolatedOptions, type Workspace } from './workspace.js';

export interface EngineDeps {
  user: UserConfig;
  project: ProjectConfig;
  catalog: AgentCatalog;
  state: StateStore;
  strategy: Strategy;
  /** 隔离执行的设置；strategy 为 isolated 时必填。 */
  isolated?: IsolatedOptions;
}

export interface SubmitRequest {
  task: string;
  /** 角色名或别名；不填则交给主控。 */
  role?: string;
  origin: Origin;
  autoApprove?: boolean;
  confirm?: RunOptions['confirm'];
  context?: string;
  /** 同一次交互里上一个任务留下的各角色会话，本任务接着用。 */
  sessions?: Record<string, RoleSession>;
}

export interface AgentView {
  id: string;
  displayName: string;
  plugin: string;
  model?: string;
  enabled: boolean;
  installed: boolean;
  version?: string;
  path?: string;
  /** 暂时不可用的原因。 */
  unavailable?: string;
}

export interface HealthResult {
  agent: string;
  ok: boolean;
  detail: string;
}

/** Dario 的核心入口：一个引擎对应一个项目和一种执行环境策略。 */
export class Engine {
  readonly roles: RoleBook;
  private readonly listeners = new Set<(e: ProgressEvent) => void>();
  private readonly orchestrator: Orchestrator;

  constructor(private readonly deps: EngineDeps) {
    this.roles = new RoleBook(deps.project, deps.catalog, deps.state);
    const emit = (e: ProgressEvent): void => {
      for (const fn of this.listeners) fn(e);
    };
    const runner = new StepRunner({
      roles: this.roles,
      catalog: deps.catalog,
      state: deps.state,
      project: deps.project,
      cooldownMinutes: deps.user.cooldownMinutes,
      emit,
    });
    this.orchestrator = new Orchestrator({ state: deps.state, roles: this.roles, runner, project: deps.project, emit });
  }

  get project(): ProjectConfig {
    return this.deps.project;
  }

  get state(): StateStore {
    return this.deps.state;
  }

  get strategy(): Strategy {
    return this.deps.strategy;
  }

  onProgress(fn: (e: ProgressEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private workspace(): Workspace {
    if (this.deps.strategy === 'isolated') {
      return new IsolatedWorkspace(this.deps.project.root, this.deps.isolated ?? { forbiddenPaths: [] });
    }
    return new InPlaceWorkspace(this.deps.project.root);
  }

  /** 启动常驻前检查隔离克隆是否可用。 */
  async assertWorkspaceUsable(): Promise<void> {
    const ws = this.workspace();
    if (ws instanceof IsolatedWorkspace) await ws.assertSafe();
  }

  /** 校验请求并建立任务记录，尚未开始执行。 */
  create(req: SubmitRequest): Job {
    const { project, state } = this.deps;
    const task = req.task.trim();
    if (!task) throw new ConfigError('任务描述为空。');
    let role: string | undefined;
    if (req.role) {
      role = this.roles.resolve(req.role);
      if (!role) throw new ConfigError(`没有这个角色：${req.role}。可用角色：${this.roles.ids().join('、')}`);
    } else if (!this.roles.has(project.settings.leadRole)) {
      throw new ConfigError(`项目设置里的主控角色 ${project.settings.leadRole} 不在角色表中。可以用 --to 直接指定角色。`);
    }
    const now = nowIso();
    const job: Job = {
      id: state.nextJobId(),
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      mode: role ? 'direct' : 'lead',
      task,
      role,
      projectRoot: project.root,
      strategy: this.deps.strategy,
      origin: req.origin,
      context: req.context,
      // 带过来的会话在本任务里还没有上过场
      ...(req.sessions && {
        sessions: Object.fromEntries(Object.entries(req.sessions).map(([roleId, s]) => [roleId, { ...s, step: -1 }])),
      }),
      cursor: 0,
      steps: [],
      reworkRounds: 0,
      changedFiles: [],
      reviewedSinceChange: true,
      warnings: [],
      ownerPid: process.pid,
    };
    state.saveJob(job);
    state.audit('job_created', { job: job.id, mode: job.mode, role, channel: req.origin.channel, sender: req.origin.senderId });
    return job;
  }

  /** 推进任务直到结束或停在"等待确认"。 */
  async advance(job: Job, opts: RunOptions): Promise<Job> {
    const { state, project } = this.deps;
    const release = state.acquireDirLock(project.root, job.id);
    if (!release) {
      const holder = state.dirLockHolder(project.root);
      job.status = 'failed';
      job.failureCode = 'workspace';
      job.ownerPid = undefined;
      job.result = {
        conclusion: `这个目录已经有任务${holder ? ` ${holder} ` : ''}在运行，同一目录同一时间只能跑一个。`,
        changedFiles: [],
        fallbackHappened: false,
        warnings: [],
      };
      state.saveJob(job);
      return job;
    }
    job.ownerPid = process.pid;
    try {
      return await this.orchestrator.run(job, this.workspace(), opts);
    } finally {
      release();
    }
  }

  async submit(req: SubmitRequest): Promise<Job> {
    const job = this.create(req);
    return this.advance(job, { autoApprove: req.autoApprove ?? false, confirm: req.confirm });
  }

  /** 批准等待确认的计划并继续执行。 */
  async approve(jobId: string): Promise<Job> {
    const job = this.requireJob(jobId);
    if (job.status !== 'awaiting_approval') {
      throw new ConfigError(`任务 ${job.id} 当前是"${job.status}"状态，不在等待确认。`);
    }
    if (normPath(job.projectRoot) !== normPath(this.deps.project.root)) {
      throw new ConfigError(`任务 ${job.id} 属于另一个项目：${job.projectRoot}。请在那个目录里批准。`);
    }
    this.deps.state.audit('job_approved', { job: job.id });
    return this.advance(job, { autoApprove: true });
  }

  /** 取消任务。正在运行时终止 AI 进程树，由推进它的进程收尾。 */
  cancel(jobId: string): Job {
    const { state } = this.deps;
    const job = this.requireJob(jobId);
    if (!ACTIVE_STATUSES.includes(job.status) && job.status !== 'awaiting_approval') {
      throw new ConfigError(`任务 ${job.id} 已经结束（${job.status}），不需要取消。`);
    }
    state.audit('job_cancel', { job: job.id });
    const ownerAlive = job.ownerPid !== undefined && job.ownerPid !== process.pid && isPidAlive(job.ownerPid);
    const runningHere = job.ownerPid === process.pid && ACTIVE_STATUSES.includes(job.status);
    state.requestCancel(job.id);
    if (ownerAlive || runningHere) {
      // 由推进它的进程收尾：它在每一步前后检查取消标记
      killProcessTree(job.activePid);
      job.cancelRequested = true;
      return job;
    }
    job.status = 'cancelled';
    job.cancelRequested = true;
    job.ownerPid = undefined;
    job.activePid = undefined;
    job.result = { conclusion: '任务已取消。', changedFiles: job.changedFiles, fallbackHappened: false, warnings: job.warnings };
    state.saveJob(job);
    return job;
  }

  requireJob(jobId: string): Job {
    const job = this.deps.state.loadJob(jobId);
    if (!job) throw new ConfigError(`没有这个任务：${jobId}`);
    return job;
  }

  /** 最近的任务。推进它的进程已不存在的，顺手标为"中断"。 */
  jobs(limit = 20): Job[] {
    return this.deps.state.listJobs(limit).map((job) => this.settle(job));
  }

  job(jobId: string): Job {
    return this.settle(this.requireJob(jobId));
  }

  private settle(job: Job): Job {
    if (ACTIVE_STATUSES.includes(job.status) && !isPidAlive(job.ownerPid)) {
      job.status = 'interrupted';
      job.ownerPid = undefined;
      job.activePid = undefined;
      job.result = {
        conclusion: 'Dario 在任务执行过程中退出，任务被中断，没有自动重跑。',
        changedFiles: job.changedFiles,
        fallbackHappened: false,
        warnings: job.warnings,
        branch: job.branch,
      };
      this.deps.state.saveJob(job);
      this.deps.state.audit('job_interrupted', { job: job.id });
    }
    return job;
  }

  /** 找出被中断的任务（常驻进程启动时调用），返回本次新标记的那些。 */
  recoverInterrupted(channel?: string): Job[] {
    const found: Job[] = [];
    for (const job of this.deps.state.listJobs(200)) {
      if (channel && job.origin.channel !== channel) continue;
      if (!ACTIVE_STATUSES.includes(job.status)) continue;
      if (isPidAlive(job.ownerPid)) continue;
      found.push(this.settle(job));
    }
    return found;
  }

  rolesView(): Promise<RoleView[]> {
    return this.roles.view();
  }

  async agentsView(): Promise<AgentView[]> {
    const out: AgentView[] = [];
    for (const port of this.deps.catalog.list()) {
      const detect = port.enabled ? await port.detect() : { installed: false };
      out.push({
        id: port.id,
        displayName: port.displayName,
        plugin: port.pluginId,
        model: port.model,
        enabled: port.enabled,
        installed: detect.installed,
        version: detect.version,
        path: detect.path,
        unavailable: this.deps.state.getHealthMark(port.id)?.reason,
      });
    }
    return out;
  }

  /** 实际调用一次，确认可用。可用则清除"暂时不可用"的标记。 */
  async health(agentId?: string): Promise<HealthResult[]> {
    const { catalog, state, user } = this.deps;
    const ports = agentId ? [catalog.get(agentId)] : catalog.list().filter((p) => p.enabled);
    if (agentId && !ports[0]) throw new ConfigError(`本机没有配置这个 AI：${agentId}`);
    const results: HealthResult[] = [];
    for (const port of ports) {
      if (!port) continue;
      const detect = await port.detect();
      if (!detect.installed) {
        results.push({ agent: port.id, ok: false, detail: '未安装或找不到命令' });
        continue;
      }
      const dir = path.join(state.dir, 'health', port.id);
      fs.mkdirSync(dir, { recursive: true });
      const res = await port.run({ access: 'read-only', cwd: dir, prompt: HEALTH_PROMPT, timeoutMs: 180000, workDir: dir, label: 'health' });
      if (res.outcome === 'ok') {
        state.clearHealth(port.id);
        results.push({ agent: port.id, ok: true, detail: `可用（${Math.round(res.durationMs / 1000)} 秒）` });
      } else {
        if (res.outcome === 'unavailable') state.markUnavailable(port.id, res.reason ?? '不可用', user.cooldownMinutes);
        results.push({ agent: port.id, ok: false, detail: res.reason ?? res.outcome });
      }
      state.audit('health', { agent: port.id, outcome: res.outcome, reason: res.reason });
    }
    return results;
  }

  setRole(role: string, agent: string, save: boolean): string {
    const roleId = this.roles.resolve(role);
    if (!roleId) throw new ConfigError(`没有这个角色：${role}。可用角色：${this.roles.ids().join('、')}`);
    this.roles.setOverride(roleId, agent);
    this.deps.state.audit('role_set', { role: roleId, agent, save });
    if (save) {
      const file = this.roles.saveAsDefault(roleId, agent);
      this.roles.clearOverride(roleId);
      return `${this.roles.label(roleId)} 改由 ${agent} 担当，已写回 ${file}`;
    }
    return `${this.roles.label(roleId)} 临时改由 ${agent} 担当（只在本机生效）`;
  }

  resetRole(role: string): string {
    const roleId = this.roles.resolve(role);
    if (!roleId) throw new ConfigError(`没有这个角色：${role}。可用角色：${this.roles.ids().join('、')}`);
    this.roles.clearOverride(roleId);
    this.deps.state.audit('role_reset', { role: roleId });
    return `${this.roles.label(roleId)} 已恢复为角色表里的顺序`;
  }
}

export { DarioError };

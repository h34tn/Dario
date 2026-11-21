import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ModelChoice, QuotaWindow } from '../plugin.js';
import { findModel } from './ports.js';
import type { Job, RoleSession } from './types.js';
import { normPath, nowIso, readJson, shortHash, withLock, writeJsonAtomic } from './util.js';

type ModelName = Pick<ModelChoice, 'id' | 'label' | 'resolved'>;

interface SavedQuota {
  observedAt: string;
  windows: QuotaWindow[];
}

export interface HealthMark {
  until: string;
  reason: string;
}

/** 终端交互里一次会话的存档：退出后再进来可以接着做。 */
export interface SavedSession {
  savedAt: string;
  /** 存档时最近完成的任务。 */
  jobId: string;
  /** 那个任务的第一行，用于提示。 */
  task: string;
  /** 带给下一个任务的上文。 */
  context?: string;
  /** 上文是哪个任务的结论。 */
  contextJobId?: string;
  /** 各角色的 AI 会话。 */
  sessions?: Record<string, RoleSession>;
  /** 最近一个任务改动的文件，供 /diff 使用。 */
  files: string[];
}

const DEDUPE_TTL_MS = 48 * 3600 * 1000;

/**
 * 本机状态：任务记录、临时指定的担当者、可用状态、去重记录、审计日志。
 * 全部是 `~/.dario/state/` 下的 JSON 文件，命令行与常驻进程共用。
 */
export class StateStore {
  readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, 'state');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  private lock<T>(name: string, fn: () => T): T {
    return withLock(this.file('locks', `${name}.lock`), fn);
  }

  newImagePath(): string {
    const dir = path.resolve(this.dir, 'images');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${Date.now()}-${randomUUID()}.png`);
  }

  cleanOldImages(now = Date.now()): void {
    const dir = this.file('images');
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) continue;
      const image = path.join(dir, file.name);
      if (now - fs.statSync(image).mtimeMs > 7 * 86400000) fs.unlinkSync(image);
    }
  }

  // ----- 任务 -----

  nextJobId(): string {
    return this.lock('counter', () => {
      const f = this.file('counter.json');
      const n = readJson<{ next: number }>(f, { next: 1 }).next;
      writeJsonAtomic(f, { next: n + 1 });
      return `J${String(n).padStart(4, '0')}`;
    });
  }

  jobDir(id: string): string {
    const d = this.file('jobs', id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  saveJob(job: Job): void {
    job.updatedAt = nowIso();
    writeJsonAtomic(path.join(this.jobDir(job.id), 'job.json'), job);
  }

  loadJob(id: string): Job | undefined {
    const f = this.file('jobs', id.toUpperCase(), 'job.json');
    if (!fs.existsSync(f)) return undefined;
    return readJson<Job | undefined>(f, undefined);
  }

  /** 最近的任务，新的在前。 */
  listJobs(limit = 20): Job[] {
    const root = this.file('jobs');
    let names: string[] = [];
    try {
      names = fs.readdirSync(root).filter((n) => /^J\d+$/.test(n));
    } catch {
      return [];
    }
    names.sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    const jobs: Job[] = [];
    for (const name of names) {
      if (jobs.length >= limit) break;
      const job = this.loadJob(name);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /**
   * 取消请求单独存成标记文件，不写进任务记录：
   * 任务记录由推进它的进程反复整体保存，写在里面会被覆盖。
   */
  requestCancel(id: string): void {
    fs.writeFileSync(path.join(this.jobDir(id.toUpperCase()), 'cancel'), nowIso(), 'utf8');
  }

  isCancelRequested(id: string): boolean {
    return fs.existsSync(this.file('jobs', id.toUpperCase(), 'cancel'));
  }

  // ----- 临时指定的担当者（按项目区分） -----

  private overridesFile(projectRoot: string): string {
    return this.file('projects', shortHash(normPath(projectRoot)), 'overrides.json');
  }

  getOverrides(projectRoot: string): Record<string, string> {
    return readJson<Record<string, string>>(this.overridesFile(projectRoot), {});
  }

  setOverride(projectRoot: string, role: string, agent: string | undefined): void {
    this.lock('overrides', () => {
      const all = this.getOverrides(projectRoot);
      if (agent === undefined) delete all[role];
      else all[role] = agent;
      writeJsonAtomic(this.overridesFile(projectRoot), all);
    });
  }

  // ----- 终端交互的会话存档（按项目区分，每个项目只留最近一次） -----

  private sessionFile(projectRoot: string): string {
    return this.file('projects', shortHash(normPath(projectRoot)), 'session.json');
  }

  getSavedSession(projectRoot: string): SavedSession | undefined {
    const saved = readJson<SavedSession | undefined>(this.sessionFile(projectRoot), undefined);
    return saved && typeof saved.jobId === 'string' ? saved : undefined;
  }

  /** 传 undefined 表示删除存档。 */
  saveSession(projectRoot: string, session: SavedSession | undefined): void {
    const f = this.sessionFile(projectRoot);
    if (session) writeJsonAtomic(f, session);
    else fs.rmSync(f, { force: true });
  }

  // ----- 可用状态（整台机器共用） -----

  private healthFile(): string {
    return this.file('health.json');
  }

  /** 仍在生效的"暂时不可用"标记。 */
  getHealthMark(agent: string): HealthMark | undefined {
    const mark = readJson<Record<string, HealthMark>>(this.healthFile(), {})[agent];
    if (!mark) return undefined;
    return Date.parse(mark.until) > Date.now() ? mark : undefined;
  }

  markUnavailable(agent: string, reason: string, cooldownMinutes: number): void {
    this.lock('health', () => {
      const all = readJson<Record<string, HealthMark>>(this.healthFile(), {});
      all[agent] = { until: new Date(Date.now() + cooldownMinutes * 60000).toISOString(), reason };
      writeJsonAtomic(this.healthFile(), all);
    });
  }

  clearHealth(agent: string): void {
    this.lock('health', () => {
      const all = readJson<Record<string, HealthMark>>(this.healthFile(), {});
      if (agent in all) {
        delete all[agent];
        writeJsonAtomic(this.healthFile(), all);
      }
    });
  }

  private modelNames() {
    return readJson<Record<string, { observedAt: string; models: ModelName[] }>>(this.file('models.json'), {});
  }

  modelLabel(agent: string, model: string): string {
    return findModel(this.modelNames()[agent]?.models ?? [], model)?.label || model;
  }

  saveModels(agent: string, choices: ModelChoice[]): void {
    const models = choices.map(({ id, label, resolved }) => ({ id, label, resolved }));
    this.lock('models', () => {
      writeJsonAtomic(this.file('models.json'), { ...this.modelNames(), [agent]: { observedAt: nowIso(), models } });
    });
  }

  getQuotas(): Record<string, SavedQuota> {
    return readJson(this.file('quota.json'), {});
  }

  /** 在同一把锁下比较和保存；窗口顺序变化不算新观测。 */
  saveQuota(agent: string, windows: QuotaWindow[]): boolean {
    return this.lock('quota', () => {
      const all = this.getQuotas();
      const previous = all[agent]?.windows;
      if (previous && previous.length === windows.length) {
        const byId = new Map(previous.map(window => [window.id, window]));
        if (windows.every(window => isDeepStrictEqual(window, byId.get(window.id)))) return false;
      }
      writeJsonAtomic(this.file('quota.json'), { ...all, [agent]: { observedAt: nowIso(), windows } });
      return true;
    });
  }

  // ----- 去重 -----

  /** 第一次见到这条消息时返回 true 并记下；重复时返回 false。 */
  firstSeen(channel: string, messageId: string): boolean {
    return this.lock('dedupe', () => {
      const f = this.file('dedupe.json');
      const all = readJson<Record<string, number>>(f, {});
      const key = `${channel}:${messageId}`;
      if (all[key]) return false;
      const now = Date.now();
      for (const [k, t] of Object.entries(all)) if (now - t > DEDUPE_TTL_MS) delete all[k];
      all[key] = now;
      writeJsonAtomic(f, all);
      return true;
    });
  }

  // ----- 话题与任务的对应 -----

  getThreadJob(channel: string, threadKey: string): string | undefined {
    return readJson<Record<string, string>>(this.file('threads.json'), {})[`${channel}:${threadKey}`];
  }

  setThreadJob(channel: string, threadKey: string, jobId: string): void {
    this.lock('threads', () => {
      const f = this.file('threads.json');
      const all = readJson<Record<string, string>>(f, {});
      all[`${channel}:${threadKey}`] = jobId;
      writeJsonAtomic(f, all);
    });
  }

  // ----- 审计 -----

  audit(event: string, data: Record<string, unknown> = {}): void {
    try {
      fs.appendFileSync(this.file('audit.log'), `${JSON.stringify({ ts: nowIso(), event, ...data })}\n`, 'utf8');
    } catch {
      // 审计写入失败不应中断任务
    }
  }

  /** 读取审计日志（测试与排障用）。 */
  readAudit(): Array<Record<string, unknown>> {
    try {
      return fs
        .readFileSync(this.file('audit.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  // ----- 目录锁：同一工作目录同一时间只跑一个任务 -----

  /** 成功返回释放函数；该目录已被另一个存活的进程占用时返回 undefined。 */
  acquireDirLock(dir: string, jobId: string): (() => void) | undefined {
    const f = this.file('dirlocks', `${shortHash(normPath(dir))}.json`);
    return this.lock('dirlocks', () => {
      const cur = readJson<{ pid: number; jobId: string } | undefined>(f, undefined);
      if (cur && cur.pid !== process.pid && isAlive(cur.pid)) return undefined;
      if (cur && cur.pid === process.pid && cur.jobId !== jobId) return undefined;
      writeJsonAtomic(f, { pid: process.pid, jobId });
      return () => {
        try {
          const now = readJson<{ pid: number; jobId: string } | undefined>(f, undefined);
          if (now && now.pid === process.pid && now.jobId === jobId) fs.unlinkSync(f);
        } catch {
          // 忽略
        }
      };
    });
  }

  dirLockHolder(dir: string): string | undefined {
    const f = this.file('dirlocks', `${shortHash(normPath(dir))}.json`);
    const cur = readJson<{ pid: number; jobId: string } | undefined>(f, undefined);
    return cur && isAlive(cur.pid) ? cur.jobId : undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

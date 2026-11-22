import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SyncMode } from './config.js';
import type { PulledUpdate, Strategy } from './types.js';
import { DarioError, normPath, realPath } from './util.js';

export class WorkspaceError extends DarioError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'WorkspaceError';
  }
}

/** 某一时刻"有改动的文件"的指纹；目录不是 git 仓库时为 null，表示无法检测。 */
export type Stamp = Map<string, string> | null;

/** 开工前同步的结果：notes 只是告知，warnings 要让发起人在结果里看到。 */
export interface SyncReport {
  notes: string[];
  warnings: string[];
  /** 真的拉到了新提交时才有。 */
  pulled?: PulledUpdate;
}

export interface FinalizeInfo {
  changed: string[];
  /** 存在越界改动（范围之外，或只读角色改了文件）。 */
  violation: boolean;
}

/**
 * 执行环境。所有方法都是异步的：git 在大仓库上可能要跑好几秒，
 * 不能阻塞常驻进程处理渠道事件。
 */
export interface Workspace {
  readonly strategy: Strategy;
  readonly cwd: string;
  /**
   * 任务开工前与远端同步（项目设置了才有）。一个任务只调用一次，在计划或直派的第一步之前。
   * 同步不了又不能在旧代码上干活时抛出 WorkspaceError，任务不开始。
   */
  syncRemote?(): Promise<SyncReport>;
  /** 进入只读的计划阶段之前调用。 */
  enterPlan(): Promise<void>;
  /** 进入执行阶段之前调用，返回任务分支名（隔离执行时）。 */
  enterExec(jobId: string): Promise<{ branch?: string }>;
  stamp(): Promise<Stamp>;
  /** 自 before 以来发生变化的文件，路径相对于 cwd，使用正斜杠。 */
  changedSince(before: Stamp): Promise<string[]>;
  /** 这些文件相对 HEAD 改了多少行（增加加删除，未跟踪的文件按行数算）。统计不出来时为 undefined。 */
  changedLines(files: string[]): Promise<number | undefined>;
  finalize(jobId: string, info: FinalizeInfo): Promise<{ branch?: string; warnings: string[] }>;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...(opts.timeoutMs && { timeout: opts.timeoutMs }), ...(opts.env && { env: opts.env }) },
      (error, stdout, stderr) => {
        const missing = error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? '找不到 git 命令' : '';
        resolve({ ok: !error, stdout: stdout ?? '', stderr: `${stderr ?? ''}${missing}` });
      },
    );
  });
}

async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.stdout.trim() : undefined;
}

async function takeStamp(cwd: string): Promise<Stamp> {
  const top = await gitTopLevel(cwd);
  if (!top) return null;
  const r = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!r.ok) return null;
  const stamp = new Map<string, string>();
  // 两边都取真实路径再求相对路径，否则短文件名与长文件名会对不上
  const topReal = realPath(top);
  const cwdReal = realPath(cwd);
  const tokens = r.stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const rel = entry.slice(3);
    // 重命名与复制的条目后面跟着一个原路径，跳过
    if (xy.includes('R') || xy.includes('C')) i++;
    const abs = path.resolve(topReal, rel);
    const key = path.relative(cwdReal, abs).replace(/\\/g, '/');
    let print = 'deleted';
    try {
      const st = fs.statSync(abs);
      print = st.isDirectory() ? 'dir' : `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      // 文件已删除
    }
    stamp.set(key, `${xy}|${print}`);
  }
  return stamp;
}

/** 见 Workspace.changedLines。二进制文件按 0 行算。 */
export async function countChangedLines(cwd: string, files: string[]): Promise<number | undefined> {
  if (files.length === 0) return 0;
  if (!(await gitTopLevel(cwd))) return undefined;
  const diff = await git(cwd, ['diff', '--numstat', '--relative', 'HEAD', '--', ...files]);
  if (!diff.ok) return undefined;
  let total = 0;
  const tracked = new Set<string>();
  for (const line of diff.stdout.split('\n')) {
    const [added, deleted, file] = line.split('\t');
    if (file === undefined) continue;
    tracked.add(file.replace(/\\/g, '/'));
    total += (Number(added) || 0) + (Number(deleted) || 0);
  }
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files]);
  if (!untracked.ok) return undefined;
  for (const file of untracked.stdout.split('\0').filter(Boolean)) {
    if (tracked.has(file)) continue;
    try {
      const buf = fs.readFileSync(path.resolve(cwd, file));
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      total += text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    } catch {
      // 读不了的按 0 行算
    }
  }
  return total;
}

function diffStamps(before: Stamp, after: Stamp): string[] {
  if (!before || !after) return [];
  const changed = new Set<string>();
  for (const [k, v] of after) if (before.get(k) !== v) changed.add(k);
  // 之前有改动、现在变干净了：说明改动被还原
  for (const k of before.keys()) if (!after.has(k)) changed.add(k);
  return [...changed].sort();
}

/** 不在允许目录内的文件。writeRoots 为空表示不限制。 */
export function outOfScope(changed: string[], writeRoots: string[]): string[] {
  if (writeRoots.length === 0) return [];
  const roots = writeRoots.map((r) => r.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  return changed.filter((file) => {
    const f = fold(file);
    return !roots.some((root) => root === '' || root === '.' || f === fold(root) || f.startsWith(`${fold(root)}/`));
  });
}

/** 访问远端的 git 命令：不弹出要人输入凭据的提示，最多等十分钟（大仓库加 LFS 可能很慢）。 */
function gitRemote(cwd: string, args: string[]): Promise<GitResult> {
  return git(cwd, args, { timeoutMs: 600000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function tail(text: string, lines = 3): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(' / ').slice(0, 500);
}

async function rebaseInProgress(cwd: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const r = await git(cwd, ['rev-parse', '--git-path', name]);
    if (r.ok && fs.existsSync(path.resolve(cwd, r.stdout.trim()))) return true;
  }
  return false;
}

/**
 * 开工前把当前分支拉到远端最新（git pull --rebase，线性历史）。
 * 不落后就什么都不做；落后且工作区干净就拉取；落后又有未提交的改动时，
 * pull 方式不替人暂存、任务不开始，pull-autostash 方式自动暂存并在拉取后放回。
 */
export async function syncWithRemote(cwd: string, mode: SyncMode): Promise<SyncReport> {
  const report: SyncReport = { notes: [], warnings: [] };
  if (mode === 'off' || !(await gitTopLevel(cwd))) return report;
  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok || !up.stdout.trim()) {
    report.warnings.push('当前分支没有对应的远端分支，开工前没有拉取。');
    return report;
  }
  const upstream = up.stdout.trim();
  const fetch = await gitRemote(cwd, ['fetch', '--quiet']);
  if (!fetch.ok) {
    report.warnings.push(`开工前连不上远端，没有拉取，在本地现有的代码上继续：${tail(fetch.stderr, 1) || '原因不明'}`);
    return report;
  }
  const behind = Number((await git(cwd, ['rev-list', '--count', 'HEAD..@{u}'])).stdout.trim()) || 0;
  if (behind === 0) {
    report.notes.push(`开工前已核对：本地不落后于 ${upstream}。`);
    return report;
  }
  // 没被 git 跟踪的新文件不妨碍拉取，只看已跟踪文件的改动
  const dirty = (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
  if (dirty.length > 0 && mode === 'pull') {
    const sample = dirty.slice(0, 3).join('、') + (dirty.length > 3 ? ' 等' : '');
    throw new WorkspaceError(
      `本地落后 ${upstream} ${behind} 个提交，工作区又有 ${dirty.length} 个文件的未提交改动（${sample}）。` +
        '项目设置为开工前先拉取、不替你暂存改动，所以任务没有开始。' +
        '请先处理这些改动（提交，或自己执行 git pull --rebase --autostash）再重试；' +
        '想让 Dario 自动暂存后拉取，把 .dario/project.yaml 的 sync_before_task 改为 pull-autostash。',
    );
  }
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  const pull = await gitRemote(cwd, ['pull', '--rebase', ...(dirty.length > 0 ? ['--autostash'] : [])]);
  if (await rebaseInProgress(cwd)) {
    await git(cwd, ['rebase', '--abort']);
    throw new WorkspaceError(
      `开工前拉取 ${upstream} 时，本地还没推送的提交与远端有冲突。已撤销这次拉取，仓库回到拉取前的状态，任务没有开始。请自己执行 git pull --rebase 处理冲突后重试。`,
    );
  }
  const unmerged = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
  if (unmerged.length > 0) {
    throw new WorkspaceError(
      `已拉取到 ${upstream} 最新，但把你的未提交改动放回去时有冲突（${unmerged.slice(0, 5).join('、')}）。` +
        '这些改动仍保存在 git stash 里，冲突处理完、确认改动完整之前不要删除它。任务没有开始。',
    );
  }
  if (!pull.ok) throw new WorkspaceError(`开工前拉取 ${upstream} 失败，任务没有开始：${tail(pull.stderr || pull.stdout)}`);
  // 拉取前后两个提交之间变化的文件。本地没推送的提交变基后内容不变，不会出现在这里
  const diff = head ? await git(cwd, ['diff', '--name-only', '--relative', '-z', head, 'HEAD']) : undefined;
  const files = diff?.ok ? diff.stdout.split('\0').filter(Boolean).sort() : [];
  if (files.length > 0) report.pulled = { upstream, commits: behind, from: head, files };
  const count = diff?.ok ? `，${files.length} 个文件有变化` : '';
  report.notes.push(`开工前已拉取 ${upstream}：前进 ${behind} 个提交${count}${dirty.length > 0 ? '，未提交的改动已自动暂存并放回' : ''}。`);
  return report;
}

/** 就地执行：在当前目录直接干，不动分支、不提交。 */
export class InPlaceWorkspace implements Workspace {
  readonly strategy = 'in-place' as const;

  constructor(
    readonly cwd: string,
    private readonly syncMode: SyncMode = 'off',
  ) {}

  syncRemote(): Promise<SyncReport> {
    return syncWithRemote(this.cwd, this.syncMode);
  }

  async enterPlan(): Promise<void> {}

  async enterExec(): Promise<{ branch?: string }> {
    return {};
  }

  stamp(): Promise<Stamp> {
    return takeStamp(this.cwd);
  }

  async changedSince(before: Stamp): Promise<string[]> {
    return diffStamps(before, await this.stamp());
  }

  changedLines(files: string[]): Promise<number | undefined> {
    return countChangedLines(this.cwd, files);
  }

  async finalize(): Promise<{ branch?: string; warnings: string[] }> {
    return { warnings: [] };
  }
}

export interface IsolatedOptions {
  /** 任务分支的起点；不填则取远端默认分支。 */
  baseBranch?: string;
  /** 明确禁止用作隔离克隆的路径。 */
  forbiddenPaths: string[];
}

export const PUSH_DISABLED_URL = 'DISABLED_BY_DARIO';

/** 隔离执行：独立克隆、每个任务一个本地分支、禁止推送、由 Dario 做快照提交。 */
export class IsolatedWorkspace implements Workspace {
  readonly strategy = 'isolated' as const;
  private branch?: string;

  constructor(
    readonly cwd: string,
    private readonly opts: IsolatedOptions,
  ) {}

  /** 检查这份克隆可以安全地用于隔离执行，并确保推送已被禁用。 */
  async assertSafe(): Promise<void> {
    const here = normPath(this.cwd);
    for (const p of this.opts.forbiddenPaths) {
      if (normPath(p) === here) throw new WorkspaceError(`这个目录被配置为禁止用于隔离执行：${this.cwd}`);
    }
    const top = await gitTopLevel(this.cwd);
    if (!top) throw new WorkspaceError(`隔离执行的目录不是 git 仓库：${this.cwd}`);
    if (normPath(top) !== here) throw new WorkspaceError(`隔离执行的目录必须是仓库根目录：${this.cwd}（仓库根是 ${top}）`);
    if (!(await git(this.cwd, ['remote', 'get-url', 'origin'])).ok) {
      throw new WorkspaceError(`隔离克隆没有名为 origin 的远端：${this.cwd}`);
    }
    const push = await git(this.cwd, ['remote', 'get-url', '--push', 'origin']);
    if (push.stdout.trim() !== PUSH_DISABLED_URL) {
      const set = await git(this.cwd, ['remote', 'set-url', '--push', 'origin', PUSH_DISABLED_URL]);
      if (!set.ok) throw new WorkspaceError(`无法禁用隔离克隆的推送：${set.stderr.trim()}`);
    }
  }

  private async base(): Promise<string> {
    if (this.opts.baseBranch) return this.opts.baseBranch;
    const head = await git(this.cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head.ok && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '');
    return 'main';
  }

  private async assertClean(): Promise<void> {
    const st = await git(this.cwd, ['status', '--porcelain']);
    if (!st.ok) throw new WorkspaceError(`无法读取隔离克隆的状态：${st.stderr.trim()}`);
    if (st.stdout.trim()) {
      throw new WorkspaceError(`隔离克隆里有未处理的改动，任务没有开始。请先处理：${this.cwd}`);
    }
  }

  private async sync(): Promise<string> {
    await this.assertSafe();
    await this.assertClean();
    const fetch = await git(this.cwd, ['fetch', '--prune', 'origin']);
    if (!fetch.ok) throw new WorkspaceError(`拉取远端失败：${fetch.stderr.trim()}`);
    const ref = `origin/${await this.base()}`;
    if (!(await git(this.cwd, ['rev-parse', '--verify', '--quiet', ref])).ok) {
      throw new WorkspaceError(`远端没有分支 ${ref}。请在渠道配置里设置 base_branch。`);
    }
    return ref;
  }

  async enterPlan(): Promise<void> {
    const ref = await this.sync();
    const co = await git(this.cwd, ['checkout', '--detach', ref]);
    if (!co.ok) throw new WorkspaceError(`切换到 ${ref} 失败：${co.stderr.trim()}`);
  }

  async enterExec(jobId: string): Promise<{ branch?: string }> {
    const ref = await this.sync();
    const branch = `dario/${jobId}`;
    const co = await git(this.cwd, ['checkout', '-B', branch, ref]);
    if (!co.ok) throw new WorkspaceError(`创建任务分支 ${branch} 失败：${co.stderr.trim()}`);
    this.branch = branch;
    return { branch };
  }

  stamp(): Promise<Stamp> {
    return takeStamp(this.cwd);
  }

  async changedSince(before: Stamp): Promise<string[]> {
    return diffStamps(before, await this.stamp());
  }

  changedLines(files: string[]): Promise<number | undefined> {
    return countChangedLines(this.cwd, files);
  }

  async finalize(jobId: string, info: FinalizeInfo): Promise<{ branch?: string; warnings: string[] }> {
    const warnings: string[] = [];
    const branch = this.branch;
    if (!branch) return { warnings };
    const dirty = (await git(this.cwd, ['status', '--porcelain'])).stdout.trim() !== '';
    if (info.violation) {
      warnings.push(`存在越界改动，没有生成快照。改动原样留在 ${this.cwd}（分支 ${branch}），处理之前这份克隆不会接新任务。`);
      return { branch, warnings };
    }
    if (!dirty) {
      // 没有产出：回到远端基线并删掉空分支，避免堆积
      await git(this.cwd, ['checkout', '--detach', `origin/${await this.base()}`]);
      await git(this.cwd, ['branch', '-D', branch]);
      return { warnings };
    }
    const add = await git(this.cwd, ['add', '-A']);
    if (!add.ok) {
      warnings.push(`暂存改动失败，没有生成快照：${add.stderr.trim()}`);
      return { branch, warnings };
    }
    const identity: string[] = [];
    if (!(await git(this.cwd, ['config', 'user.name'])).stdout.trim()) identity.push('-c', 'user.name=Dario');
    if (!(await git(this.cwd, ['config', 'user.email'])).stdout.trim()) identity.push('-c', 'user.email=dario@localhost');
    const commit = await git(this.cwd, [...identity, 'commit', '-m', `chore(dario): 任务 ${jobId} 产出快照`]);
    if (!commit.ok) {
      warnings.push(`快照提交失败，改动留在工作区（分支 ${branch}）：${(commit.stderr || commit.stdout).trim().slice(0, 500)}`);
    }
    return { branch, warnings };
  }
}

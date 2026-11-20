import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Strategy } from './types.js';
import { DarioError, normPath, realPath } from './util.js';

export class WorkspaceError extends DarioError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'WorkspaceError';
  }
}

/** 某一时刻"有改动的文件"的指纹；目录不是 git 仓库时为 null，表示无法检测。 */
export type Stamp = Map<string, string> | null;

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
  /** 进入只读的计划阶段之前调用。 */
  enterPlan(): Promise<void>;
  /** 进入执行阶段之前调用，返回任务分支名（隔离执行时）。 */
  enterExec(jobId: string): Promise<{ branch?: string }>;
  stamp(): Promise<Stamp>;
  /** 自 before 以来发生变化的文件，路径相对于 cwd，使用正斜杠。 */
  changedSince(before: Stamp): Promise<string[]>;
  finalize(jobId: string, info: FinalizeInfo): Promise<{ branch?: string; warnings: string[] }>;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
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

/** 就地执行：在当前目录直接干，不动分支、不提交。 */
export class InPlaceWorkspace implements Workspace {
  readonly strategy = 'in-place' as const;

  constructor(readonly cwd: string) {}

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

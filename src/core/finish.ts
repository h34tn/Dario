/**
 * 收尾用到的 git 操作：找推送目标、记下审过的内容、核对提交的正是审过的内容、推送。
 *
 * "审过的内容"按文件记两个 git 对象号：审查时 HEAD 里的内容（基准）和审过的内容。
 * 核对时取本任务提交前后的同样两个对象号：两边相同就是一致；不同时（远端在同一个文件上也有改动、
 * 解决过冲突）比较两边改动的正文，去掉文件头和行号、空白不计，与 git patch-id 的口径相同。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FinishRecord, ReviewedFile } from './types.js';
import { realPath } from './util.js';
import { git, gitRemote, gitTopLevel, PUSH_DISABLED_URL } from './workspace.js';

/** git 的空文件对象号，用来和"文件不存在"做 diff。 */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** 收尾的提交与同步那一轮里拦截的命令：推送只由 Dario 做。 */
export const PUSH_COMMANDS = ['git push'];

/** 推送的目标。 */
export interface PushTarget {
  /** 远端名，用于显示，以及没有 url 时用来推送。 */
  remote: string;
  /** 远端分支名，不带 refs/heads/。 */
  branch: string;
  /** 本地对应的远端跟踪引用，例如 refs/remotes/origin/main。 */
  trackingRef: string;
  /** 推送时直接写在命令里的地址（隔离执行时克隆的推送地址是无效的）。不填则用远端名。 */
  url?: string;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function tail(text: string): string {
  return lines(text).slice(-3).join(' / ').slice(0, 500);
}

export async function headSha(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

/** 当前分支名；HEAD 是游离的时为 undefined。 */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

/** 就地执行的推送目标：当前分支的远端分支。没有时返回原因。 */
export async function upstreamTarget(cwd: string): Promise<PushTarget | string> {
  if (!(await headSha(cwd))) return '目录不是 git 仓库，或者仓库里还没有提交';
  const branch = await currentBranch(cwd);
  if (!branch) return 'HEAD 是游离的，不在任何分支上';
  const remote = (await git(cwd, ['config', `branch.${branch}.remote`])).stdout.trim();
  const merge = (await git(cwd, ['config', `branch.${branch}.merge`])).stdout.trim();
  const tracking = (await git(cwd, ['rev-parse', '--symbolic-full-name', '@{u}'])).stdout.trim();
  if (!remote || remote === '.' || !merge.startsWith('refs/heads/') || !tracking) return `当前分支 ${branch} 没有对应的远端分支`;
  return { remote, branch: merge.slice('refs/heads/'.length), trackingRef: tracking };
}

/** from..HEAD 之间的提交数；取不到时为 undefined。 */
export async function countBetween(cwd: string, from: string, to = 'HEAD'): Promise<number | undefined> {
  const r = await git(cwd, ['rev-list', '--count', `${from}..${to}`]);
  return r.ok ? Number(r.stdout.trim()) || 0 : undefined;
}

/** 文件在某个提交里的对象号；文件不存在时为 null。file 相对项目根目录。 */
async function blobAt(cwd: string, rev: string, file: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}:./${file}`]);
  return r.ok ? r.stdout.trim() || null : null;
}

/** 工作区里文件的内容写进 git 对象库，返回对象号；文件不存在时为 null。按文件路径套用换行等过滤规则，与提交时一致。 */
async function worktreeBlob(cwd: string, file: string): Promise<string | null> {
  const r = await git(cwd, ['hash-object', '-w', '--', file]);
  return r.ok ? r.stdout.trim() || null : null;
}

/** 工作区里这些文件此刻的内容写进 git 对象库，返回各自的对象号；文件不存在时为 null。 */
export async function snapshotBlobs(cwd: string, files: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const present = files.filter((f) => {
    try {
      return fs.statSync(path.resolve(cwd, f)).isFile();
    } catch {
      out[f] = null;
      return false;
    }
  });
  // 分批传，避免命令行过长
  for (let i = 0; i < present.length; i += 100) {
    const batch = present.slice(i, i + 100);
    const r = await git(cwd, ['hash-object', '-w', '--', ...batch]);
    const ids = r.ok ? lines(r.stdout) : [];
    batch.forEach((f, j) => {
      if (ids[j]) out[f] = ids[j]!;
    });
  }
  return out;
}

/** 记下这些文件审过的内容：此刻 HEAD 里的内容和工作区里的内容。内容与 HEAD 相同（改了又改回去）的不算。 */
export async function recordReviewed(cwd: string, files: string[]): Promise<Record<string, ReviewedFile>> {
  const out: Record<string, ReviewedFile> = {};
  for (const file of files) {
    const base = await blobAt(cwd, 'HEAD', file);
    const blob = await worktreeBlob(cwd, file);
    if (base !== blob) out[file] = { base, blob };
  }
  return out;
}

/** 两个提交之间改动的文件，相对项目根目录、正斜杠；项目根目录之外的以 ../ 开头。 */
async function filesBetween(cwd: string, from: string, to: string): Promise<string[] | undefined> {
  const top = await gitTopLevel(cwd);
  const r = await git(cwd, ['diff', '--name-only', '--no-renames', '-z', from, to]);
  if (!top || !r.ok) return undefined;
  const topReal = realPath(top);
  const cwdReal = realPath(cwd);
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .map((rel) => path.relative(cwdReal, path.resolve(topReal, rel)).replace(/\\/g, '/'))
    .sort();
}

/** 两个对象之间的 diff 正文。 */
async function blobDiff(cwd: string, a: string | null, b: string | null): Promise<string | undefined> {
  const r = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', a ?? EMPTY_BLOB, b ?? EMPTY_BLOB]);
  return r.ok ? r.stdout : undefined;
}

/**
 * 一次改动的比较口径：只留增删和上下文行，去掉文件头和行号，空白不计；再加上文件是新建还是删除。
 * 二进制文件、取不到 diff 时为 undefined，表示没法这样比。
 */
async function changeKey(cwd: string, f: ReviewedFile): Promise<string | undefined> {
  if (f.base === f.blob) return '';
  const diff = await blobDiff(cwd, f.base, f.blob);
  if (diff === undefined || /^Binary files /m.test(diff)) return undefined;
  const body = diff
    .split('\n')
    .filter((l) => /^[ +-]/.test(l) && !l.startsWith('+++') && !l.startsWith('---'))
    .map((l) => l[0] + l.slice(1).replace(/\s+/g, ''));
  return `${f.base === null ? 'new\n' : ''}${f.blob === null ? 'deleted\n' : ''}${body.join('\n')}`;
}

export interface Mismatch {
  file: string;
  reviewed?: ReviewedFile;
  now: ReviewedFile;
}

export interface Verification {
  /** 本任务的提交数。 */
  commits: number;
  /** HEAD 落后于基准多少个提交（只在推送时有意义）。 */
  behind: number;
  /** 提交里有、但没审过的文件，以及和审过的内容对不上的文件。 */
  mismatched: Mismatch[];
  /** 本任务的提交改动的文件。 */
  files: string[];
  /** 审过、但没有进提交的文件。 */
  left: string[];
}

/** 核对 base..HEAD 之间的提交与审过的内容。取不到 git 信息时返回原因。 */
export async function verifyCommits(cwd: string, base: string, reviewed: Record<string, ReviewedFile>, behindRef?: string): Promise<Verification | string> {
  const commits = await countBetween(cwd, base);
  const files = await filesBetween(cwd, base, 'HEAD');
  if (commits === undefined || files === undefined) return `读不出 ${base} 之后的提交`;
  const behind = behindRef ? ((await countBetween(cwd, 'HEAD', behindRef)) ?? 0) : 0;
  const mismatched: Mismatch[] = [];
  for (const file of files) {
    const now = { base: await blobAt(cwd, base, file), blob: await blobAt(cwd, 'HEAD', file) };
    const r = reviewed[file];
    if (!r) {
      mismatched.push({ file, now });
      continue;
    }
    if (r.base === now.base && r.blob === now.blob) continue;
    const want = await changeKey(cwd, r);
    if (want === undefined || want !== (await changeKey(cwd, now))) mismatched.push({ file, reviewed: r, now });
  }
  const committed = new Set(files);
  const left = Object.keys(reviewed).filter((f) => !committed.has(f)).sort();
  return { commits, behind, mismatched, left, files };
}

/** 复审用：对不上的文件审过时的 diff 和现在提交里的 diff。 */
export async function mismatchDiff(cwd: string, items: Mismatch[], maxChars: number): Promise<string> {
  const parts: string[] = [];
  for (const m of items) {
    const now = (await blobDiff(cwd, m.now.base, m.now.blob)) ?? '（取不到 diff）';
    const before = m.reviewed ? ((await blobDiff(cwd, m.reviewed.base, m.reviewed.blob)) ?? '（取不到 diff）') : undefined;
    parts.push(
      `## ${m.file}\n` +
        (before !== undefined ? `### 审过时的改动\n\`\`\`diff\n${before.trim()}\n\`\`\`\n` : '审查时没有改动这个文件。\n') +
        `### 现在提交里的改动\n\`\`\`diff\n${now.trim()}\n\`\`\``,
    );
  }
  const text = parts.join('\n\n');
  return maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}\n……（超出长度上限，其余请用 git 自己查看）` : text;
}

/** 复审通过后：这些文件现在的内容记为审过的内容。 */
export function acceptMismatches(reviewed: Record<string, ReviewedFile>, items: Mismatch[]): void {
  for (const m of items) reviewed[m.file] = { ...m.now };
}

/** base..HEAD 之间的提交，从早到晚。 */
export async function commitsBetween(cwd: string, base: string): Promise<Array<{ sha: string; subject: string }>> {
  const r = await git(cwd, ['log', '--reverse', '--format=%h%x09%s', `${base}..HEAD`]);
  if (!r.ok) return [];
  return lines(r.stdout).map((l) => {
    const [sha, ...rest] = l.split('\t');
    return { sha: sha!, subject: rest.join('\t') };
  });
}

/** 取远端最新（核对之前）。连不上时返回原因。 */
export async function fetchTarget(cwd: string, target: PushTarget): Promise<string | undefined> {
  const r = await gitRemote(cwd, ['fetch', '--quiet', target.remote]);
  return r.ok ? undefined : `连不上远端：${tail(r.stderr) || '原因不明'}`;
}

export type PushResult = { ok: true; head: string } | { ok: false; behind: boolean; reason: string };

/** 推送 HEAD 到目标分支。不强制推送，不跳过钩子。推送后确认远端分支指向推送的提交。 */
export async function pushHead(cwd: string, target: PushTarget): Promise<PushResult> {
  const head = await headSha(cwd);
  if (!head) return { ok: false, behind: false, reason: '读不出 HEAD' };
  const where = target.url ?? target.remote;
  const r = await gitRemote(cwd, ['push', '--porcelain', where, `HEAD:refs/heads/${target.branch}`]);
  if (!r.ok) {
    const out = `${r.stdout}\n${r.stderr}`;
    const behind = /non-fast-forward|fetch first|\(stale info\)/i.test(out);
    return { ok: false, behind, reason: tail(r.stderr) || tail(r.stdout) || '原因不明' };
  }
  const ls = await gitRemote(cwd, ['ls-remote', where, `refs/heads/${target.branch}`]);
  const remoteHead = ls.ok ? ls.stdout.trim().split(/\s+/)[0] : undefined;
  if (remoteHead !== head) {
    return { ok: false, behind: false, reason: `推送命令成功了，但远端分支 ${target.branch} 现在指向 ${remoteHead || '（取不到）'}，不是推送的 ${head}` };
  }
  // 让本地的远端跟踪引用跟上，之后 git status 不再显示"领先"
  if (!target.url) await gitRemote(cwd, ['fetch', '--quiet', target.remote]);
  return { ok: true, head };
}

/**
 * 收尾的提交与同步那一轮给 AI 的环境变量：用命令级的 git 配置把各远端的推送地址临时设成无效值。
 * 远端自己配了 pushurl 时这一项是追加而不是替换，挡不住；这只防 AI 顺手推送，不是安全边界。
 */
export async function pushBlockEnv(cwd: string): Promise<Record<string, string>> {
  const remotes = lines((await git(cwd, ['remote'])).stdout);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(remotes.length) };
  remotes.forEach((remote, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `remote.${remote}.pushurl`;
    env[`GIT_CONFIG_VALUE_${i}`] = PUSH_DISABLED_URL;
  });
  return env;
}

/** 计划确认时写在计划下面的一句：结束后会做什么。 */
export function finishNote(mode: 'commit' | 'push', target: PushTarget | string, isolated: boolean): string {
  if (mode === 'commit') return `结束后：审查通过后由主控提交到${isolated ? '任务分支' : '当前分支'}，不推送。`;
  if (typeof target === 'string') return `结束后：审查通过后由主控提交，不推送（${target}）。`;
  const where = `${target.remote}/${target.branch}`;
  return `结束后：审查通过后由主控提交、与 ${where} 同步，Dario 核对提交的正是审过的内容后推送到 ${where}。`;
}

/** 收尾的结果，接在结论后面给人看。 */
export function describeFinish(rec: FinishRecord): string {
  const list = rec.commits.map((c) => `- ${c.sha} ${c.subject}`).join('\n');
  if (rec.outcome === 'skipped') return `没有收尾：${rec.reason ?? '原因不明'}。`;
  if (rec.outcome !== 'done') return `收尾没有做成：${rec.reason ?? '原因不明'}。`;
  if (rec.pushed) return `已提交并推送到 ${rec.pushed.remote}/${rec.pushed.branch}（${rec.pushed.head.slice(0, 7)}）：\n${list}`;
  return `已提交，没有推送：\n${list}`;
}

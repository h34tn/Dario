/**
 * 交接时附上的上下文：主控出计划时标出的代码位置（PlanStep.refs），以及给审查看的改动 diff。
 * 目的是让接手的角色不必再从头搜索、逐个打开文件，就能看到上一方已经看过或改过的内容。
 * 两者都有长度上限（handoff_max_chars），超出的部分只列名字，让接手的角色自己去看。
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeScopePath } from './scope.js';
import { git } from './workspace.js';

/** 计划里一处代码位置："文件"、"文件:行"或"文件:起-止"。 */
export interface CodeRef {
  path: string;
  start?: number;
  end?: number;
}

export function parseRef(text: string): CodeRef | undefined {
  const m = text.trim().match(/^(.*?)(?::(\d+)(?:\s*[-–~]\s*(\d+))?)?$/);
  const file = m ? normalizeScopePath(m[1]!) : '';
  if (!file) return undefined;
  if (m![2] === undefined) return { path: file };
  const a = Number(m![2]);
  const b = m![3] === undefined ? a : Number(m![3]);
  return { path: file, start: Math.max(1, Math.min(a, b)), end: Math.max(1, a, b) };
}

/** 计划里的写法整理一遍：去重、去掉写不出文件名的。 */
export function normalizeRefs(refs: string[]): string[] {
  const out: string[] = [];
  for (const r of refs) {
    const ref = parseRef(r);
    if (!ref) continue;
    const text = ref.start === undefined ? ref.path : ref.start === ref.end ? `${ref.path}:${ref.start}` : `${ref.path}:${ref.start}-${ref.end}`;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** 围住一段内容的反引号：比内容里最长的一串反引号多一个，至少三个。 */
function fence(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function block(title: string, body: string): string {
  const f = fence(body);
  return `## ${title}\n${f}\n${body.endsWith('\n') ? body : `${body}\n`}${f}`;
}

const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);

/** 落在 root 之内的绝对路径；越出项目目录的引用不读。 */
function inside(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  return back && !back.startsWith('..') && !path.isAbsolute(back) ? abs : undefined;
}

/**
 * 读出 refs 指向的代码，拼成附给接手角色的一段。读的是派活这一刻的内容；
 * changed 里的文件已经被前面的步骤改过，行号可能有偏移，要说明。全部读不出来时返回 undefined。
 */
export function readRefs(root: string, refs: string[], maxChars: number, changed: string[] = []): string | undefined {
  if (maxChars <= 0 || refs.length === 0) return undefined;
  const changedSet = new Set(changed.map((f) => fold(normalizeScopePath(f))));
  const parts: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  let used = 0;
  for (const text of refs) {
    const ref = parseRef(text);
    if (!ref) continue;
    const abs = inside(root, ref.path);
    let content: string;
    try {
      if (!abs) throw new Error('outside');
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) throw new Error('binary');
      content = buf.toString('utf8');
    } catch {
      missing.push(text);
      continue;
    }
    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const start = ref.start ?? 1;
    const end = Math.min(ref.end ?? lines.length, lines.length);
    if (start > end) {
      missing.push(text);
      continue;
    }
    const range = ref.start === undefined ? '全文' : start === end ? `第 ${start} 行` : `第 ${start}-${end} 行`;
    const shifted = changedSet.has(fold(ref.path)) ? '（前面的步骤改过这个文件，行号可能已有偏移，下面是现在这几行的内容）' : '';
    let body = lines.slice(start - 1, end).join('\n');
    const room = maxChars - used;
    let cut = false;
    if (body.length + 80 > room) {
      // 放不下：剩下的地方还够看个开头就截断附上，否则只列名字
      if (room < 1000) {
        skipped.push(text);
        continue;
      }
      body = body.slice(0, room - 200);
      body = body.slice(0, Math.max(0, body.lastIndexOf('\n')));
      cut = true;
    }
    const part = block(`${ref.path} ${range}${shifted}`, body) + (cut ? '\n（超出长度上限，后面的内容没有附上，请自己打开文件看）' : '');
    parts.push(part);
    // 截断过就算用满：后面的只列名字，不再挤进剩下的零头
    used = cut ? maxChars : used + part.length;
  }
  const notes: string[] = [];
  if (skipped.length) notes.push(`超出长度上限没有附上：${skipped.join('、')}，需要时请自己打开。`);
  if (missing.length) notes.push(`读不出来（文件不存在、行号超出范围、二进制文件或在项目目录之外）：${missing.join('、')}。`);
  if (parts.length === 0 && notes.length === 0) return undefined;
  const intro = '主控出计划时读过、认为你动手时要看的代码，下面是 Dario 派活时读出的当前内容。动手前不必再为找到它们而搜索；要改的地方仍以文件里的实际内容为准。';
  return [intro, ...parts, ...notes].join('\n\n');
}

/** 一个文件的 diff。 */
interface FileDiff {
  file: string;
  text: string;
}

function splitDiff(out: string): FileDiff[] {
  const chunks: FileDiff[] = [];
  for (const piece of out.split(/^(?=diff --git )/m)) {
    if (!piece.startsWith('diff --git ')) continue;
    const m = piece.match(/^\+\+\+ b\/(.*)$/m) ?? piece.match(/^--- a\/(.*)$/m) ?? piece.match(/^diff --git a\/(.*?) b\//);
    chunks.push({ file: m ? m[1]!.trim() : '', text: piece.replace(/\n+$/, '') });
  }
  return chunks;
}

/** 没被 git 跟踪的新文件，写成和 git diff 一样的样子。 */
function newFileDiff(root: string, file: string): FileDiff {
  const header = `diff --git a/${file} b/${file}\nnew file（未跟踪）\n--- /dev/null\n+++ b/${file}`;
  try {
    const buf = fs.readFileSync(path.resolve(root, file));
    if (buf.includes(0)) return { file, text: `${header}\n（二进制文件，${buf.length} 字节）` };
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return { file, text: `${header}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}` };
  } catch {
    return { file, text: `${header}\n（读不出来）` };
  }
}

export interface DiffText {
  /** 附上的 diff，已按长度上限截好。 */
  text: string;
  /** 没能附上 diff（或只附了一部分）的文件。 */
  omitted: string[];
}

/**
 * 这些文件相对 HEAD 的改动（未跟踪的新文件按全文算）。不是 git 仓库、没有提交或 git 出错时返回 undefined，
 * 调用方照旧让角色自己去看。maxChars 为 0 表示不附。
 */
export async function diffText(cwd: string, files: string[], maxChars: number): Promise<DiffText | undefined> {
  if (maxChars <= 0 || files.length === 0) return undefined;
  const tracked = await git(cwd, ['diff', '--relative', '--no-color', '--no-ext-diff', 'HEAD', '--', ...files]);
  if (!tracked.ok) return undefined;
  const chunks = splitDiff(tracked.stdout);
  const seen = new Set(chunks.map((c) => c.file));
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files]);
  if (!untracked.ok) return undefined;
  for (const file of untracked.stdout.split('\0').filter(Boolean)) {
    if (!seen.has(file)) chunks.push(newFileDiff(cwd, file));
  }
  if (chunks.length === 0) return undefined;
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const c of chunks) {
    const room = maxChars - used;
    if (omitted.length === 0 && c.text.length + 1 <= room) {
      kept.push(c.text);
      used += c.text.length + 1;
      continue;
    }
    // 第一个放不下的文件：剩下的地方还够就附上开头一段
    if (omitted.length === 0 && room >= 1000) {
      const head = c.text.slice(0, room - 100);
      kept.push(`${head.slice(0, Math.max(0, head.lastIndexOf('\n')))}\n……（这个文件的 diff 超出长度上限，后面没有附上）`);
      used = maxChars;
    }
    omitted.push(c.file);
  }
  if (kept.length === 0) return { text: '', omitted };
  const body = kept.join('\n');
  const f = fence(body);
  return { text: `${f}diff\n${body}\n${f}`, omitted };
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncWithRemote, WorkspaceError } from '../src/core/workspace.js';

/** 一个远端裸仓库、一份"我的"克隆、一份"同事的"克隆。 */
let root: string;
let mine: string;
let theirs: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function clone(name: string): string {
  const dir = path.join(root, name);
  // 换行转换要在检出之前关掉，否则 Windows 上检出的文件一上来就算"有改动"
  git(root, 'clone', '--quiet', '--config', 'core.autocrlf=false', path.join(root, 'remote.git'), name);
  git(dir, 'config', 'user.name', name);
  git(dir, 'config', 'user.email', `${name}@example.com`);
  return dir;
}

function commit(dir: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '--quiet', '-m', message);
}

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-sync-'));
  git(root, 'init', '--quiet', '--bare', '-b', 'main', 'remote.git');
  theirs = clone('theirs');
  commit(theirs, 'a.txt', '1\n', '初始');
  commit(theirs, 'b.txt', '1\n', '第二个文件');
  git(theirs, 'push', '--quiet', '-u', 'origin', 'main');
  mine = clone('mine');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 同事往远端推了一个提交。 */
function remoteAdvances(file = 'a.txt', content = '2\n'): void {
  commit(theirs, file, content, '同事的改动');
  git(theirs, 'push', '--quiet');
}

describe('开工前与远端同步', () => {
  it('off：什么都不做', async () => {
    remoteAdvances();
    expect(await syncWithRemote(mine, 'off')).toEqual({ notes: [], warnings: [] });
    expect(read(mine, 'a.txt')).toBe('1\n');
  });

  it('不落后：只核对，不改动仓库', async () => {
    const report = await syncWithRemote(mine, 'pull');
    expect(report.warnings).toEqual([]);
    expect(report.notes[0]).toContain('不落后于 origin/main');
  });

  it('落后且工作区干净：拉到最新', async () => {
    remoteAdvances();
    const report = await syncWithRemote(mine, 'pull');
    expect(report.notes[0]).toContain('前进 1 个提交');
    expect(read(mine, 'a.txt')).toBe('2\n');
  });

  it('本地有没推送的提交：变基到远端之上，不产生合并提交', async () => {
    commit(mine, 'c.txt', '我的\n', '我的提交');
    remoteAdvances();
    await syncWithRemote(mine, 'pull');
    expect(read(mine, 'a.txt')).toBe('2\n');
    expect(git(mine, 'log', '--format=%s', '-2')).toBe('我的提交\n同事的改动');
    expect(git(mine, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
  });

  it('pull：落后又有未提交的改动，不替人暂存，任务不开始', async () => {
    remoteAdvances();
    fs.writeFileSync(path.join(mine, 'b.txt'), '我改的\n');
    await expect(syncWithRemote(mine, 'pull')).rejects.toThrow(WorkspaceError);
    await expect(syncWithRemote(mine, 'pull')).rejects.toThrow(/落后 origin\/main 1 个提交.*b\.txt.*pull-autostash/s);
    // 仓库原样：没有拉取，改动还在，也没有留下暂存
    expect(read(mine, 'a.txt')).toBe('1\n');
    expect(read(mine, 'b.txt')).toBe('我改的\n');
    expect(git(mine, 'stash', 'list')).toBe('');
  });

  it('pull：有未提交的改动但不落后，照常继续', async () => {
    fs.writeFileSync(path.join(mine, 'b.txt'), '我改的\n');
    const report = await syncWithRemote(mine, 'pull');
    expect(report.notes[0]).toContain('不落后');
  });

  it('pull：只有没被跟踪的新文件不算未提交的改动', async () => {
    remoteAdvances();
    fs.writeFileSync(path.join(mine, 'new.txt'), '新文件\n');
    await syncWithRemote(mine, 'pull');
    expect(read(mine, 'a.txt')).toBe('2\n');
    expect(read(mine, 'new.txt')).toBe('新文件\n');
  });

  it('pull-autostash：自动暂存，拉取后把改动放回', async () => {
    remoteAdvances();
    fs.writeFileSync(path.join(mine, 'b.txt'), '我改的\n');
    const report = await syncWithRemote(mine, 'pull-autostash');
    expect(report.notes[0]).toContain('自动暂存并放回');
    expect(read(mine, 'a.txt')).toBe('2\n');
    expect(read(mine, 'b.txt')).toBe('我改的\n');
    expect(git(mine, 'stash', 'list')).toBe('');
  });

  it('pull-autostash：放回改动时冲突，任务不开始，改动留在暂存里', async () => {
    remoteAdvances('a.txt', '同事改的\n');
    fs.writeFileSync(path.join(mine, 'a.txt'), '我改的\n');
    await expect(syncWithRemote(mine, 'pull-autostash')).rejects.toThrow(/放回去时有冲突.*a\.txt.*git stash/s);
    expect(git(mine, 'stash', 'list')).not.toBe('');
  });

  it('本地提交与远端冲突：撤销拉取，仓库回到原状，任务不开始', async () => {
    commit(mine, 'a.txt', '我的版本\n', '我的提交');
    const before = git(mine, 'rev-parse', 'HEAD');
    remoteAdvances('a.txt', '同事的版本\n');
    await expect(syncWithRemote(mine, 'pull')).rejects.toThrow(/有冲突.*已撤销/s);
    expect(git(mine, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(mine, 'status', '--porcelain')).toBe('');
  });

  it('没有远端分支、连不上远端：提醒后在本地代码上继续', async () => {
    git(mine, 'checkout', '--quiet', '-b', 'local-only');
    expect((await syncWithRemote(mine, 'pull')).warnings[0]).toContain('没有对应的远端分支');
    git(mine, 'checkout', '--quiet', 'main');
    git(mine, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
    expect((await syncWithRemote(mine, 'pull')).warnings[0]).toContain('连不上远端');
  });

  it('不是 git 仓库：跳过', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-plain-'));
    try {
      expect(await syncWithRemote(plain, 'pull')).toEqual({ notes: [], warnings: [] });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

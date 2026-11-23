import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReviewed, verifyCommits, pushHead } from '../src/core/finish.js';
import { StepWatch } from '../src/core/watch.js';
import { loadProjectConfig } from '../src/core/config.js';
import { IsolatedWorkspace, PUSH_DISABLED_URL } from '../src/core/workspace.js';
import { gitInit, plan, Sandbox, sh, verdict } from './helpers.js';

const PUSH = 'finish: { mode: push, instructions: 按功能分组提交 }\n';

/** 给沙箱的项目接上一个远端裸仓库，再克隆一份"同事的"仓库。 */
function withRemote(sb: Sandbox): { remote: string; theirs: string } {
  const remote = path.join(sb.dir, 'remote.git');
  sh(sb.dir, 'git', ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(sb.project, 'git', ['remote', 'add', 'origin', remote]);
  sh(sb.project, 'git', ['push', '-q', '-u', 'origin', 'main']);
  const theirs = path.join(sb.dir, 'theirs');
  sh(sb.dir, 'git', ['clone', '-q', '--config', 'core.autocrlf=false', remote, theirs]);
  sh(theirs, 'git', ['config', 'user.name', 'theirs']);
  sh(theirs, 'git', ['config', 'user.email', 'theirs@example.com']);
  return { remote, theirs };
}

/** 同事往远端推了一个提交。 */
function theirsPush(theirs: string, file: string, content: string, message = '同事的改动'): void {
  fs.writeFileSync(path.join(theirs, file), content);
  sh(theirs, 'git', ['add', file]);
  sh(theirs, 'git', ['commit', '-q', '-m', message]);
  sh(theirs, 'git', ['push', '-q', 'origin', 'HEAD:main']);
}

const remoteHead = (sb: Sandbox, remote: string): string => sh(sb.dir, 'git', ['--git-dir', remote, 'rev-parse', 'main']).trim();
const remoteLog = (sb: Sandbox, remote: string): string[] => sh(sb.dir, 'git', ['--git-dir', remote, 'log', '--format=%s', 'main']).trim().split('\n');
const head = (dir: string): string => sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
const commitA = [['git', 'add', 'a.txt'], ['git', 'commit', '-q', '-m', 'feat: 加 a']];
const writeA = { text: '写好了', files: [{ path: 'a.txt', content: 'a\n' }] };
const planA = { text: plan([{ role: 'coder', task: '加 a.txt', writes: true }]) };

describe('收尾', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('push：主控提交，Dario 核对后推送到当前分支的远端分支', async () => {
    sb = new Sandbox({ git: true, projectYaml: PUSH });
    const { remote } = withRemote(sb);
    sb.setScenario({
      a1: [planA, { text: '分成一个提交', commands: commitA }, { text: '汇总' }],
      a2: [writeA],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review', 'finish', 'summary']);
    expect(r.json.finish).toMatchObject({ mode: 'push', outcome: 'done', rounds: 1, reason: null, pushed: { remote: 'origin', branch: 'main' } });
    expect(r.json.finish.commits.map((c: any) => c.subject)).toEqual(['feat: 加 a']);
    expect(r.json.finish.pushed.head).toBe(head(sb.project));
    expect(remoteHead(sb, remote)).toBe(head(sb.project));
    expect(r.json.conclusion).toContain('已提交并推送到 origin/main');
    expect(r.json.steps[3].changed_files).toEqual(['a.txt']);
    // 计划确认时写明了结束后会做什么
    expect(r.err).toContain('结束后：审查通过后由主控提交、与 origin/main 同步');
    // 收尾那一轮：可写，带着项目的收尾说明和要提交的文件，推送地址被临时禁用
    const call = sb.calls().filter((c) => c.name === 'a1')[1]!;
    expect(call.access).toBe('write');
    expect(call.prompt).toContain('按功能分组提交');
    expect(call.prompt).toContain('# 要提交的文件\n- a.txt');
    expect(call.envNames).toContain('GIT_CONFIG_COUNT');
    // 出计划时主控就知道提交与推送不用列为步骤
    expect(sb.calls()[0]!.prompt).toContain('不要把提交、推送列为步骤');
  });

  it('收尾那一轮里 AI 自己推送推不出去，最终由 Dario 推送', async () => {
    sb = new Sandbox({ git: true, projectYaml: PUSH });
    const { remote } = withRemote(sb);
    sb.setScenario({
      a1: [planA, { text: '提交并推送了', commands: [...commitA, ['git', 'push', 'origin', 'HEAD:main']] }, { text: '汇总' }],
      a2: [writeA],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(fs.readFileSync(`${sb.scenarioFile}.commands.log`, 'utf8')).toContain('git push origin HEAD:main');
    expect(r.code).toBe(0);
    expect(r.json.finish.outcome).toBe('done');
    expect(remoteHead(sb, remote)).toBe(head(sb.project));
  });

  it('远端在别的文件上有新提交：主控同步后推送，提交与审过的一致，不复审', async () => {
    sb = new Sandbox({ git: true, projectYaml: PUSH });
    const { remote, theirs } = withRemote(sb);
    theirsPush(theirs, 'b.txt', 'b\n');
    sb.setScenario({
      a1: [planA, { text: '提交并同步', commands: [...commitA, ['git', 'pull', '-q', '--rebase']] }, { text: '汇总' }],
      a2: [writeA],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review', 'finish', 'summary']);
    expect(remoteLog(sb, remote).slice(0, 2)).toEqual(['feat: 加 a', '同事的改动']);
  });

  it('主控没有同步、HEAD 落后远端：再来一轮', async () => {
    sb = new Sandbox({ git: true, projectYaml: PUSH });
    const { remote, theirs } = withRemote(sb);
    theirsPush(theirs, 'b.txt', 'b\n');
    sb.setScenario({
      a1: [planA, { text: '提交了', commands: commitA }, { text: '同步了', commands: [['git', 'pull', '-q', '--rebase']] }, { text: '汇总' }],
      a2: [writeA],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.finish).toMatchObject({ outcome: 'done', rounds: 2 });
    expect(sb.calls().filter((c) => c.name === 'a1')[2]!.prompt).toContain('仍落后 origin/main 1 个提交');
    expect(remoteHead(sb, remote)).toBe(head(sb.project));
  });

  describe('同一个文件远端也改了', () => {
    /** c.txt 有五行；远端改第一行，本任务改第三行：rebase 能自动合并，但改动的上下文变了。 */
    function setup(projectYaml: string): { remote: string; theirs: string } {
      sb = new Sandbox({ git: true, projectYaml });
      fs.writeFileSync(path.join(sb.project, 'c.txt'), '1\n2\n3\n4\n5\n');
      sh(sb.project, 'git', ['add', 'c.txt']);
      sh(sb.project, 'git', ['commit', '-q', '-m', 'c']);
      const r = withRemote(sb);
      theirsPush(r.theirs, 'c.txt', 'one\n2\n3\n4\n5\n');
      return r;
    }
    const writeC = { text: '改好了', files: [{ path: 'c.txt', content: '1\n2\nthree\n4\n5\n' }] };
    const commitC = { text: '提交并同步', commands: [['git', 'commit', '-q', '-am', 'fix: c'], ['git', 'pull', '-q', '--rebase']] };

    it('交给审核者复审差别，通过后推送', async () => {
      const { remote } = setup(PUSH);
      sb.setScenario({
        a1: [{ text: plan([{ role: 'coder', task: '改 c.txt', writes: true }]) }, commitC, { text: '汇总' }],
        a2: [writeC],
        a3: [{ text: verdict(true) }, { text: verdict(true) }],
      });
      const r = await sb.runJson(['-p', '--yes', '任务']);
      expect(r.code).toBe(0);
      expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review', 'finish', 'review', 'summary']);
      const recheck = sb.calls().filter((c) => c.name === 'a3')[1]!;
      expect(recheck.access).toBe('read-only');
      expect(recheck.prompt).toContain('## c.txt');
      expect(recheck.prompt).toContain('### 审过时的改动');
      expect(fs.readFileSync(path.join(sb.project, 'c.txt'), 'utf8').replace(/\r/g, '')).toBe('one\n2\nthree\n4\n5\n');
      expect(remoteHead(sb, remote)).toBe(head(sb.project));
    });

    it('复审不通过、轮数到上限：收尾失败，不推送，可以续接', async () => {
      const { remote } = setup('finish: { mode: push, max_rounds: 1 }\n');
      const before = remoteHead(sb, remote);
      sb.setScenario({
        a1: [{ text: plan([{ role: 'coder', task: '改 c.txt', writes: true }]) }, commitC],
        a2: [writeC],
        a3: [{ text: verdict(true) }, { text: verdict(false, ['冲突解决得不对']) }],
      });
      const r = await sb.runJson(['-p', '--yes', '任务']);
      expect(r.code).toBe(1);
      expect(r.json.status).toBe('failed');
      expect(r.json.finish).toMatchObject({ outcome: 'failed', pushed: null });
      expect(r.json.finish.reason).toContain('max_rounds');
      expect(r.json.conclusion).toContain('从收尾接着做');
      expect(remoteHead(sb, remote)).toBe(before);
    });
  });

  it('主控没有提交：收尾失败；续接后从收尾接着做', async () => {
    sb = new Sandbox({ git: true, projectYaml: PUSH });
    const { remote } = withRemote(sb);
    sb.setScenario({ a1: [planA, { text: '忘了提交' }], a2: [writeA], a3: [{ text: verdict(true) }] });
    const first = await sb.runJson(['-p', '--yes', '任务']);
    expect(first.code).toBe(1);
    expect(first.json.finish.reason).toContain('没有提交任何内容');

    sb.setScenario({ a1: [{ text: '这次提交了', commands: commitA }, { text: '汇总' }] });
    const r = await sb.runJson(['resume', first.json.job_id]);
    expect(r.code).toBe(0);
    expect(r.json.finish).toMatchObject({ outcome: 'done', rounds: 1 });
    // 续接直接收尾，不重做前面的步骤，也不重审
    expect(sb.calls().map((c) => c.name)).toEqual(['a1', 'a1']);
    expect(remoteHead(sb, remote)).toBe(head(sb.project));
  });

  it('开工时本地已有没推送的提交：只提交、不推送', async () => {
    sb = new Sandbox({ git: true, projectYaml: PUSH });
    const { remote } = withRemote(sb);
    const before = remoteHead(sb, remote);
    fs.writeFileSync(path.join(sb.project, 'mine.txt'), 'x\n');
    sh(sb.project, 'git', ['add', 'mine.txt']);
    sh(sb.project, 'git', ['commit', '-q', '-m', '本地的提交']);
    sb.setScenario({ a1: [planA, { text: '提交了', commands: commitA }, { text: '汇总' }], a2: [writeA], a3: [{ text: verdict(true) }] });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.finish).toMatchObject({ mode: 'commit', outcome: 'done', pushed: null });
    expect(r.json.warnings.join('\n')).toContain('本地已有没推送到 origin/main 的提交');
    expect(remoteHead(sb, remote)).toBe(before);
  });

  it('commit：只提交；工作区里别人的改动不提交，交代给主控', async () => {
    sb = new Sandbox({ git: true, projectYaml: 'finish: { mode: commit }\n' });
    fs.appendFileSync(path.join(sb.project, 'README.md'), '还没提交的笔记\n');
    sb.setScenario({ a1: [planA, { text: '提交了', commands: commitA }, { text: '汇总' }], a2: [writeA], a3: [{ text: verdict(true) }] });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.finish).toMatchObject({ mode: 'commit', outcome: 'done', pushed: null });
    expect(r.json.conclusion).toContain('已提交，没有推送');
    expect(r.err).toContain('结束后：审查通过后由主控提交到当前分支，不推送。');
    expect(sb.calls().filter((c) => c.name === 'a1')[1]!.prompt).toContain('# 其他有未提交改动的文件（不是本任务的）\n- README.md');
    expect(sh(sb.project, 'git', ['status', '--porcelain']).trim()).toBe('M README.md');
  });

  it('没有开启收尾：照旧，不提交', async () => {
    sb = new Sandbox({ git: true });
    sb.setScenario({ a1: [planA, { text: '汇总' }], a2: [writeA], a3: [{ text: verdict(true) }] });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.finish).toBeNull();
    expect(sb.calls()[0]!.prompt).not.toContain('列为步骤');
    expect(sh(sb.project, 'git', ['status', '--porcelain'])).toContain('a.txt');
  });

  it('配置：mode 不认识、max_rounds 超出范围时报错', () => {
    sb = new Sandbox({ projectYaml: 'finish: { mode: deploy }\n' });
    expect(() => loadProjectConfig(sb.project, sb.home)).toThrow(/finish\.mode/);
    fs.writeFileSync(path.join(sb.project, '.dario', 'project.yaml'), 'finish: { mode: push, max_rounds: 11 }\n');
    expect(() => loadProjectConfig(sb.project, sb.home)).toThrow(/finish\.max_rounds/);
    fs.writeFileSync(path.join(sb.project, '.dario', 'project.yaml'), 'finish: { mode: push, command: git }\n');
    expect(() => loadProjectConfig(sb.project, sb.home)).toThrow(/不能定义/);
  });
});

describe('核对提交', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('提交的正是审过的内容时一致；多提交了别的文件、只提交一部分都算对不上；没提交的列为留在工作区', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-verify-'));
    gitInit(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'init']);
    const base = head(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    const reviewed = await recordReviewed(dir, ['a.txt', 'b.txt', 'c.txt']);
    sh(dir, 'git', ['add', 'a.txt', 'b.txt']);
    sh(dir, 'git', ['commit', '-q', '-m', 'ok']);
    const ok = await verifyCommits(dir, base, reviewed);
    expect(ok).toMatchObject({ commits: 1, behind: 0, mismatched: [], left: ['c.txt'], files: ['a.txt', 'b.txt'] });

    fs.writeFileSync(path.join(dir, 'extra.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c 改过\n');
    sh(dir, 'git', ['add', 'extra.txt', 'c.txt']);
    sh(dir, 'git', ['commit', '-q', '-m', 'more']);
    const bad = await verifyCommits(dir, base, reviewed);
    if (typeof bad === 'string') throw new Error(bad);
    expect(bad.mismatched.map((m) => m.file)).toEqual(['c.txt', 'extra.txt']);
    expect(bad.mismatched[1]!.reviewed).toBeUndefined();
  });
});

describe('隔离执行的推送', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('克隆的推送地址保持无效，Dario 用拉取地址推送；推送后删掉任务分支', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-iso-'));
    const remote = path.join(root, 'remote.git');
    sh(root, 'git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed);
    gitInit(seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), '1\n');
    sh(seed, 'git', ['add', '-A']);
    sh(seed, 'git', ['commit', '-q', '-m', 'init']);
    sh(seed, 'git', ['push', '-q', remote, 'main']);
    const clone = path.join(root, 'clone');
    sh(root, 'git', ['clone', '-q', remote, clone]);
    sh(clone, 'git', ['config', 'user.name', 'tester']);
    sh(clone, 'git', ['config', 'user.email', 'tester@example.com']);

    const ws = new IsolatedWorkspace(clone, { forbiddenPaths: [] });
    await ws.enterExec('J0001');
    expect(sh(clone, 'git', ['remote', 'get-url', '--push', 'origin']).trim()).toBe(PUSH_DISABLED_URL);
    fs.writeFileSync(path.join(clone, 'a.txt'), '2\n');
    sh(clone, 'git', ['commit', '-q', '-am', 'feat: 改 a']);

    const target = await ws.pushTarget();
    if (typeof target === 'string') throw new Error(target);
    expect(target).toMatchObject({ remote: 'origin', branch: 'main', trackingRef: 'refs/remotes/origin/main' });
    const pushed = await pushHead(clone, target);
    expect(pushed).toEqual({ ok: true, head: head(clone) });
    expect(sh(root, 'git', ['--git-dir', remote, 'rev-parse', 'main']).trim()).toBe(head(clone));
    expect(sh(clone, 'git', ['remote', 'get-url', '--push', 'origin']).trim()).toBe(PUSH_DISABLED_URL);

    const fin = await ws.finalize('J0001', { changed: ['a.txt'], violation: false, pushed: true });
    expect(fin.branch).toBeUndefined();
    expect(sh(clone, 'git', ['branch', '--list', 'dario/J0001']).trim()).toBe('');
  });

  it('只提交没推送时保留任务分支，不再另做快照', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-iso-'));
    const remote = path.join(root, 'remote.git');
    sh(root, 'git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const clone = path.join(root, 'clone');
    sh(root, 'git', ['clone', '-q', remote, clone]);
    gitInit(clone);
    fs.writeFileSync(path.join(clone, 'a.txt'), '1\n');
    sh(clone, 'git', ['add', '-A']);
    sh(clone, 'git', ['commit', '-q', '-m', 'init']);
    sh(clone, 'git', ['push', '-q', 'origin', 'main']);
    const ws = new IsolatedWorkspace(clone, { forbiddenPaths: [] });
    await ws.enterExec('J0002');
    fs.writeFileSync(path.join(clone, 'a.txt'), '2\n');
    sh(clone, 'git', ['commit', '-q', '-am', 'feat: 改 a']);
    const fin = await ws.finalize('J0002', { changed: ['a.txt'], violation: false });
    expect(fin.branch).toBe('dario/J0002');
    expect(sh(clone, 'git', ['log', '--format=%s', '-1']).trim()).toBe('feat: 改 a');
  });
});

describe('这一步禁止的命令', () => {
  it('命中即中断，不受项目的禁用命令设置影响', () => {
    const sb = new Sandbox();
    try {
      const { settings } = loadProjectConfig(sb.project, sb.home);
      const watch = new StepWatch({ rules: settings.supervise, writeRoots: [], streams: true, blockedCommands: ['git push'] });
      expect(watch.activity({ kind: 'run', target: 'git status' })).toEqual([]);
      const [alert] = watch.activity({ kind: 'run', target: 'git add -A && git push origin HEAD:main' });
      expect(alert).toMatchObject({ rule: 'forbidden_command', action: 'stop' });
    } finally {
      sb.cleanup();
    }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectConfig } from '../src/core/config.js';
import { stepPrompt } from '../src/core/prompts.js';
import { IsolatedWorkspace } from '../src/core/workspace.js';
import { gitInit, plan, Sandbox, sh, verdict } from './helpers.js';

/** 给沙箱的项目接上一个远端裸仓库。 */
function withRemote(sb: Sandbox): string {
  const remote = path.join(sb.dir, 'remote.git');
  sh(sb.dir, 'git', ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(sb.project, 'git', ['remote', 'add', 'origin', remote]);
  sh(sb.project, 'git', ['push', '-q', '-u', 'origin', 'main']);
  return remote;
}

const head = (dir: string): string => sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
const remoteHead = (sb: Sandbox, remote: string): string => sh(sb.dir, 'git', ['--git-dir', remote, 'rev-parse', 'main']).trim();
const commitAndPush = [['git', 'add', 'a.txt'], ['git', 'commit', '-q', '-m', 'feat: 加 a'], ['git', 'push', '-q', 'origin', 'HEAD:main']];
const writeA = { text: '写好了', files: [{ path: 'a.txt', content: 'a\n' }] };
const gitStep = { role: 'lead', task: '按项目的提交推送流程提交并推送', git: true };

describe('版本控制步骤', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('先审查前面的改动，再由主控按项目流程提交推送；不再追加审查', async () => {
    sb = new Sandbox({ git: true });
    const remote = withRemote(sb);
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '加 a.txt', writes: true }, gitStep]) }, { text: '已提交并推送：feat: 加 a', commands: commitAndPush }, { text: '汇总' }],
      a2: [writeA],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务，做完提交推送']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => `${s.kind}:${s.role}`)).toEqual(['plan:lead', 'step:coder', 'review:reviewer', 'step:lead', 'summary:lead']);
    expect(r.json.plan.steps.map((s: any) => s.git)).toEqual([false, true]);
    // 这一步的改动是它提交进去的文件
    expect(r.json.steps[3].changed_files).toEqual(['a.txt']);
    expect(remoteHead(sb, remote)).toBe(head(sb.project));
    expect(r.err).toContain('提交推送');
    const call = sb.calls().filter((c) => c.name === 'a1')[1]!;
    expect(call.access).toBe('write');
    expect(call.prompt).toContain('按项目已有的提交推送流程执行');
    expect(call.prompt).not.toContain('不要执行 git commit');
    // 出计划时主控知道怎么安排
    expect(sb.calls()[0]!.prompt).toContain('git 为 true');
  });

  it('只要求提交推送（前一个任务的改动）：本任务没有改动，不审查，直接交给主控', async () => {
    sb = new Sandbox({ git: true });
    const remote = withRemote(sb);
    fs.writeFileSync(path.join(sb.project, 'a.txt'), 'a\n');
    sb.setScenario({ a1: [{ text: plan([gitStep]) }, { text: '已提交并推送', commands: commitAndPush }, { text: '汇总' }] });
    const r = await sb.runJson(['-p', '--yes', '提交推送']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'summary']);
    expect(r.json.changed_files).toEqual([]);
    expect(remoteHead(sb, remote)).toBe(head(sb.project));
  });

  it('提交之前的审查不通过：照常返工，通过后才提交', async () => {
    sb = new Sandbox({ git: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '加 a.txt', writes: true }, gitStep]) }, { text: '已提交', commands: [['git', 'add', 'a.txt'], ['git', 'commit', '-q', '-m', 'feat: 加 a']] }, { text: '汇总' }],
      a2: [writeA, { text: '改好了', files: [{ path: 'a.txt', content: 'b\n' }] }],
      a3: [{ text: verdict(false, ['内容不对']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review', 'rework', 'review', 'step', 'summary']);
    expect(sh(sb.project, 'git', ['show', 'HEAD:a.txt'])).toBe('b\n');
  });

  it('提交之前的审查到返工上限：不提交；续接时先返工、再审查，通过后才提交', async () => {
    sb = new Sandbox({ git: true, projectYaml: 'max_rework_rounds: 0\n' });
    const before = head(sb.project);
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '加 a.txt', writes: true }, gitStep]) }],
      a2: [writeA],
      a3: [{ text: verdict(false, ['内容不对']) }],
    });
    const first = await sb.runJson(['-p', '--yes', '任务']);
    expect(first.code).toBe(1);
    expect(first.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review']);
    expect(head(sb.project)).toBe(before);

    sb.setScenario({
      a1: [{ text: '已提交', commands: [['git', 'add', 'a.txt'], ['git', 'commit', '-q', '-m', 'feat: 加 a']] }, { text: '汇总' }],
      a2: [{ text: '改好了', files: [{ path: 'a.txt', content: 'b\n' }] }],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['resume', first.json.job_id]);
    expect(r.code).toBe(0);
    expect(r.json.steps.slice(3).map((s: any) => s.kind)).toEqual(['rework', 'review', 'step', 'summary']);
    expect(sh(sb.project, 'git', ['show', 'HEAD:a.txt'])).toBe('b\n');
  });

  it('只能交给主控自己；关闭 lead_implements 时不能排', async () => {
    const { parsePlan } = await import('../src/core/plan.js');
    const { RoleBook } = await import('../src/core/roles.js');
    sb = new Sandbox();
    const project = loadProjectConfig(sb.project, sb.home);
    const roles = { resolve: (id: string) => id, ids: () => ['lead', 'coder'], get: () => ({ access: 'write' }) } as unknown as InstanceType<typeof RoleBook>;
    const ctx = { roles, leadRole: 'lead', leadImplements: true, maxPlanSteps: 8 };
    const toCoder = parsePlan(plan([{ role: 'coder', task: '提交', git: true } as any]), ctx);
    expect('error' in toCoder && toCoder.error).toContain('只能交给主控自己');
    const off = parsePlan(plan([gitStep]), { ...ctx, leadImplements: false });
    expect('error' in off && off.error).toContain('不能交给主控自己');
    const ok = parsePlan(plan([{ ...gitStep, writes: false, files: ['x'] } as any]), ctx);
    expect('plan' in ok && ok.plan.steps[0]).toEqual({ role: 'lead', task: gitStep.task, writes: true, acceptance: undefined, git: true });
    expect(project.settings.leadImplements).toBe(true);
  });

  it('隔离执行：说明里要求只提交、不推送', () => {
    sb = new Sandbox();
    const project = loadProjectConfig(sb.project, sb.home);
    const lead = { id: 'lead', alias: [], candidates: ['a1'], access: 'read-only' as const };
    const text = stepPrompt(project, lead, 'write', '提交', undefined, undefined, undefined, 'commit-only');
    expect(text).toContain('只提交，不要推送');
    expect(text).not.toContain('不要执行 git commit');
  });
});

describe('隔离执行的任务分支', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('任务分支上有提交、工作区干净：保留分支，不当作没有产出', async () => {
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
    await ws.enterExec('J0001');
    fs.writeFileSync(path.join(clone, 'a.txt'), '2\n');
    sh(clone, 'git', ['commit', '-q', '-am', 'feat: 改 a']);
    const fin = await ws.finalize('J0001', { changed: ['a.txt'], violation: false });
    expect(fin.branch).toBe('dario/J0001');
    expect(sh(clone, 'git', ['log', '--format=%s', '-1', 'dario/J0001']).trim()).toBe('feat: 改 a');
  });
});

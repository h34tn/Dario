import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/compose.js';
import { parseCommand } from '../src/core/commands.js';
import type { Engine } from '../src/core/engine.js';
import type { Job } from '../src/core/types.js';
import { plan, Sandbox, verdict } from './helpers.js';
import { setup } from './ui-session-helper.js';

const origin = { channel: 'terminal', senderId: '测试' };

/** 两步都交给实现：第一步做成，第二步受阻。 */
const TWO_STEPS = plan([
  { role: 'coder', task: '第一步：写 a.txt', writes: true },
  { role: 'coder', task: '第二步：在编辑器里改材质', writes: true },
]);

describe('续接没做完的任务', () => {
  let sb: Sandbox;
  let engine: Engine;
  beforeEach(async () => {
    sb = new Sandbox({ git: true, resumable: true });
    engine = (await createApp({ cwd: sb.project, env: sb.env() })).engine;
  });
  afterEach(() => sb?.cleanup());

  it('受阻的一步：沿用原计划和原任务号，接着受阻那一轮的会话做，做成的步骤不重做', async () => {
    sb.setScenario({
      a1: [{ text: TWO_STEPS }, { text: '汇总：都做完了' }],
      a2: [
        { text: '写好了', files: [{ path: 'a.txt', content: '1\n' }] },
        { text: '重试了几次都连不上。\nDARIO_BLOCKED: Unity MCP 连不上' },
        { text: '这次连上了，改好了', files: [{ path: 'b.txt', content: '2\n' }] },
      ],
      a3: [{ text: verdict(true) }],
    });
    const first = await engine.submit({ task: '改材质', origin, autoApprove: true });
    expect(first.status).toBe('failed');
    expect(first.steps.at(-1)!.blocked).toBe('Unity MCP 连不上');
    expect(first.result!.conclusion).toContain('问题解决后可以续接这个任务');
    expect(engine.resumable(first)).toMatchObject({ ok: true, where: '计划第 2 步（实现）' });

    // 不写任务号：取本项目最近的一个任务
    const done = await engine.resume(undefined, { note: 'Unity 已经重启' });
    expect(done.id).toBe(first.id);
    expect(done.status).toBe('done');
    expect(done.steps.map((s) => `${s.kind}:${s.outcome}`)).toEqual(['plan:ok', 'step:ok', 'step:task_failed', 'step:ok', 'review:ok', 'summary:ok']);
    expect(done.changedFiles).toEqual(['a.txt', 'b.txt']);
    expect(done.resumes).toEqual([expect.objectContaining({ from: '计划第 2 步（实现）', note: 'Unity 已经重启' })]);
    expect(done.failureCode).toBeUndefined();
    expect(done.result!.conclusion).toBe('汇总：都做完了');

    const calls = sb.calls();
    // 主控没有重新出计划，第一步没有重做
    expect(calls.map((c) => c.name)).toEqual(['a1', 'a2', 'a2', 'a2', 'a3', 'a1']);
    const resumed = calls[3]!;
    expect(resumed.argv.join(' ')).toContain('--resume a2-s0');
    expect(done.steps[3]!.resumed).toBe(true);
    expect(resumed.prompt).toContain('# 接着做');
    expect(resumed.prompt).toContain('必需的工具或服务用不了而停下：Unity MCP 连不上');
    expect(resumed.prompt).toContain('发起人已经处理了这个问题');
    expect(resumed.prompt).toContain('# 发起人的补充说明\nUnity 已经重启');
    expect(resumed.prompt).toContain('第二步：在编辑器里改材质');
    // 接着的是同一个会话，它自己的输出不再附上
    expect(resumed.prompt).not.toContain('上次停下前的最后输出');
  });

  it('没做完的一轮（进程失败）：新开会话，附上那一轮最后的输出，提醒先检查改了一半的文件', async () => {
    sb.setScenario({
      a2: [
        { text: '写了一半就出错了', exit: 1, files: [{ path: 'half.txt', content: 'x\n' }] },
        { text: '补完了', files: [{ path: 'half.txt', content: 'xy\n' }] },
      ],
    });
    const first = await engine.submit({ task: '写 half.txt', role: 'coder', origin });
    expect(first.status).toBe('failed');
    expect(first.sessions?.coder).toBeUndefined();
    expect(engine.resumable(first)).toMatchObject({ ok: true, where: '这一步（实现）' });

    const done = await engine.resume(first.id);
    expect(done.status).toBe('done');
    const resumed = sb.calls()[1]!;
    expect(resumed.argv).not.toContain('--resume');
    expect(resumed.prompt).toContain('这一步上次没有做完');
    expect(resumed.prompt).toContain('先检查现状，在此基础上接着做，不要从头重写');
    expect(resumed.prompt).toContain('# 上次停下前的最后输出\n写了一半就出错了');
    expect(resumed.prompt).toContain('写 half.txt');
    expect(done.changedFiles).toEqual(['half.txt']);
  });

  it('停下之后被改过的文件：列给接手的角色并附 diff，计入改动，审查里注明不全是本任务改的', async () => {
    sb.setScenario({
      a1: [{ text: TWO_STEPS }, { text: '汇总' }],
      a2: [
        { text: '写好了', files: [{ path: 'a.txt', content: '1\n' }] },
        { text: 'DARIO_BLOCKED: Unity MCP 连不上' },
        { text: '改好了' },
      ],
      a3: [{ text: verdict(true) }],
    });
    const first = await engine.submit({ task: '改材质', origin, autoApprove: true });
    expect(first.status).toBe('failed');
    fs.writeFileSync(path.join(sb.project, 'manual.txt'), '发起人手动改的\n');
    fs.appendFileSync(path.join(sb.project, 'a.txt'), '再加一行\n');

    const done = await engine.resume(first.id);
    expect(done.status).toBe('done');
    expect(done.resumes![0]!.changed).toEqual(['a.txt', 'manual.txt']);
    expect(done.changedFiles).toEqual(['a.txt', 'manual.txt']);
    const calls = sb.calls();
    const resumed = calls[3]!;
    expect(resumed.prompt).toContain('# 任务停下之后有变化的文件\n- a.txt\n- manual.txt');
    expect(resumed.prompt).toContain('# 这些文件的 diff');
    expect(resumed.prompt).toContain('发起人手动改的');
    const review = calls[4]!;
    expect(review.name).toBe('a3');
    expect(review.prompt).toContain('其中 a.txt、manual.txt 在任务停下之后、续接之前被改过');
  });

  it('审查达到返工上限：续接直接拿最后一次审查的问题再返工一轮，不先重审', async () => {
    fs.writeFileSync(path.join(sb.project, '.dario', 'project.yaml'), 'max_rework_rounds: 0\n');
    engine = (await createApp({ cwd: sb.project, env: sb.env() })).engine;
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '写 a.txt', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: '写好了', files: [{ path: 'a.txt', content: '1\n' }] }, { text: '按审查改好了', files: [{ path: 'a.txt', content: '1\n2\n' }] }],
      a3: [{ text: verdict(false, ['a.txt 少了第二行']) }, { text: verdict(true) }],
    });
    const first = await engine.submit({ task: '写文件', origin, autoApprove: true });
    expect(first.status).toBe('failed');
    expect(first.failureCode).toBe('review_rejected');
    expect(engine.resumable(first)).toMatchObject({ ok: true, where: '返工（实现，按最近一次审查的问题）' });

    const done = await engine.resume(first.id, { note: '第二行写 2' });
    expect(done.status).toBe('done');
    expect(done.extraReworkRounds).toBe(1);
    expect(done.reworkRounds).toBe(1);
    expect(done.steps.map((s) => s.kind)).toEqual(['plan', 'step', 'review', 'rework', 'review', 'summary']);
    const rework = sb.calls()[3]!;
    expect(rework.name).toBe('a2');
    expect(rework.prompt).toContain('a.txt 少了第二行');
    expect(rework.prompt).toContain('审查已经返工到上限，发起人决定再给一轮');
    expect(rework.prompt).toContain('第二行写 2');
  });

  it('Dario 中断：那一轮的会话作废，提醒可能有改了一半的文件', async () => {
    sb.setScenario({
      a1: [{ text: TWO_STEPS }, { text: '汇总' }],
      a2: [{ text: '写好了', files: [{ path: 'a.txt', content: '1\n' }] }, { text: 'DARIO_BLOCKED: 假装这一轮没来得及记下' }, { text: '做完了' }],
      a3: [{ text: verdict(true) }],
    });
    const first = await engine.submit({ task: '改材质', origin, autoApprove: true });
    // 模拟第二步执行到一半时 Dario 退出：那一步没有记录，任务还是"执行中"，推进它的进程已经不在
    const record = engine.state.loadJob(first.id)!;
    record.steps.pop();
    record.status = 'running';
    record.ownerPid = spawnSync(process.execPath, ['-e', '']).pid;
    record.result = undefined;
    record.failureCode = undefined;
    engine.state.saveJob(record);
    fs.writeFileSync(path.join(sb.project, 'partial.txt'), '改了一半\n');

    expect(engine.job(first.id).status).toBe('interrupted');
    const done = await engine.resume(first.id);
    expect(done.status).toBe('done');
    const resumed = sb.calls()[3]!;
    expect(resumed.argv).not.toContain('--resume');
    expect(resumed.prompt).toContain('Dario 退出了，没有做完');
    expect(resumed.prompt).toContain('- partial.txt');
  });

  it('不能续接的任务说明原因', async () => {
    sb.setScenario({ a1: [{ text: plan([{ role: 'coder', task: '改', writes: true }]) }], a2: [{ text: '好了' }] });
    const pending = await engine.submit({ task: '要批准的任务', origin });
    expect(pending.status).toBe('awaiting_approval');
    await expect(engine.resume(pending.id)).rejects.toThrow('计划在等待确认');
    engine.cancel(pending.id);
    await expect(engine.resume(pending.id)).rejects.toThrow('计划还没有开始执行');

    const direct = await engine.submit({ task: '直接做', role: 'coder', origin });
    expect(direct.status).toBe('done');
    await expect(engine.resume()).rejects.toThrow(`最近的任务 ${direct.id} 不能续接：已经完成`);
  });
});

describe('命令行与指令', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = new Sandbox({ git: true, resumable: true });
  });
  afterEach(() => sb?.cleanup());

  it('任务停下时提示 dario resume；dario resume 带补充说明接着做', async () => {
    sb.setScenario({
      a1: [{ text: TWO_STEPS }, { text: '汇总' }],
      a2: [{ text: '写好了', files: [{ path: 'a.txt', content: '1\n' }] }, { text: 'DARIO_BLOCKED: Unity MCP 连不上' }, { text: '好了' }],
      a3: [{ text: verdict(true) }],
    });
    const first = await sb.cli(['-p', '--yes', '改材质']);
    expect(first.code).toBe(1);
    expect(first.err).toContain('运行 dario resume J0001 从计划第 2 步（实现）接着做');

    const r = await sb.runJson(['resume', 'Unity', '已经重启']);
    expect(r.code).toBe(0);
    expect(r.json.job_id).toBe('J0001');
    expect(r.json.status).toBe('done');
    expect(r.err).toContain('[J0001] 续接：从计划第 2 步（实现）接着做');
    expect(sb.calls()[3]!.prompt).toContain('# 发起人的补充说明\nUnity 已经重启');

    const again = await sb.cli(['resume', 'J0001']);
    expect(again.code).toBe(2);
    expect(again.err).toContain('任务 J0001 不能续接：已经完成');
  });

  it('/resume 的任务号与补充说明；/unpause 恢复接收', () => {
    expect(parseCommand('/resume')).toEqual({ kind: 'resume' });
    expect(parseCommand('/resume j0007 Unity 已经重启')).toEqual({ kind: 'resume', jobId: 'J0007', note: 'Unity 已经重启' });
    expect(parseCommand('/resume 服务恢复了')).toEqual({ kind: 'resume', note: '服务恢复了' });
    expect(parseCommand('/unpause')).toEqual({ kind: 'unpause' });
  });
});

describe('交互界面里的续接', () => {
  it('停下的任务提示 /resume；/resume 把任务号和补充说明交给引擎', async () => {
    const failed = { id: 'J0001', task: '改材质', status: 'failed', steps: [], changedFiles: [], warnings: [], result: { conclusion: '第 3 步受阻', changedFiles: [], warnings: [] } } as unknown as Job;
    const resume = vi.fn(async (id: string) => ({ ...failed, id, status: 'done', result: { conclusion: '做完了', changedFiles: [], warnings: [] } }) as unknown as Job);
    const resumable = vi.fn((job: Job) => (job.status === 'done' ? { ok: false, reason: '已经完成' } : { ok: true, where: '计划第 2 步（实现）' }));
    const { session, engine, log } = await setup(undefined, undefined, undefined, { resume, resumable, latestJob: () => failed, job: () => failed });
    engine.advance.mockImplementationOnce(async () => failed);
    session.submit('改材质');
    await session.whenIdle();
    expect(log()).toContain('输入 /resume 从计划第 2 步（实现）接着做');

    session.submit('/resume Unity 已经重启');
    await session.whenIdle();
    expect(resume).toHaveBeenCalledWith('J0001', expect.objectContaining({ note: 'Unity 已经重启' }));
    expect(log()).toContain('J0001 · 续接：从计划第 2 步（实现）接着做');
    expect(log()).toContain('做完了');
  });
});

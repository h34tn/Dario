import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../src/core/state.js';
import type { Job } from '../src/core/types.js';
import { setup } from './ui-session-helper.js';

const ROOT = '/项目/rise';
const dirs: string[] = [];
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-session-'));
  dirs.push(dir);
  return new StateStore(dir);
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const sessions = { lead: { agent: 'claude', sessionId: 'S-1', step: 0 } };

describe('会话存档：退出后重进接着做', () => {
  it('任务结束后存档上文与各角色的 AI 会话', async () => {
    const state = store();
    const { session, engine } = await setup(undefined, undefined, undefined, { state });
    engine.advance.mockImplementationOnce(async j => ({ ...j, sessions }) as Job);
    session.submit('第一件事\n第二行');
    await session.whenIdle();
    const saved = state.getSavedSession(ROOT)!;
    expect(saved.jobId).toBe('J0001');
    expect(saved.task).toBe('第一件事');
    expect(saved.sessions).toEqual(sessions);
    expect(saved.context).toContain('**成功**');
    expect(saved.files).toEqual(['a.ts']);
  });

  it('重新进入时只提示，不自动接上；/continue 之后下一个任务带上存档的上文和会话', async () => {
    const state = store();
    state.saveSession(ROOT, { savedAt: '2026-11-21T08:31:20.000Z', jobId: 'J0027', task: '换 shader 看对比效果', context: '上次的结论', sessions, files: ['x.ts'] });
    const { session, engine, log, snap } = await setup(undefined, undefined, undefined, { state });
    expect(log()).toContain('上一次会话停在 J0027');
    expect(log()).toContain('/continue');
    expect(snap().contextJobId).toBeUndefined();

    session.submit('/continue');
    await session.whenIdle();
    await new Promise(r => setTimeout(r, 0));
    expect(log()).toContain('已接上');
    expect(log()).toContain('主控的 AI 会话接着用');
    expect(snap().contextJobId).toBe('J0027');

    session.submit('接着做');
    await session.whenIdle();
    const req = engine.create.mock.calls[0]![0];
    expect(req.context).toBe('上次的结论');
    expect(req.sessions).toEqual(sessions);
  });

  it('--continue：启动时直接接上', async () => {
    const state = store();
    state.saveSession(ROOT, { savedAt: '2026-11-21T08:31:20.000Z', jobId: 'J0027', task: '任务', context: '上次的结论', sessions, files: [] });
    const { session, engine, log, snap } = await setup({ continueLast: true }, undefined, undefined, { state });
    expect(log()).toContain('已接上');
    expect(snap().contextJobId).toBe('J0027');
    session.submit('接着做');
    await session.whenIdle();
    expect(engine.create.mock.calls[0]![0].sessions).toEqual(sessions);
  });

  it('--continue 但没有存档：说明后从头开始', async () => {
    const { log } = await setup({ continueLast: true }, undefined, undefined, { state: store() });
    expect(log()).toContain('没有可以接着做的会话');
  });

  it('/new 删除存档', async () => {
    const state = store();
    state.saveSession(ROOT, { savedAt: '2026-11-21T08:31:20.000Z', jobId: 'J0027', task: '任务', context: '上次的结论', files: [] });
    const { session } = await setup({ continueLast: true }, undefined, undefined, { state });
    session.submit('/new');
    await new Promise(r => setTimeout(r, 0));
    expect(state.getSavedSession(ROOT)).toBeUndefined();
  });
});

describe('从指定的任务接着做', () => {
  const base = { task: '任务', steps: [], changedFiles: [], warnings: [], projectRoot: ROOT, updatedAt: '2026-11-21T08:31:20.000Z' };
  const jobs: Record<string, unknown> = {
    J0012: { ...base, id: 'J0012', task: '第十二个任务\n第二行', status: 'done', sessions,
      result: { conclusion: '结论甲', changedFiles: ['x.ts'], warnings: [] } },
    // 没做成的任务：上文沿用它当时收到的，会话仍取它记录里的
    J0013: { ...base, id: 'J0013', status: 'failed', sessions, context: '更早的上文', contextJob: 'J0010',
      result: { conclusion: '第 2 步没有完成', changedFiles: [], warnings: [] } },
    J0014: { ...base, id: 'J0014', status: 'running' },
    J0015: { ...base, id: 'J0015', status: 'done', projectRoot: '/项目/另一个', result: { conclusion: '别处的结论', changedFiles: [], warnings: [] } },
  };
  const job = (id: string) => {
    const found = jobs[id.toUpperCase()];
    if (!found) throw new Error(`没有这个任务：${id}`);
    return found as Job;
  };
  const start = (continueLast?: string) => setup(continueLast ? { continueLast } : undefined, undefined, undefined, { state: store(), job });

  it('启动时给任务号：上文是那个任务的结论，各角色接着用它的 AI 会话', async () => {
    const { session, engine, log, snap } = await start('J0012');
    expect(log()).toContain('已接上');
    expect(log()).toContain('结论甲');
    expect(snap().contextJobId).toBe('J0012');
    session.submit('接着做');
    await session.whenIdle();
    const req = engine.create.mock.calls[0]![0];
    expect(req.context).toBe('同一次会话里上一个任务（J0012）的结论：\n结论甲');
    expect(req.contextJob).toBe('J0012');
    expect(req.sessions).toEqual(sessions);
    // /diff 能看到那个任务改动的文件
    expect(log()).toContain('x.ts');
  });

  it('没做成的任务：上文沿用它当时收到的上文，不拿失败说明当结论', async () => {
    const { session, engine, snap } = await start('J0013');
    expect(snap().contextJobId).toBe('J0010');
    session.submit('接着做');
    await session.whenIdle();
    const req = engine.create.mock.calls[0]![0];
    expect(req.context).toBe('更早的上文');
    expect(req.contextJob).toBe('J0010');
    expect(req.sessions).toEqual(sessions);
  });

  it('界面里 /continue 加任务号，大小写都认', async () => {
    const { session, log, snap } = await start();
    session.submit('/continue j0012');
    await new Promise(r => setTimeout(r, 0));
    expect(log()).toContain('已接上');
    expect(snap().contextJobId).toBe('J0012');
  });

  it.each([
    ['J9999', '没有这个任务'], ['J0014', '还没有结束'], ['J0015', '另一个项目'],
  ])('%s 接不上：说明原因，从头开始，不带任何上文和会话', async (id, reason) => {
    const { session, engine, log, snap } = await start(id);
    expect(log()).toContain(reason);
    expect(log()).toContain('没有接上，从头开始');
    expect(snap().contextJobId).toBeUndefined();
    session.submit('新任务');
    await session.whenIdle();
    const req = engine.create.mock.calls[0]![0];
    expect(req.context).toBeUndefined();
    expect(req.sessions).toBeUndefined();
  });

  it('有任务在运行时不能接', async () => {
    const { session, hold, log } = await start();
    const finish = hold();
    session.submit('任务');
    await new Promise(r => setTimeout(r, 0));
    session.submit('/continue J0012');
    await new Promise(r => setTimeout(r, 0));
    expect(log()).toContain('有任务在运行');
    finish();
    await session.whenIdle();
  });
});

describe('命令行的 -c / --continue', () => {
  it('后面紧跟任务号时从那个任务接着做，别的词仍然是任务描述', async () => {
    const { parseArgs } = await import('../src/cli/main.js');
    expect(parseArgs(['-c'])).toMatchObject({ continueLast: true, positionals: [] });
    expect(parseArgs(['-c', 'J0027'])).toMatchObject({ continueLast: 'J0027', positionals: [] });
    expect(parseArgs(['--continue', 'j27', '--inline'])).toMatchObject({ continueLast: 'J27', inline: true, positionals: [] });
    expect(parseArgs(['--continue=J0027'])).toMatchObject({ continueLast: 'J0027' });
    expect(parseArgs(['-c', '修复登录'])).toMatchObject({ continueLast: true, positionals: ['修复登录'] });
    expect(parseArgs(['-c', 'Jupiter'])).toMatchObject({ continueLast: true, positionals: ['Jupiter'] });
    expect(() => parseArgs(['--continue=abc'])).toThrow('任务号');
  });
});

describe('旧的任务记录', () => {
  it('没有记上文来自哪个任务时，从上文开头的任务号里取', async () => {
    const old = { id: 'J0028', task: '任务', steps: [], changedFiles: [], warnings: [], projectRoot: ROOT,
      updatedAt: '2026-11-21T10:06:00.000Z', status: 'cancelled', sessions,
      context: '同一次会话里上一个任务（J0027）的结论：\n对比已完成', result: { conclusion: '任务已取消。', changedFiles: [], warnings: [] } };
    const { snap } = await setup({ continueLast: 'J0028' }, undefined, undefined, { state: store(), job: () => old as unknown as Job });
    expect(snap().contextJobId).toBe('J0027');
  });
});

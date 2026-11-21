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

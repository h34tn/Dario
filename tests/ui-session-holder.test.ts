import { describe, expect, it } from 'vitest';
import { setup } from './ui-session-helper.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('状态栏：换人之后显示实际上场的 AI', () => {
  it('任务运行中换了人，状态栏立即跟着变；任务结束后回到角色表的担当者', async () => {
    const { session, snap, emit, hold } = await setup(undefined, undefined, [{ id: 'claude', model: 'claude-x' }, { id: 'codex', model: 'gpt-x' }]);
    const lead = () => snap().status.roles.find(r => r.label === '主控')!;
    expect(lead()).toMatchObject({ holder: 'claude', model: 'claude-x', degraded: false });

    const finish = hold();
    session.submit('任务');
    await tick();
    const step = { index: 0, kind: 'plan', role: 'lead', roleLabel: '主控（lead）', agent: 'claude' } as const;
    emit({ jobId: 'J0001', kind: 'step_start', step, text: '计划：交给 claude' });
    await tick();
    expect(lead().holder).toBe('claude');

    // claude 不可用，换成 codex：这一步由 codex 重新开始
    emit({ jobId: 'J0001', kind: 'fallback', step: { ...step, agent: 'codex' }, text: '计划：交给 codex' });
    await tick();
    expect(lead()).toMatchObject({ holder: 'codex', model: 'gpt-x', degraded: true });

    finish();
    await session.whenIdle();
    expect(lead()).toMatchObject({ holder: 'claude', degraded: false });
  });

  it('别的任务的事件不影响状态栏', async () => {
    const { session, snap, emit, hold } = await setup();
    const finish = hold();
    session.submit('任务');
    await tick();
    emit({ jobId: 'J9999', kind: 'step_start', step: { index: 0, kind: 'plan', role: 'lead', roleLabel: '主控（lead）', agent: 'codex' }, text: '' });
    await tick();
    expect(snap().status.roles.find(r => r.label === '主控')!.holder).toBe('claude');
    finish();
    await session.whenIdle();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { setup } from './ui-session-helper.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('状态栏：换人之后显示实际上场的 AI', () => {
  it('任务运行中换了人，状态栏立即跟着变；任务结束后回到角色表的担当者', async () => {
    const { session, snap, emit, hold } = await setup(undefined, undefined, [{ id: 'claude', model: 'claude-x' }, { id: 'codex', model: 'gpt-x', effort: 'high' }]);
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
    expect(lead()).toMatchObject({ holder: 'codex', model: 'gpt-x[high]', degraded: true });

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

it('额度跟随实际担当者，探测期间的新事件优先，只处理当前任务且不重复探测', async () => {
  const { session, engine, snap, emit, hold } = await setup(undefined, undefined, [
    { id: 'claude', quota: { free: true, windows: [] } },
    { id: 'codex', quota: { free: false, windows: [{ id: '周', usedPercent: 37 }] } },
  ]);
  const percent = (label: string) => snap().status.roles.find(r => r.label === label)?.quotaPercent;
  expect(percent('主控')).toBe(0);
  expect(percent('实现')).toBe(37);
  const finish = hold();
  session.submit('任务');
  await tick();
  emit({ jobId: 'J0001', kind: 'fallback', step: { index: 0, role: 'lead', roleLabel: '主控', kind: 'plan', agent: 'codex' }, text: '' });
  const calls = engine.agentsView.mock.calls.length;
  const quota = { agent: 'codex', windows: [{ id: '周', usedPercent: 88 }] };
  emit({ jobId: 'J0001', kind: 'quota', quota, text: '' });
  expect(percent('实现')).toBe(88);
  await tick();
  expect(percent('主控')).toBe(88);
  emit({ jobId: 'J9999', kind: 'quota', quota: { ...quota, windows: [] }, text: '' });
  expect(percent('主控')).toBe(88);
  expect(engine.agentsView).toHaveBeenCalledTimes(calls);
  finish();
  await session.whenIdle();
  expect(percent('主控')).toBe(0);
});

it('停留在界面时主窗口重置后不再显示数字', async () => {
  vi.useFakeTimers();
  try {
    const windows = [1, 2].map(n => ({ id: String(n), usedPercent: 30 * n,
      resetsAt: new Date(Date.now() + n * 1000).toISOString(), primary: n === 1 ? true as const : undefined }));
    const { session, snap, engine } = await setup(undefined, undefined, [{ id: 'claude', quota: { free: false, windows } }]);
    const percent = () => snap().status.roles[0]?.quotaPercent;
    expect(percent()).toBe(30);
    vi.advanceTimersByTime(1000);
    expect(percent()).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(percent()).toBeUndefined();
    expect(engine.agentsView).toHaveBeenCalledTimes(1);
    session.dispose();
  } finally { vi.useRealTimers(); }
});

it('同一家 AI 担当两个角色时，状态栏分别使用候选在该角色下的型号与强度', async () => {
  const { engine, session, snap } = await setup(undefined, undefined, [{ id: 'codex', model: '工具默认型号' }]);
  const views = await engine.rolesView();
  engine.rolesView.mockResolvedValue(views.map(role => ({
    ...role, candidates: role.candidates.map(c => c.agent === 'codex' ? {
      ...c, model: role.id === 'coder' ? '执行型号' : '测试型号', effort: role.id === 'coder' ? 'high' : 'low',
    } : c),
  })));
  session.submit('/health');
  await vi.waitFor(() => expect(snap().status.roles.filter(r => r.holder === 'codex').map(r => r.model))
    .toEqual(['执行型号[high]', '测试型号[low]']));
});

import { expect, it, vi } from 'vitest';
import { formatRoles } from '../src/core/report.js';
import { ConfigError } from '../src/core/util.js';
import { DEFAULT_ROWS, plan, question, setup, step } from './ui-session-helper.js';

it('开场、回显、标题和定稿历史只追加，动态快照不保留定稿行', async () => {
  const { session, hold, snap, emit } = await setup();
  const initial = snap();
  expect(snap()).toBe(initial);
  expect(initial.history[0]).toMatchObject({ type: 'banner', text: expect.stringContaining('Dario · rise') });
  const finish = hold();
  session.submit('/to coder 第一行\n第二行');
  expect(snap().history.slice(1)).toMatchObject([{ type: 'input', text: '/to coder 第一行（共 2 行）' },
    { type: 'title', text: 'J0001 · 交给 实现 · 第一行' }]);
  expect(initial.history).toHaveLength(1);
  const old = snap();
  emit({ jobId: '其他', kind: 'step_start', step, text: '' });
  expect(snap()).toBe(old);
  emit({ jobId: 'J0001', kind: 'step_start', step, text: '' });
  emit({ jobId: 'J0001', kind: 'fallback', fallback: { from: '甲', to: '乙', reason: '额度' }, text: '' });
  expect(snap().feed.lines).toEqual([]);
  emit({ jobId: 'J0001', kind: 'step_end', step: { ...step, outcome: 'ok' }, text: '' });
  expect(snap().history.slice(-2)).toMatchObject([{ type: 'notice', text: '甲 不可用（额度），改用 乙' }, { type: 'step', step: { state: 'done' } }]);
  expect(snap().feed.lines).toEqual([]);
  finish();
  await session.whenIdle();
  expect(snap().history.at(-1)).toMatchObject({ type: 'text', text: '[J0001] 完成\n\n成功\n改动的文件（1）：\n  a.ts\n产出所在分支：分支\n注意：\n  - 留意\n' });
});

it('依次排队，在开始时注入上文，失败保留上文，清空后从头开始', async () => {
  const { session, engine, snap, log, hold } = await setup();
  const finish = hold();
  session.submit('一');
  session.submit('二');
  expect(log()).toContain('已排队，前面还有 1 个任务。');
  expect(snap().queued).toBe(1);
  expect(engine.create).toHaveBeenCalledTimes(1);
  engine.advance.mockImplementationOnce(async j => ({ ...j, status: 'failed' }));
  finish();
  await session.whenIdle();
  expect(engine.create.mock.calls[1][0].context).toBe('同一次会话里上一个任务（J0001）的结论：\n**成功**');
  expect(snap()).toMatchObject({ contextJobId: 'J0001', queued: 0 });
  session.submit('/new');
  session.submit('三');
  await session.whenIdle();
  expect(engine.create.mock.calls[2][0]).not.toHaveProperty('context');
});

it('各角色的 AI 会话随任务带下去，失败的任务也带，清空后不再带', async () => {
  const { session, engine } = await setup();
  const sessions = { coder: { agent: 'codex', sessionId: 's1', step: 2 } };
  engine.advance.mockImplementationOnce(async j => ({ ...j, sessions }));
  session.submit('一');
  await session.whenIdle();
  expect(engine.create.mock.calls[0][0]).not.toHaveProperty('sessions');
  const later = { coder: { agent: 'codex', sessionId: 's1', step: 0 }, lead: { agent: 'claude', sessionId: 's2', step: 1 } };
  engine.advance.mockImplementationOnce(async j => ({ ...j, status: 'failed', sessions: later }));
  session.submit('二');
  await session.whenIdle();
  expect(engine.create.mock.calls[1][0].sessions).toEqual(sessions);
  session.submit('三');
  await session.whenIdle();
  expect(engine.create.mock.calls[2][0].sessions).toEqual(later);
  session.submit('/new');
  session.submit('四');
  await session.whenIdle();
  expect(engine.create.mock.calls[3][0]).not.toHaveProperty('sessions');
});

it('换人询问可同意或用中断拒绝；批准已有计划时同样能问', async () => {
  const { session, engine, snap, job } = await setup();
  for (const approved of [true, false]) {
    let decision: boolean | undefined;
    engine.advance.mockImplementationOnce(async (job, opts) => {
      decision = await opts.confirmFallback!(question);
      return job;
    });
    session.submit('任务');
    expect(snap().ask).toBe(question);
    if (approved) session.decideFallback(true);
    else session.interrupt();
    expect(snap().ask).toBeUndefined();
    await session.whenIdle();
    expect(decision).toBe(approved);
  }
  // 拒绝换人不是取消任务
  expect(engine.cancel).not.toHaveBeenCalled();
  let decision: boolean | undefined;
  engine.approve.mockImplementationOnce(async (id, opts) => {
    decision = await opts!.confirmFallback!(question);
    return { ...job, id };
  });
  session.submit('/approve J0009');
  await vi.waitFor(() => expect(snap().ask).toBe(question));
  session.decideFallback(true);
  await session.whenIdle();
  expect(decision).toBe(true);
  // 没有在问的时候，回答不起作用
  session.decideFallback(true);
  expect(snap().ask).toBeUndefined();
});

it('计划可批准或用中断拒绝，两种选择都清除确认状态', async () => {
  const { session, engine, snap } = await setup();
  for (const approved of [true, false]) {
    let decision: boolean | undefined;
    engine.advance.mockImplementationOnce(async (job, opts) => {
      decision = await opts.confirm!({ ...job, plan });
      return job;
    });
    session.submit('任务');
    expect(snap().plan).toBe(plan);
    if (approved) session.decidePlan(true);
    else session.interrupt();
    expect(snap().plan).toBeUndefined();
    await session.whenIdle();
    expect(decision).toBe(approved);
  }
  expect(engine.cancel).not.toHaveBeenCalled();
});

it('退出会放弃排队、请求取消并等待当前任务结束', async () => {
  const { session, engine, snap, log, hold } = await setup();
  session.interrupt();
  expect(engine.cancel).not.toHaveBeenCalled();
  const finish = hold();
  session.submit('一');
  session.submit('二');
  session.requestExit('plain');
  expect(engine.cancel).toHaveBeenCalledWith('J0001');
  expect(snap().feed.stopping).toBe(true);
  expect(snap().queued).toBe(0);
  expect(snap().exiting).toBeUndefined();
  expect(log()).toContain('已放弃排队中的 1 个任务。');
  finish();
  await session.whenIdle();
  expect(engine.create).toHaveBeenCalledTimes(1);
  expect(snap().exiting).toBe('plain');
});

it.each(['/exit', '/quit', '/plain'])('空闲时执行 %s 立即退出', async cmd => {
  const { session, snap } = await setup();
  session.submit(cmd);
  expect(snap().exiting).toBe(cmd === '/plain' ? 'plain' : 'exit');
});

it('查看、设置、检查、批准和取消指令分别传到对应引擎接口', async () => {
  const { session, engine, log } = await setup();
  for (const cmd of ['/roles', '/agents', '/status', '/status J0001', '/role coder codex', '/role coder reset',
    '/health codex', '/help', '/未知', '/pause', '/cancel', '/approve', '/approve J0003']) session.submit(cmd);
  await session.whenIdle();
  for (const part of ['当前担当：codex', 'codex：可用 · 版本 · 额度未知', 'J0001 完成 · 任务', '[J0001] 完成', '已指定', '已恢复',
    '正在检查，会实际调用一次 AI…', 'codex：可用 — 正常', '/diff ', '/plain ', '/exit ', '不认识的指令：/未知',
    '这个指令只在常驻运行的渠道里有意义。', '当前没有正在运行的任务。', '用法：/approve <任务号>', 'J0003 · 继续执行已批准的计划']) expect(log()).toContain(part);
  expect(engine.jobs).toHaveBeenCalledWith(10);
  expect(engine.job).toHaveBeenCalledWith('J0001');
  expect(engine.setRole).toHaveBeenCalledWith('coder', 'codex', false);
  expect(engine.approve).toHaveBeenCalledWith('J0003', { confirmFallback: expect.any(Function) });
  session.submit('/cancel J0001');
  expect(engine.cancel).toHaveBeenCalledWith('J0001');
});

it('指令和任务异常有明确提示，创建或推进失败后继续队列', async () => {
  const { session, engine, snap, log, hold } = await setup();
  const finish = hold();
  session.submit('一');
  engine.create.mockImplementationOnce(() => { throw new ConfigError('缺少角色'); });
  engine.advance.mockRejectedValueOnce(new Error('推进失败'));
  for (const task of ['二', '三', '四']) session.submit(task);
  finish();
  await session.whenIdle();
  expect(snap().history.filter(h => h.type === 'error').map(h => h.text)).toEqual(['缺少角色', '出错：推进失败']);
  expect(log()).toContain('主控安排 · 四');
  engine.job.mockImplementationOnce(() => { throw new ConfigError('没有任务'); });
  session.submit('/status J0010');
  await vi.waitFor(() => expect(snap().history.at(-1)).toMatchObject({ type: 'error', text: '没有任务' }));
});

it('上一个任务的差异包含统计、截断和未跟踪说明，读取失败显示原因', async () => {
  const readDiff = vi.fn(async () => ({ stat: '统计', diff: '+新\n'.repeat(202), untracked: ['a', 'b'], error: '' }));
  const { session, snap, log } = await setup({ readDiff });
  session.submit('/diff');
  expect(log()).toContain('上一个任务没有改动文件。');
  session.submit('改动');
  await session.whenIdle();
  session.submit('/diff');
  await vi.waitFor(() => expect(log()).toContain('统计\n\n' + '+新\n'.repeat(200) + '…还有 2 行，用 git diff 查看完整内容。'));
  expect(readDiff).toHaveBeenCalledWith('/项目/rise', ['a.ts']);
  expect(log()).toContain('新文件（尚未被 git 跟踪，不在上面的差异里）：a、b');
  readDiff.mockResolvedValueOnce({ stat: '', diff: '', untracked: [], error: '无法读取' });
  session.submit('/diff');
  await vi.waitFor(() => expect(snap().history.at(-1)).toMatchObject({ type: 'error', text: '无法读取' }));
});

it('状态栏按角色表顺序列出全部担当者，标记优先保留的角色和首选异常，刷新失败保留上次值', async () => {
  const { session, engine, snap } = await setup();
  const status = snap().status;
  expect(status).toEqual({ project: 'rise', roles: [
    { label: '主控', holder: 'claude', degraded: false, priority: true },
    { label: '实现', holder: 'codex', degraded: true, priority: true },
    { label: '测试', holder: 'codex', degraded: false, priority: false },
    { label: '审查', holder: 'claude', degraded: false, priority: true },
    { label: '杂活', holder: 'claude', degraded: false, priority: false }] });
  engine.rolesView.mockRejectedValueOnce(new Error('探测失败'));
  session.submit('/role coder reset');
  await Promise.resolve();
  expect(engine.rolesView).toHaveBeenCalledTimes(2);
  expect(snap().status).toBe(status);
});

it('首屏按担当者匹配型号，临时换人后更新，额度探测失败仍保留角色型号', async () => {
  const { session, snap, engine } = await setup({}, DEFAULT_ROWS, [
    { id: 'claude', model: 'claude-fable-5-2' }, { id: 'codex' }, { id: '另一家', model: '另一型号' },
  ]);
  expect(snap().status.roles.map(r => r.model)).toEqual(['claude-fable-5-2', undefined, undefined, 'claude-fable-5-2', 'claude-fable-5-2']);
  const rows = await engine.rolesView();
  engine.rolesView.mockResolvedValue(rows.map(r => r.id === 'coder' ? { ...r, holder: '另一家' } : r));
  session.submit('/role coder 另一家');
  await vi.waitFor(() => expect(snap().status.roles[1]).toMatchObject({ holder: '另一家', model: '另一型号' }));

  const previous = snap().status;
  engine.agentsView.mockRejectedValueOnce(new Error('无法读取 AI'));
  session.submit('/health');
  await vi.waitFor(() => expect(snap().status).not.toBe(previous));
  expect(snap().status.roles[1]?.model).toBe('另一型号');
  expect(snap().status.roles.map(r => r.holder)).toEqual(['claude', '另一家', 'codex', 'claude', 'claude']);
  session.submit('任务');
  await session.whenIdle();
  expect(snap().status.roles[1]?.model).toBe('另一型号');
});

it('只有主控、可写角色、审查三个角色时，状态栏的角色与改动前一致且都优先保留', async () => {
  const rows = DEFAULT_ROWS.filter(r => ['lead', 'coder', 'review'].includes(r.id));
  const { snap } = await setup({}, rows);
  expect(snap().status).toEqual({ project: 'rise', roles: [
    { label: '主控', holder: 'claude', degraded: false, priority: true },
    { label: '实现', holder: 'codex', degraded: true, priority: true },
    { label: '审查', holder: 'claude', degraded: false, priority: true }] });
});

it('优先保留的可写角色是主控与审查之外的第一个可写角色，其余角色照角色表顺序列出', async () => {
  const { snap } = await setup({}, [
    { id: 'helper', label: '杂活', holder: 'claude', access: 'write', state: 'ok' },
    { id: 'lead', label: '主控', holder: 'claude', access: 'write', state: 'ok' },
    { id: 'coder', label: '实现', holder: 'codex', access: 'write', state: 'ok' },
    { id: 'review', label: '审查', holder: 'codex', access: 'write', state: 'ok' },
    { id: 'docs', label: '文档', access: 'write', state: 'unavailable' },
  ]);
  expect(snap().status.roles).toEqual([
    { label: '杂活', holder: 'claude', degraded: false, priority: true },
    { label: '主控', holder: 'claude', degraded: false, priority: true },
    { label: '实现', holder: 'codex', degraded: false, priority: false },
    { label: '审查', holder: 'codex', degraded: false, priority: true },
    { label: '文档', holder: undefined, degraded: true, priority: false }]);
});

it('/roles 保留角色表，/agents 在可用状态和版本后列出额度', async () => {
  const { session, engine, snap } = await setup(undefined, undefined, [
    { id: 'codex', quota: { free: false, windows: [{ id: '周', usedPercent: 37 }] } },
  ]);
  session.submit('/roles');
  session.submit('/agents');
  await session.whenIdle();
  const views = await engine.rolesView() as unknown as Parameters<typeof formatRoles>[0];
  expect(snap().history.filter(h => h.type === 'text').map(h => 'text' in h && h.text))
    .toEqual([formatRoles(views, 'auto'), 'codex：可用 · 版本 · 额度 周 37%']);
});

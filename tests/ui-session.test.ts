import { expect, it, vi } from 'vitest';
import { ConfigError } from '../src/core/util.js';
import { plan, setup, step } from './ui-session-helper.js';

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
  for (const part of ['当前担当：codex', 'codex：可用 · 版本', 'J0001 完成 · 任务', '[J0001] 完成', '已指定', '已恢复',
    '正在检查，会实际调用一次 AI…', 'codex：可用 — 正常', '/diff ', '/plain ', '/exit ', '不认识的指令：/未知',
    '这个指令只在常驻运行的渠道里有意义。', '当前没有正在运行的任务。', '用法：/approve <任务号>', 'J0003 · 继续执行已批准的计划']) expect(log()).toContain(part);
  expect(engine.jobs).toHaveBeenCalledWith(10);
  expect(engine.job).toHaveBeenCalledWith('J0001');
  expect(engine.setRole).toHaveBeenCalledWith('coder', 'codex', false);
  expect(engine.approve).toHaveBeenCalledWith('J0003');
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

it('状态栏按主控、可写、审查排序，首选异常标黄，刷新失败保留上次值', async () => {
  const { session, engine, snap } = await setup();
  const status = snap().status;
  expect(status).toEqual({ project: 'rise', roles: [
    { label: '主控', holder: 'claude', degraded: false }, { label: '实现', holder: 'codex', degraded: true },
    { label: '审查', holder: 'claude', degraded: false }] });
  engine.rolesView.mockRejectedValueOnce(new Error('探测失败'));
  session.submit('/role coder reset');
  await Promise.resolve();
  expect(engine.rolesView).toHaveBeenCalledTimes(2);
  expect(snap().status).toBe(status);
});

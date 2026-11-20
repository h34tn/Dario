import { setImmediate } from 'node:timers/promises';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { RunApp } from '../src/ui/RunApp.js';
import { LiveJob } from '../src/ui/LiveJob.js';
import { PlanPrompt } from '../src/ui/PlanPrompt.js';
import { pickSymbols } from '../src/ui/theme.js';
import type { FeedState, StepView } from '../src/ui/feed.js';

afterEach(cleanup);

it.each(['', '终端'])('定稿行和动态区按终端符号显示，关闭颜色时没有转义字符 %s', session => {
  const symbols = pickSymbols({ WT_SESSION: session });
  const step: StepView = { index: 1, kind: 'plan', role: '主控', agent: 'claude', durationMs: 12000, startedAt: 0, state: 'done' };
  const view = render(<LiveJob jobId="J0012" title="主控安排 · 任务" now={23000} color={false} symbols={symbols}
    feed={{ lines: [{ type: 'step', key: '1', step }], current: { ...step, kind: 'review', state: 'running' },
      activities: ['读文件'], stopping: true }} />);
  const frames = view.frames.join('\n');
  expect(frames).toContain('J0012 · 主控安排 · 任务');
  expect(frames).toMatch(new RegExp('\\' + symbols.done + ' 计划\\s+主控 · claude\\s+12秒'));
  expect(view.lastFrame()).toContain('00:23');
  expect(view.lastFrame()).toContain('    读文件');
  expect(view.lastFrame()).toContain('正在终止');
  expect(frames).not.toContain('\x1b');
});

const plan = { summary: '', steps: [{ role: 'coder', writes: true, task: '第一行\n第二行', acceptance: '编译通过' }] };
it('收起时只写标题和定稿行，恢复后显示当前步骤、活动和计划确认', async () => {
  const step: StepView = { index: 1, kind: 'plan', role: '主控', startedAt: 0, state: 'done' };
  const props = { jobId: 'J0012', title: '任务标题', symbols: pickSymbols({}), color: false,
    inputEnabled: true, onError: vi.fn(), onInterrupt: vi.fn(),
    feed: { lines: [{ type: 'step', key: '1', step }], current: { ...step, role: '当前角色', state: 'running' },
      activities: ['读文件'], stopping: false } satisfies FeedState,
    prompt: { plan, roleLabel: () => '实现', color: false, onDecide: vi.fn() } };
  const view = render(<RunApp {...props} suspended />);
  await setImmediate();
  const output = view.frames.join('\n');
  expect(output).toContain('任务标题');
  expect(output).toContain('+ 计划   主控');
  expect(output).not.toMatch(/当前角色|读文件|执行吗/);
  view.rerender(<RunApp {...props} suspended={false} />);
  await vi.waitFor(() => {
    for (const text of ['当前角色', '读文件', '执行吗']) expect(view.lastFrame()).toContain(text);
  });
});

function showPrompt() {
  const onDecide = vi.fn();
  return { ...render(<PlanPrompt plan={plan} roleLabel={() => '实现（coder）'} color={false} onDecide={onDecide} />), onDecide };
}

it.each([['y', true], ['N', false], ['\x1b', false], ['\x03', false]] as const)('计划确认按键只决定一次 %j', async (key, answer) => {
  const view = showPrompt();
  await setImmediate();
  view.stdin.write(key);
  await vi.waitFor(() => expect(view.onDecide).toHaveBeenCalledWith(answer));
  view.stdin.write('y');
  expect(view.onDecide).toHaveBeenCalledTimes(1);
});

it('切换计划详情显示完整任务和验收条件', async () => {
  const view = showPrompt();
  await setImmediate();
  expect(view.lastFrame()).not.toContain('第二行');
  view.stdin.write('D');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('第一行\n' + ' '.repeat(17) + '第二行'));
  expect(view.lastFrame()).toContain('验收：编译通过');
  view.stdin.write('d');
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain('验收：'));
});

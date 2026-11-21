import { setImmediate } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { useState, type ReactElement } from 'react';
import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { CurrentStep } from '../src/ui/LiveJob.js';
import { StatusBar } from '../src/ui/StatusBar.js';
import { CommandMenu } from '../src/ui/CommandMenu.js';
import { PlanPrompt } from '../src/ui/PlanPrompt.js';
import { TextInput } from '../src/ui/TextInput.js';
import { EMPTY_EDITOR } from '../src/ui/editor.js';
import { GlyphContext } from '../src/ui/screen.js';
import type { StatusView } from '../src/ui/session.js';
import { displayWidth } from '../src/ui/text.js';
import { paint, pickSymbols, type Tone } from '../src/ui/theme.js';

const cursor = vi.hoisted(() => vi.fn());
vi.mock('ink', async importOriginal => ({
  ...await importOriginal<typeof import('ink')>(), useCursor: () => ({ setCursorPosition: cursor }),
}));
afterEach(cleanup);
const long = '·“中”'.repeat(20);
const glyphs = { wide: true, ellipsis: '...' };

async function narrow(tree: ReactElement, columns = 40, wide = glyphs.wide) {
  const view = render(<></>);
  Object.defineProperty(view.stdout, 'columns', { value: columns });
  view.rerender(<GlyphContext.Provider value={{ ...glyphs, wide }}>{tree}</GlyphContext.Provider>);
  await setImmediate();
  return view;
}

function check(frame: string) {
  expect(frame).not.toContain('…');
  for (const line of frame.split('\n')) expect(displayWidth(line, true)).toBeLessThanOrEqual(39);
}

it('只有三个角色时保留原有的状态栏文字', async () => {
  const status = { project: 'project', roles: [
    { label: '主控', holder: 'a1', degraded: false, priority: true },
    { label: '实现', holder: 'a2', degraded: false, priority: true },
    { label: '审查', holder: 'a3', degraded: false, priority: true },
  ] };
  const view = await narrow(<StatusBar status={status} queued={0} color={false} />, 80);
  expect(view.lastFrame()).toBe('project · 主控 a1 · 实现 a2 · 审查 a3');
});

const five: StatusView = { project: '项目', roles: [
  { label: '主控', holder: 'a1', degraded: false, priority: true },
  { label: '实现', holder: 'a2', degraded: true, priority: true },
  { label: '测试', degraded: true, priority: false },
  { label: '审查', holder: 'a3', degraded: false, priority: true },
  { label: '杂活', holder: 'a4', degraded: false, priority: false },
] };
// 依次收起的每一步。
const collapse = [
  '项目 · 主控 a1 · 实现 a2 · 测试 无可用 · 审查 a3 · 杂活 a4 · 排队 2 · 上文 J0001',
  '项目 · 主控 a1 · 实现 a2 · 测试 无可用 · 审查 a3 · 排队 2 · 上文 J0001',
  '项目 · 主控 a1 · 实现 a2 · 审查 a3 · 排队 2 · 上文 J0001',
  '项目 · 主控 a1 · 实现 a2 · 审查 a3 · 排队 2',
  '项目 · 主控 a1 · 实现 a2 · 审查 a3',
  '项目 · 主控 a1 · 实现 a2',
  '项目 · 主控 a1',
  '项目',
];

it.each(collapse)('状态栏在恰好留一格时显示「%s」', async expected => {
  const view = await narrow(<StatusBar status={five} queued={2} contextJobId="J0001" color={false} />,
    displayWidth(expected, glyphs.wide) + 1);
  expect(view.lastFrame()).toBe(expected);
});

it.each(collapse.map((line, i) => [line, collapse[i + 1] ?? '...']))('少一列时「%s」收起为「%s」', async (line, next) => {
  const view = await narrow(<StatusBar status={five} queued={2} contextJobId="J0001" color={false} />,
    displayWidth(line, glyphs.wide));
  expect(view.lastFrame()).toBe(next);
});

it('宽度不定的「·」按终端约定计宽：占一格时放得下的整行，占两格时要收起', async () => {
  const columns = displayWidth(collapse[0]!, false) + 1;
  expect(displayWidth(collapse[0]!, true)).toBeGreaterThan(columns - 1);
  const bar = <StatusBar status={five} queued={2} contextJobId="J0001" color={false} />;
  expect((await narrow(bar, columns, false)).lastFrame()).toBe(collapse[0]);
  expect((await narrow(bar, columns, true)).lastFrame()).toBe(collapse[1]);
});

it('担当者着色：正常用 AI 名的颜色，首选异常用警告色，无可用用失败色', async () => {
  const frame = (await narrow(<StatusBar status={five} queued={2} contextJobId="J0001" color />, 200)).lastFrame()!;
  expect(stripVTControlCharacters(frame)).toBe(collapse[0]);
  const tones: Array<[Tone, string]> = [['role', '主控'], ['agent', 'a1'], ['role', '实现'], ['warn', 'a2'], ['role', '测试'],
    ['fail', '无可用'], ['agent', 'a3'], ['role', '杂活'], ['agent', 'a4'], ['dim', '上文 J0001']];
  for (const [tone, text] of tones) expect(frame).toContain(paint(tone, text, true));
  expect(frame).not.toContain(paint('agent', 'a2', true));
});

it('四十列下活动、状态、菜单与两种计划视图都留有一格', async () => {
  const view = await narrow(<Box flexDirection="column">
    <CurrentStep now={0} symbols={pickSymbols({})} color={false} activityLines={[long]} feed={{ lines: [], stopping: false,
      activities: [long], current: { index: 0, kind: 'step', role: '实现', startedAt: 0, state: 'running' } }} />
    <StatusBar status={{ project: long, roles: [] }} color={false} queued={2} />
    <StatusBar status={{ project: '项目', roles: [] }} color queued={2} contextJobId={long} />
    <CommandMenu suggestions={[{ label: '短', value: '短', hint: long }]} color={false} />
    <CommandMenu suggestions={[{ label: long, value: '长', hint: '不可见' }]} color={false} />
    <PlanPrompt plan={{ summary: '', steps: [{ role: '实现', writes: true, task: long, acceptance: long }] }}
      roleLabel={role => role} color={false} onDecide={vi.fn()} />
  </Box>);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('执行吗'));
  const frame = view.lastFrame()!;
  expect(frame).toContain('    ·“中”');
  expect(frame).toContain('项目 · 排队 2');
  expect(frame).not.toContain('不可见');
  expect(frame).toContain('1. 实现  改文件  ·');
  check(frame);
  view.stdin.write('d');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('验收：'));
  const expanded = view.lastFrame()!;
  check(expanded);
  const body = expanded.slice(expanded.indexOf('1. 实现'), expanded.indexOf('执行吗'));
  expect(body.replace(/\s/g, '')).toBe('1.实现改文件' + long + '验收：' + long);
});

it('宽字符光标按真实列定位，长输入继续键入时窗口跟随行尾', async () => {
  function Input() {
    const [state, onChange] = useState(EMPTY_EDITOR);
    return <TextInput state={state} onChange={onChange} onSubmit={vi.fn()} color={false} row={0} />;
  }
  const view = await narrow(<Input />);
  view.stdin.write('a·b');
  await vi.waitFor(() => expect(view.lastFrame()).toBe('> a·b'));
  expect(cursor).toHaveBeenLastCalledWith({ x: 6, y: 0 });
  for (const [input, end] of [[long, '”'], ['尾', '尾']]) {
    view.stdin.write(input!);
    await vi.waitFor(() => expect(view.lastFrame()?.endsWith(end!)).toBe(true));
    const frame = view.lastFrame()!;
    expect(frame.startsWith('> a·b')).toBe(true);
    const lines = frame.split('\n');
    expect(lines.slice(1).every(line => line.startsWith('  '))).toBe(true);
    check(frame);
    expect(cursor).toHaveBeenLastCalledWith({ x: displayWidth(lines.at(-1)!, true), y: lines.length - 1 });
  }
});

it('十个屏幕行只显示八行，首末标注随光标移动并计入高度', async () => {
  function Input() {
    const [state, onChange] = useState({ ...EMPTY_EDITOR, value: Array(10).fill('中').join('\n'), cursor: 0 });
    return <TextInput state={state} onChange={onChange} onSubmit={vi.fn()} color={false} row={2} />;
  }
  const view = await narrow(<Input />, 40, false);
  expect(view.lastFrame()!.split('\n')).toEqual(['> 中', ...Array(6).fill('  中'), '  ... 下面还有 3 行']);
  expect(cursor).toHaveBeenLastCalledWith({ x: 2, y: 2 });
  for (let i = 0; i < 9; i++) view.stdin.write('\x1b[B');
  await vi.waitFor(() => expect(view.lastFrame()!.split('\n')).toEqual(['  ... 上面还有 3 行', ...Array(7).fill('  中')]));
  expect(cursor).toHaveBeenLastCalledWith({ x: 2, y: 9 });
});

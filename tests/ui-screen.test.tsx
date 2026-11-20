import { setImmediate } from 'node:timers/promises';
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
import { displayWidth } from '../src/ui/text.js';
import { pickSymbols } from '../src/ui/theme.js';

const cursor = vi.hoisted(() => vi.fn());
vi.mock('ink', async importOriginal => ({
  ...await importOriginal<typeof import('ink')>(), useCursor: () => ({ setCursorPosition: cursor }),
}));
afterEach(cleanup);
const long = '·“中”'.repeat(20);
const glyphs = { wide: true, ellipsis: '...' };

async function narrow(tree: ReactElement) {
  const view = render(<></>);
  Object.defineProperty(view.stdout, 'columns', { value: 40 });
  view.rerender(<GlyphContext.Provider value={glyphs}>{tree}</GlyphContext.Provider>);
  await setImmediate();
  return view;
}

function check(frame: string) {
  expect(frame).not.toContain('…');
  for (const line of frame.split('\n')) expect(displayWidth(line, true)).toBeLessThanOrEqual(39);
}

it('四十列下活动、状态、菜单与两种计划视图都留有一格', async () => {
  const view = await narrow(<Box flexDirection="column">
    <CurrentStep now={0} symbols={pickSymbols({})} color={false} feed={{ lines: [], stopping: false,
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
    expect(frame.startsWith('> ...')).toBe(true);
    check(frame);
    expect(cursor).toHaveBeenLastCalledWith({ x: displayWidth(frame, true), y: 0 });
  }
});

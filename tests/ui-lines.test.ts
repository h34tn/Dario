import { createElement } from 'react';
import { stripVTControlCharacters as plain } from 'node:util';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createLineCache, itemLines, planLines, stepText, wrapAnsi } from '../src/ui/lines.js';
import { StepRow } from '../src/ui/LiveJob.js';
import { paint, pickSymbols } from '../src/ui/theme.js';
import { displayWidth } from '../src/ui/text.js';
import type { HistoryItem } from '../src/ui/session.js';
import type { StepView } from '../src/ui/feed.js';

afterEach(cleanup);
const ctx = { symbols: pickSymbols({}), color: true, wide: false };
const step: StepView = { index: 1, kind: 'step', role: '实现', agent: '助手', state: 'done', startedAt: 0, durationMs: 2000 };

it('收起计划每步一行，展开时完整保留说明和验收并按显示格数对齐', () => {
  const task = '检查·“内容”'.repeat(8) + '\n下一项';
  const acceptance = '通过·“验收”'.repeat(8);
  const plan = { summary: '', steps: [{ role: '实现', task, acceptance, writes: true }, { role: '审查', task: '复核', writes: false }] };
  const prefix = '1. 实现  改文件  ';
  for (const color of [true, false]) {
    const lines = (details: boolean) => planLines(plan, id => id, details, 40, { ...ctx, wide: true, color });
    const brief = lines(false);
    expect(brief).toHaveLength(3);
    expect(plain(brief[1])).toMatch(/\.\.\.$/);
    const full = lines(true);
    expect([...full, ...brief].every(line => displayWidth(line, true) <= 40)).toBe(true);
    if (!color) expect(full.join('')).not.toContain('\x1b');
    const content = full.map(plain);
    const split = content.findIndex(line => line.startsWith('验收：'));
    const tasks = content.slice(1, split);
    expect(tasks[0].startsWith(prefix)).toBe(true);
    expect(tasks.slice(1).every(line => line.startsWith(' '.repeat(displayWidth(prefix, true))))).toBe(true);
    expect(tasks.join('').replace(prefix, '').replaceAll(' ', '')).toBe(task.replace('\n', ''));
    expect(content.slice(split, -1).join('').replaceAll(' ', '')).toBe('验收：' + acceptance);
    expect(content.at(-1)).toBe('2. 审查  只读  复核');
  }
});

it.each([
  ['abcde', 2, ['ab', 'cd', 'e']],
  ['中文汉字', 5, ['中文', '汉字']],
  ['a中文b', 3, ['a中', '文b']],
  ['字👍🏽👨‍👩‍👧', 3, ['字', '👍🏽', '👨‍👩‍👧']],
] as const)('按格数折行并保留完整字素：%s', (text, width, expected) => {
  const rows = wrapAnsi(text, width, false);
  expect(rows).toEqual(expected);
  expect(rows.join('')).toBe(text);
  expect(rows.every(row => displayWidth(row) <= width)).toBe(true);
});

it('比单个字素还窄时仍完整保留它', () => {
  for (const width of [-1, 0, 1]) expect(wrapAnsi('字👍🏽👨‍👩‍👧', width, false)).toEqual(['字', '👍🏽', '👨‍👩‍👧']);
});

it('宽度不定的字符按终端选择格数', () => {
  expect(wrapAnsi('·…“”', 2, false)).toEqual(['·…', '“”']);
  expect(wrapAnsi('·…“”', 2, true)).toEqual(['·', '…', '“', '”']);
});

it('保留空行、展开制表符、移除响铃、光标指令和控制串', () => {
  expect(wrapAnsi('a\r\n\n\x07b\t\x1b[3Dc\x1b]0;标题\x07\x1bP内容\x1b\\\n', 4, false))
    .toEqual(['a', '', 'b   ', ' c', '']);
  expect(wrapAnsi('', 2, false)).toEqual(['']);
  expect(wrapAnsi('甲\r乙\x7f丙', 8, false)).toEqual(['甲乙丙']);
});

it('绿色跨三行，每行可单独显示，加粗与颜色分别复位', () => {
  expect(wrapAnsi(paint('done', 'abcdef', true), 2, false)).toEqual([
    '\x1b[32mab\x1b[0m', '\x1b[32mcd\x1b[0m', '\x1b[32mef\x1b[39m\x1b[0m',
  ]);
  const rows = wrapAnsi('\x1b[1;32mab\nc\x1b[22md\ne\x1b[39mf\ng', 2, false);
  expect(rows[1]).toBe('\x1b[1m\x1b[32mc\x1b[22md\x1b[0m');
  expect(rows[2]).toBe('\x1b[32me\x1b[39mf\x1b[0m');
  expect(rows[3]).toBe('g');
  expect(wrapAnsi('\x1b[2;92ma\n\nb', 1, false)).toEqual(['\x1b[2;92ma\x1b[0m', '', '\x1b[2m\x1b[92mb\x1b[0m']);
});

it('未跟踪的样式按原样输出，扩展颜色的分量不会被当成加粗或暗色', () => {
  const rows = wrapAnsi('\x1b[4;38;2;1;2;31ma\nb', 1, false);
  expect(rows).toEqual(['\x1b[4;38;2;1;2;31ma\x1b[0m', 'b']);
});

it('字素内部的颜色指令也不改变折行位置', () => {
  const colored = 'a👍\x1b[32m🏽中\x1b[39m文\nb';
  for (const width of [1, 2, 3, 4]) {
    expect(wrapAnsi(colored, width, true).map(plain)).toEqual(wrapAnsi(plain(colored), width, true));
  }
});

it.each(['', '终端'])('两套符号的步骤文字均与组件和原有格式一致：%s', session => {
  const symbols = pickSymbols({ WT_SESSION: session });
  for (const [state, stopping, suffix] of [
    ['running', false, ''], ['running', true, '  正在终止…'], ['done', false, ''],
    ['failed', false, '  未完成'], ['timeout', false, '  超时'],
  ] as const) {
    const opts = { symbols, now: 1000, color: true, stopping };
    const current = { ...step, state };
    const text = plain(stepText(current, opts));
    const symbol = state === 'running' ? symbols.frames[4 % symbols.frames.length] : state === 'done' ? symbols.done : symbols.fail;
    expect(text).toBe(symbol + ' 执行   实现 · 助手   ' + (state === 'running' ? '00:01' : '2秒') + suffix);
    expect(render(createElement(StepRow, { ...opts, color: false, step: current })).lastFrame()).toBe(text);
  }
});

it('七种历史条目保留各自的符号和配色，关闭颜色时也清除原文颜色', () => {
  const cases: [HistoryItem, string][] = [
    [{ id: 0, type: 'banner', text: '欢迎' }, paint('title', '欢迎', true)],
    [{ id: 1, type: 'title', text: '任务' }, paint('title', '任务', true)],
    [{ id: 2, type: 'input', text: '输入' }, paint('role', '> ', true) + '输入'],
    [{ id: 3, type: 'notice', text: '提示' }, paint('warn', '! 提示', true)],
    [{ id: 4, type: 'error', text: '失败' }, paint('fail', 'x 失败', true)],
    [{ id: 5, type: 'text', text: paint('role', '记录', true) }, paint('role', '记录', true)],
    [{ id: 6, type: 'step', step }, stepText(step, { ...ctx, now: 0 })],
  ];
  for (const [item, expected] of cases) {
    expect(itemLines(item, 80, ctx)[0]).toContain(expected);
    expect(itemLines(item, 80, { ...ctx, color: false })).toEqual([plain(expected)]);
  }
  for (const type of ['text', 'input'] as const) {
    const rows = itemLines({ id: 7, type, text: '中文'.repeat(20) }, 7, ctx);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every(row => displayWidth(plain(row)) <= 7)).toBe(true);
  }
});

it('缓存保持数组身份，只计算新条目，宽度、配色、宽字符或符号变化后重算', () => {
  const cache = createLineCache();
  const read = vi.fn(() => '甲乙');
  const history: HistoryItem[] = [{ id: 0, type: 'text', get text() { return read(); } }];
  const first = cache.lines(history, 4, ctx);
  expect(cache.lines(history, 4, ctx)).toBe(first);
  history.push({ id: 1, type: 'text', text: 'abc' });
  expect(cache.lines(history, 4, ctx)).toEqual([...first, 'abc']);
  expect(first).toEqual(['甲乙']);
  expect(read).toHaveBeenCalledTimes(1);
  expect(cache.lines(history, 2, ctx)).toEqual(['甲', '乙', 'ab', 'c']);
  cache.lines(history, 2, { ...ctx, wide: true });
  cache.lines(history, 2, { ...ctx, color: false, wide: true });
  cache.lines(history, 2, { ...ctx, color: false, wide: true, symbols: pickSymbols({ WT_SESSION: '终端' }) });
  expect(read).toHaveBeenCalledTimes(5);
});

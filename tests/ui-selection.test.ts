import { stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
import { createLineCache, wrapAnsi, type RowLayout } from '../src/ui/lines.js';
import { highlight, paragraph, selectedText, word } from '../src/ui/selection.js';
import { pickSymbols } from '../src/ui/theme.js';

const ctx = { symbols: pickSymbols({}), color: true, wide: false };
const point = (line: number, col: number) => ({ line, col });

it('正反向拖选宽字半格，去色和行尾空白，保留硬换行', () => {
  const cache = createLineCache();
  const lines = cache.lines([{ type: 'text', id: 1, text: '\x1b[32m甲乙abc\n丙   \n丁' }], 4, ctx);
  expect(cache.joins.map(row => row.continuation)).toEqual([false, true, false, true, false]);
  const start = point(0, 3), end = point(4, 0);
  expect(selectedText(lines, cache.joins, { start, end }, false)).toBe('乙abc\n丙\n丁');
  expect(selectedText(lines, cache.joins, { start: end, end: start }, false)).toBe('乙abc\n丙\n丁');
});

it('三击包含整段续行，复制回显移除铺底和续行缩进', () => {
  const cache = createLineCache();
  const lines = cache.lines([{ type: 'input', id: 2, text: '甲乙abcdef\n后文' }], 7, ctx);
  const range = paragraph(lines, cache.joins, point(1, 3), false);
  expect(selectedText(lines, cache.joins, range, false)).toBe('> 甲乙abcdef');
});

it('反显保留宽字和原色，空范围保持原样', () => {
  const line = 'a\x1b[32m中\x1b[0m文b';
  expect(highlight(line, [2, 3], false)).toBe('a\x1b[32m\x1b[7m中\x1b[0m\x1b[7m文\x1b[27mb');
  expect(highlight(line, [7, 8], false)).toBe(line);
  expect(highlight(line, undefined, false)).toBe(line);
  expect(highlight('👍\x1b[31m🏽a', [1, 1], false)).toBe('\x1b[7m👍\x1b[31m\x1b[7m🏽\x1b[27ma');
});

it('双击路径和邮箱符号跨折行，中日韩连续，标点独立，空白无选区', () => {
  const lines = ['a_b-9./\\:', '@z中あ한。! '], joins = [{ continuation: false }, { continuation: true }];
  const at = (col: number) => {
    const selection = word(lines, joins, point(1, col), false);
    return selection && selectedText(lines, joins, selection, false);
  };
  expect(at(0)).toBe('a_b-9./\\:@z');
  expect(at(3)).toBe('中あ한');
  expect(at(8)).toBe('。');
  expect(at(10)).toBe('!');
  expect(at(11)).toBeUndefined();
});

it('双击中文跨过回显补齐的半格空白，但原有空格仍然分词', () => {
  const cache = createLineCache();
  const lines = cache.lines([{ type: 'input', id: 3, text: '甲乙丙 丁' }], 7, ctx);
  const range = word(lines, cache.joins, point(1, 2), false)!;
  expect(selectedText(lines, cache.joins, range, false)).toBe('甲乙丙');
  expect(word(lines, cache.joins, point(0, 6), false)).toBeUndefined();
});

it('折行处的空格是原文，跨续行复制时保留；段尾的空白和排版补的空格去掉', () => {
  const joins: RowLayout[] = [];
  const rows = wrapAnsi('写进给 Codex 的返工意见：去掉内置的清单', 14, true, joins);
  // 第一行折在 "Codex " 之后，行尾这个空格属于原文
  expect(stripVTControlCharacters(rows[0]!)).toBe('写进给 Codex ');
  expect(joins.map(j => j.continuation)).toEqual([false, true, true]);
  const all = { start: { line: 0, col: 0 }, end: { line: rows.length - 1, col: 200 } };
  expect(selectedText(rows, joins, all, true)).toBe('写进给 Codex 的返工意见：去掉内置的清单');
  // 只选第一行：这是选区的结尾，行尾空白去掉
  expect(selectedText(rows, joins, { start: { line: 0, col: 0 }, end: { line: 0, col: 200 } }, true)).toBe('写进给 Codex');
  // 排版补的空格（padding）即使后面跟着续行也不算原文
  const padded = ['ab    ', 'cd    '];
  const layout = [{ continuation: false, padding: 4 }, { continuation: true, padding: 4 }];
  expect(selectedText(padded, layout, { start: { line: 0, col: 0 }, end: { line: 1, col: 200 } }, true)).toBe('abcd');
});

import { stripVTControlCharacters } from 'node:util';
import type { RowLayout } from './lines.js';
import { displayWidth, graphemes } from './text.js';

/** 历史行和显示列都从零开始，两个端点均包含在内。 */
export interface Point { line: number; col: number }
export interface Selection { start: Point; end: Point }
type Range = readonly [number, number];

function ordered({ start, end }: Selection): [Point, Point] {
  return start.line < end.line || (start.line === end.line && start.col <= end.col)
    ? [start, end] : [end, start];
}

export function columns(selection: Selection | undefined, line: number): Range | undefined {
  if (!selection) return;
  const [a, b] = ordered(selection);
  if (line < a.line || line > b.line) return;
  return [line === a.line ? a.col : 0, line === b.line ? b.col : Infinity];
}

function* cells(plain: string, wide: boolean) {
  let col = 0, index = 0;
  for (const glyph of graphemes(plain)) {
    const next = col + displayWidth(glyph, wide);
    yield { glyph, col, last: next - 1, index };
    col = next;
    index += glyph.length;
  }
}

function offsets(plain: string, [first, last]: Range, wide: boolean): Range | undefined {
  if (first > last) return;
  let start: number | undefined, end = 0;
  for (const cell of cells(plain, wide)) {
    if (cell.col > last) break;
    if (cell.last < first) continue;
    start ??= cell.index;
    end = cell.index + cell.glyph.length;
  }
  if (start !== undefined) return [start, end];
}

export function selectedText(lines: string[], joins: readonly RowLayout[], selection: Selection, wide: boolean): string {
  const [a, b] = ordered(selection);
  let result = '';
  for (let i = a.line; i <= b.line && i < lines.length; i++) {
    const layout = joins[i];
    // 一段文字到头了（遇到真正的换行）：这一段末尾的空白去掉。
    // 自动折行处的空白是原文里的（例如英文单词后的空格），续行直接接上，不能去。
    if (i > a.line && !layout?.continuation) result = trimLineEnd(result) + '\n';
    const [first, last] = columns(selection, i)!;
    const plain = stripVTControlCharacters(lines[i]);
    const range = offsets(plain, [Math.max(first, layout?.indent ?? 0), last], wide);
    if (!range) continue;
    let piece = plain.slice(...range);
    // 排版补在行尾的空格不是原文，先去掉
    if (layout?.padding) piece = piece.replace(new RegExp(` {0,${layout.padding}}$`), '');
    result += piece;
  }
  return trimLineEnd(result);
}

/** 只去掉末尾的空格和制表符，不动换行（选区里的空行要保留）。 */
function trimLineEnd(text: string): string {
  return text.replace(/[ \t　]+$/, '');
}

/** 历史排版已清除非 SGR 控制串，先按字素定位再映射回带色行。 */
export function highlight(line: string, range: Range | undefined, wide: boolean): string {
  if (!range) return line;
  const bounds = offsets(stripVTControlCharacters(line), range, wide);
  if (!bounds) return line;
  let index = 0, inverse = false;
  return line.replace(/\x1b\[([\d;:]*)m|[\s\S]/gu, (part, params?: string) => {
    if (params !== undefined) {
      const codes = params.split(';');
      for (let i = 0; i < codes.length; i++) {
        const code = Number(codes[i]);
        if ([38, 48, 58].includes(code)) i += codes[i + 1] === '2' ? 4 : codes[i + 1] === '5' ? 2 : 0;
        else if (code === 0 || code === 27) inverse = false;
        else if (code === 7) inverse = true;
      }
      return part + (!inverse && index > bounds[0] && index < bounds[1] ? '\x1b[7m' : '');
    }
    const open = index === bounds[0] ? '\x1b[7m' : '';
    index += part.length;
    return open + part + (index === bounds[1] && !inverse ? '\x1b[27m' : '');
  });
}

export function paragraph(lines: string[], joins: readonly RowLayout[], point: Point, wide: boolean): Selection {
  let first = point.line, last = point.line;
  while (first > 0 && joins[first]?.continuation) first--;
  while (last + 1 < lines.length && joins[last + 1]?.continuation) last++;
  return { start: { line: first, col: 0 }, end: { line: last, col: Math.max(0, displayWidth(stripVTControlCharacters(lines[last]), wide) - 1) } };
}

function wordClass(glyph: string) {
  if (/^\s/u.test(glyph)) return '空白';
  if (/^[\p{L}\p{N}]/u.test(glyph) && /^[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u.test(glyph)) return '中日韩';
  if (/^[\p{L}\p{N}_.\/\\:@-]/u.test(glyph)) return '词';
  return '单字';
}

export function word(lines: string[], joins: readonly RowLayout[], point: Point, wide: boolean): Selection | undefined {
  const { start, end } = paragraph(lines, joins, point, wide);
  let run: Selection | undefined, previous = '', hit = false;
  for (let line = start.line; line <= end.line; line++) {
    const raw = stripVTControlCharacters(lines[line]);
    const layout = joins[line];
    const plain = raw.slice(0, raw.length - (layout?.padding ?? 0));
    for (const cell of cells(plain, wide)) {
      if (cell.col < (layout?.indent ?? 0)) continue;
      const kind = wordClass(cell.glyph);
      if (!run || previous !== kind || kind === '单字') {
        if (hit) return run;
        run = { start: { line, col: cell.col }, end: { line, col: cell.last } };
      }
      previous = kind;
      run.end = { line, col: cell.last };
      if (line === point.line && point.col >= cell.col && point.col <= cell.last) {
        if (kind === '空白') return;
        hit = true;
      }
    }
  }
  if (hit) return run;
}

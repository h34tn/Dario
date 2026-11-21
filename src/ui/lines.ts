import { formatDuration, formatTokens } from '../core/util.js';
import { formatFallbackQuestion } from '../core/report.js';
import type { FallbackQuestion, Plan } from '../core/types.js';
import { shortRole, type StepView } from './feed.js';
import type { HistoryItem } from './session.js';
import { clip, displayWidth, graphemes } from './text.js';
import { INPUT_BAND, paint, type Symbols } from './theme.js';

const reset = '\x1b[0m';
// 控制串（含 OSC、DCS）、CSI、普通 ESC 指令和单个控制字符，保留换行和制表符另行处理。
const controls = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?|\x1b[ -/]*[0-~]?|\r(?!\n)|[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g;
const sgr = /^\x1b\[([\d;:]*)m$/;

function track(styles: Set<number>, params: string): void {
  const codes = params.split(';');
  for (let i = 0; i < codes.length; i++) {
    const code = Number(codes[i]);
    if (code === 38 || code === 48 || code === 58) {
      // 扩展颜色的分量不是独立的样式参数。
      if (codes[i + 1] === '5') i += 2;
      else if (codes[i + 1] === '2') i += 4;
    } else if (code === 0) styles.clear();
    else if (code === 22) { styles.delete(1); styles.delete(2); }
    else if (code === 1 || code === 2) styles.add(code);
    else if (code === 39 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      for (const active of styles) if (active >= 30) styles.delete(active);
      if (code !== 39) styles.add(code);
    }
  }
}

/** 先在纯文字上划分字素，再按原位置放回颜色，允许同一个字素内部换色。 */
export function wrapAnsi(text: string, width: number, wide: boolean): string[] {
  width = Math.max(1, Math.floor(width) || 1);
  const marks: { at: number; raw: string; params: string }[] = [];
  let plain = '';
  let start = 0;
  for (const match of text.matchAll(controls)) {
    plain += text.slice(start, match.index).replaceAll('\t', '    ');
    const style = sgr.exec(match[0]);
    if (style) marks.push({ at: plain.length, raw: match[0], params: style[1] });
    start = match.index + match[0].length;
  }
  plain += text.slice(start).replaceAll('\t', '    ');

  const styles = new Set<number>();
  const lines: string[] = [];
  let line = '', used = 0, hasText = false, pos = 0, next = 0;
  function addMarks() {
    while (marks[next]?.at === pos) {
      const { raw, params } = marks[next++];
      line += raw;
      track(styles, params);
    }
  }
  function finish() {
    lines.push(hasText ? line + (line.includes('\x1b') && !line.endsWith(reset) ? reset : '') : '');
    line = Array.from(styles, code => `\x1b[${code}m`).join('');
    used = 0;
    hasText = false;
  }
  addMarks();
  for (const glyph of graphemes(plain)) {
    const end = pos + glyph.length;
    if (glyph === '\n' || glyph === '\r\n') {
      finish();
    } else {
      // 视口比单个字素还窄时，完整保留该字素并让它独占一行。
      const size = displayWidth(glyph, wide);
      if (used + size > width && hasText) finish();
      used += size;
      hasText = true;
      while (next < marks.length && marks[next].at < end) {
        line += plain.slice(pos, marks[next].at);
        pos = marks[next].at;
        addMarks();
      }
      line += plain.slice(pos, end);
    }
    pos = end;
    addMarks();
  }
  finish();
  return lines;
}

const phases = { plan: '计划', step: '执行', review: '审查', rework: '返工', summary: '汇总' };

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

export function stepText(step: StepView, { now, symbols, color, stopping, ellipsis = '…' }: {
  now: number; symbols: Symbols; color: boolean; stopping?: boolean; ellipsis?: string;
}): string {
  const running = step.state === 'running';
  const tone = running ? 'dim' : step.state === 'done' ? 'done' : 'fail';
  const symbol = tone === 'dim' ? symbols.frames[Math.floor(now / 250) % symbols.frames.length] : symbols[tone];
  const suffix = running && stopping ? '正在终止' + ellipsis : step.state === 'timeout' ? '超时' : step.state === 'failed' ? '未完成' : '';
  const time = running ? elapsed(now - step.startedAt) : formatDuration(step.durationMs ?? 0);
  // 输入只显示没命中缓存的部分，也就是这一步真正新发给模型的内容。每次请求都会重发全部历史，
  // 命中缓存的那部分随请求次数成倍累加（十次请求能到几十万），价格却很低，算进来只会让人误以为烧了那么多。
  const tokens = step.tokens
    ? ' · ' + symbols.up + ' ' + formatTokens(Math.max(0, step.tokens.input - step.tokens.cachedInput))
      + ' ' + symbols.down + ' ' + formatTokens(step.tokens.output) + ' tokens'
    : '';
  return paint(tone, symbol, color) + ' ' + phases[step.kind] + '   ' + paint('role', step.role, color)
    + (step.agent ? ' · ' + paint('agent', step.agent, color) : '') + '   ' + paint('dim', time + tokens, color)
    + (suffix ? '  ' + suffix : '');
}

export interface LineContext { symbols: Symbols; color: boolean; wide: boolean }

/** 计划确认在历史区里显示的行。展开后保留任务说明和验收的换行。 */
export function planLines(plan: Plan, roleLabel: (id: string) => string, details: boolean, width: number, ctx: LineContext): string[] {
  const { symbols, color, wide } = ctx;
  const fit = (text: string, max: number) => clip(text, max, wide, symbols.ellipsis);
  const clean = (text: string) => text.replace(/\r\n/g, '\n').replace(controls, '').replaceAll('\t', '    ');
  const rows = [paint('warn', fit('这份计划会改动文件：', width), color)];
  function append(prefix: string, styled: string, body: string) {
    const indent = displayWidth(prefix, wide);
    const remaining = width - indent;
    if (remaining < (details ? 2 : 1)) {
      rows.push(fit(prefix, width));
      if (details) rows.push(...wrapAnsi(body, width, wide));
      return;
    }
    const lines = details ? wrapAnsi(body, remaining, wide) : [fit(body.split('\n', 1)[0], remaining)];
    lines.forEach((line, i) => rows.push((i ? ' '.repeat(indent) : styled) + line));
  }
  for (const [i, step] of plan.steps.entries()) {
    const role = shortRole(roleLabel(step.role)).replace(controls, '').replace(/\s/g, ' ');
    const suffix = step.writes ? '  改文件  ' : '  只读  ';
    const number = String(i + 1) + '. ';
    append(number + role + suffix, number + paint('role', role, color) + suffix, clean(step.task));
    if (details && step.acceptance) append('验收：', '验收：', clean(step.acceptance));
  }
  return rows;
}

/** 输入回显：着色时整行铺灰色底，一眼能和程序的输出分开；续行缩进对齐到提示符之后。 */
function inputLines(text: string, width: number, { color, wide }: LineContext): string[] {
  const clean = text.replace(controls, '').replaceAll('\t', '    ');
  if (!color || width < 4) return wrapAnsi('> ' + clean, width, wide);
  return wrapAnsi(clean, width - 2, wide).map((row, i) => {
    const pad = ' '.repeat(Math.max(0, width - 2 - displayWidth(row, wide)));
    return INPUT_BAND.open + (i ? '  ' : paint('role', '>', true) + ' ') + INPUT_BAND.text + row + pad + INPUT_BAND.close;
  });
}

export const FALLBACK_HINT = '改用备选继续吗？  y 继续   n 停止任务';

/** 换人询问显示的行：谁不可用、为什么、打算改用谁（带模型）。 */
export function fallbackLines(question: FallbackQuestion, width: number, { symbols, color, wide }: LineContext): string[] {
  const [down, ask] = formatFallbackQuestion(question);
  const rows = [...wrapAnsi(symbols.warn + ' ' + down, width, wide), ...wrapAnsi('  ' + ask, width, wide)];
  return rows.map(row => paint('warn', row, color));
}

export function itemLines(item: HistoryItem, width: number, ctx: LineContext): string[] {
  const { symbols, color, wide } = ctx;
  if (item.type === 'input') return inputLines(item.text, width, ctx);
  let text: string;
  switch (item.type) {
    case 'banner':
    case 'title': text = paint('title', item.text, color); break;
    case 'notice': text = paint('warn', symbols.warn + ' ' + item.text, color); break;
    case 'error': text = paint('fail', symbols.fail + ' ' + item.text, color); break;
    case 'text': text = item.text; break;
    case 'step': text = stepText(item.step, { now: 0, symbols, color }); break;
  }
  return wrapAnsi(color ? text : text.replace(controls, ''), width, wide);
}

export interface LineCache {
  lines(history: HistoryItem[], width: number, ctx: LineContext): string[];
}

export function createLineCache(): LineCache {
  let previous: LineContext | undefined;
  let columns: number;
  let cache = new WeakMap<HistoryItem, string[]>();
  let entries: HistoryItem[] = [];
  let length = 0;
  let result: string[] = [];
  return { lines(history, width, ctx) {
    if (columns !== width || previous?.symbols !== ctx.symbols || previous.color !== ctx.color || previous.wide !== ctx.wide) {
      cache = new WeakMap();
      previous = { ...ctx };
      columns = width;
      entries = [];
      length = 0;
      result = [];
    }
    // 同一数组也可能已原地追加，因此单独记录上次的长度。
    const appended = history.length >= length && (history === entries || entries.slice(0, length).every((item, i) => history[i] === item));
    if (appended && history.length === length) return result;
    const extra = history.slice(appended ? length : 0).flatMap(item => {
      let rows = cache.get(item);
      if (!rows) { rows = itemLines(item, width, ctx); cache.set(item, rows); }
      return rows;
    });
    result = appended ? result.concat(extra) : extra;
    entries = history;
    length = history.length;
    return result;
  } };
}

import { expect, it } from 'vitest';
import { clip, displayWidth, wrapText } from '../src/ui/text.js';
import { editorReduce, editorWindow, EMPTY_EDITOR } from '../src/ui/editor.js';
import { pickSymbols } from '../src/ui/theme.js';

it('终端和语言共同决定省略号与不定宽字符宽度', () => {
  const system = { platform: 'win32', locale: 'zh-CN' };
  expect(pickSymbols({ WT_SESSION: '1' }, system)).toMatchObject({ ellipsis: '…', wide: false });
  for (const locale of ['zh-CN', 'JA', 'ko-KR']) {
    expect(pickSymbols({}, { ...system, locale })).toMatchObject({ ellipsis: '...', wide: true });
  }
  expect(pickSymbols({ TERM_PROGRAM: 'vscode' }, system).wide).toBe(false);
  expect(pickSymbols({}, { ...system, locale: 'en-US' }).wide).toBe(false);
  expect(pickSymbols({}, { ...system, platform: 'linux' }).wide).toBe(false);
});

it('按终端约定计算宽度并在完整字素之间截断', () => {
  for (const ch of ['…', '·', '“']) {
    expect(displayWidth(ch)).toBe(1);
    expect(displayWidth(ch, true)).toBe(2);
  }
  expect(displayWidth('中', true)).toBe(2);
  expect(displayWidth('a', true)).toBe(1);
  expect(clip('不变', 4, true, '...')).toBe('不变');
  expect(clip('····', 5, true, '...')).toBe('·...');
  expect(clip('👨‍👩‍👧中文', 3, false, '…')).toBe('👨‍👩‍👧…');
  expect(clip('中文', 2, true, '...')).toBe('..');
  expect(clip('中文', 0, true, '...')).toBe('');
});

it('硬折行保留空段和原有换行，按真实格数对齐', () => {
  expect(wrapText('a··文\r\n\n末\n', 3, true)).toEqual(['a·', '·', '文', '', '末', '']);
  expect(wrapText('a··文', 3, false)).toEqual(['a··', '文']);
  expect(wrapText('', 3, true)).toEqual(['']);
});

it('宽字符按显示列折行，行首行尾和纵向移动采用同一折行位置', () => {
  const state = { ...EMPTY_EDITOR, value: '甲·乙“丙”丁·末', cursor: 5 };
  const view = editorWindow(state, 6, true);
  expect(view.visible.map(line => line.text)).toEqual(['甲·乙', '“丙”', '丁·末']);
  expect(view).toMatchObject({ cursorColumn: 4, cursorRow: 1 });
  for (const [type, x, y] of [['home', 0, 1], ['end', 6, 1], ['up', 4, 0], ['down', 4, 2]] as const) {
    const next = editorReduce(state, { type }, 6, true);
    expect(editorWindow(next, 6, true)).toMatchObject({ cursorColumn: x, cursorRow: y });
  }
});

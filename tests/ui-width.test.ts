import { expect, it } from 'vitest';
import { clip, displayWidth, wrapText } from '../src/ui/text.js';
import { editorView, editorWindow, EMPTY_EDITOR } from '../src/ui/editor.js';
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

it('输入放得下时保留粘贴前缀与原来的光标', () => {
  const state = { ...EMPTY_EDITOR, pasted: '甲\n乙', value: 'a·b', cursor: 2 };
  const view = editorWindow(state, 40, true, '...');
  expect(view.prefix).toBe('[已粘贴 2 行] ');
  expect({ text: view.prefix + view.text, cursorColumn: view.cursorColumn }).toEqual(editorView(state, true));
});

it.each([
  [0, '', '0123456...'],
  [12, '...56789ab', ''],
  [8, '...4567', '...'],
] as const)('窗口随光标移动并为省略号留出格数：第 %i 个字', (cursor, left, right) => {
  const view = editorWindow({ ...EMPTY_EDITOR, pasted: '甲\n乙', value: '0123456789ab', cursor }, 11, true, '...');
  expect(view).toEqual({ prefix: '', text: left + right, cursorColumn: left.length });
});

it('宽字符窗口以真实列数定位光标', () => {
  const value = '甲·乙“丙”丁·末';
  const view = editorWindow({ ...EMPTY_EDITOR, value, cursor: 5 }, 13, true, '...');
  expect(view).toEqual({ prefix: '', text: '...乙“丙...', cursorColumn: 9 });
  expect(displayWidth(view.text, true)).toBe(12);
});

import { expect, it } from 'vitest';
import { EMPTY_EDITOR, editorReduce, editorSubmit, editorView, type EditorAction, type EditorState } from '../src/ui/editor.js';
import { displayWidth, graphemes } from '../src/ui/text.js';

function frozen(fields: Partial<EditorState> = {}): EditorState {
  const state = { ...EMPTY_EDITOR, ...fields };
  Object.freeze(state.history);
  return Object.freeze(state);
}

function edit(state: EditorState, action: EditorAction) {
  return editorReduce(frozen(state), action);
}

it('在首、中、尾插入多个字，拼接后重新识别组合字符', () => {
  let state = edit(frozen({ value: '尾' }), { type: 'insert', text: '你好' });
  expect(state).toMatchObject({ value: '你好尾', cursor: 2 });
  state = edit(state, { type: 'insert', text: '中' });
  expect(state).toMatchObject({ value: '你好中尾', cursor: 3 });
  state = edit(edit(state, { type: 'end' }), { type: 'insert', text: 'e' });
  expect(edit(state, { type: 'insert', text: '\u0301' })).toMatchObject({ value: '你好中尾é', cursor: 5 });
  expect(graphemes('é👨‍👩‍👧')).toEqual(['é', '👨‍👩‍👧']);
});

it('插入滤除控制字符，全部滤除时保留原状态', () => {
  const state = frozen();
  const controls = '\r\n\t\x00\x1b\x1f\x7f';
  expect(editorReduce(state, { type: 'insert', text: controls })).toBe(state);
  expect(edit(state, { type: 'insert', text: '前' + controls + '后' }).value).toBe('前后');
});

it.each(['中', '👍🏽', '👨‍👩‍👧'])('退格与向后删除各删一个完整的字：%s', letter => {
  const value = 'a' + letter + 'b';
  expect(edit(frozen({ value, cursor: 1 }), { type: 'delete' })).toMatchObject({ value: 'ab', cursor: 1 });
  expect(edit(frozen({ value, cursor: 2 }), { type: 'backspace' })).toMatchObject({ value: 'ab', cursor: 1 });
});

it('左右各跨一个字，行首行尾移动和删除不会越界', () => {
  const start = frozen({ value: '中👍🏽' });
  expect(editorReduce(start, { type: 'left' })).toBe(start);
  expect(editorReduce(start, { type: 'backspace' })).toBe(start);
  const middle = edit(start, { type: 'right' });
  expect(middle.cursor).toBe(1);
  const end = frozen(edit(middle, { type: 'right' }));
  expect(end.cursor).toBe(2);
  expect(editorReduce(end, { type: 'right' })).toBe(end);
  expect(editorReduce(end, { type: 'delete' })).toBe(end);
  expect(edit(end, { type: 'left' })).toEqual(middle);
  expect(edit(end, { type: 'home' })).toEqual(start);
  expect(edit(start, { type: 'end' })).toEqual(end);
});

it('真实光标列数包含中文和粘贴前缀的显示宽度', () => {
  for (const [cursor, column] of [0, 1, 3, 4].entries()) {
    const state = frozen({ value: 'a中b', cursor });
    expect(editorView(state)).toEqual({ text: 'a中b', cursorColumn: column });
    expect(editorView(frozen({ ...state, pasted: '甲\n乙' })).cursorColumn).toBe(displayWidth('[已粘贴 2 行] ') + column);
  }
});

it('单行粘贴插入，多行规范换行、折叠、合并，整块删除或提交', () => {
  const line = edit(frozen(), { type: 'paste', text: '\r\n备注\t\r' });
  expect(line).toMatchObject({ value: '备注', cursor: 2 });
  const pasted = edit(line, { type: 'paste', text: '\r\n甲\r\n乙\r丙\n\n' });
  expect(pasted).toMatchObject({ value: '备注', cursor: 2, pasted: '甲\n乙\n丙' });
  expect(editorView(frozen(pasted)).text).toBe('[已粘贴 3 行] 备注');
  const merged = edit(pasted, { type: 'paste', text: '丁\n戊' });
  expect(editorSubmit(frozen(merged)).text).toBe('甲\n乙\n丙\n丁\n戊\n备注');
  expect(edit(edit(merged, { type: 'home' }), { type: 'backspace' })).toMatchObject({ pasted: undefined, value: '备注' });
});

it('历史可来回浏览并恢复草稿，编辑退出浏览，直接提交保留多行原文', () => {
  const history = ['最旧', '甲\n乙'];
  const draft = frozen({ history, value: '草稿', cursor: 2, pasted: '一\n二' });
  const latest = edit(draft, { type: 'historyPrev' });
  expect(latest).toMatchObject({ value: '甲 …', cursor: 3, draft: '草稿', pasted: undefined, historyIndex: 1 });
  const submitted = editorSubmit(frozen(latest));
  expect(submitted).toEqual({ text: '甲\n乙', state: { ...EMPTY_EDITOR, history } });
  const oldest = frozen(edit(latest, { type: 'historyPrev' }));
  expect(oldest.value).toBe('最旧');
  expect(editorReduce(oldest, { type: 'historyPrev' })).toBe(oldest);
  expect(edit(oldest, { type: 'historyNext' })).toEqual(latest);
  expect(edit(latest, { type: 'historyNext' })).toEqual({ value: '草稿', cursor: 2, history });
  expect(edit(oldest, { type: 'insert', text: '改' })).toMatchObject({ value: '最旧改', historyIndex: undefined, draft: undefined });
});

it('提交去掉首尾空白，历史只保留最近二百条', () => {
  const history = Array.from({ length: 200 }, (_, index) => String(index));
  const result = editorSubmit(frozen({ history, value: ' 新 ' }));
  expect(result.text).toBe('新');
  expect(result.state.history).toEqual([...history.slice(1), '新']);
});

it('空白提交保留原状态，清空输入和粘贴时保留历史', () => {
  const state = frozen({ value: ' ', pasted: ' \n ', history: ['旧'] });
  const result = editorSubmit(state);
  expect(result.text).toBeUndefined();
  expect(result.state).toBe(state);
  expect(edit(state, { type: 'clear' })).toEqual({ ...EMPTY_EDITOR, history: ['旧'] });
});

import { expect, it } from 'vitest';
import { EMPTY_EDITOR, editorReduce, editorSubmit, editorWindow, type EditorAction, type EditorState } from '../src/ui/editor.js';
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
    expect(editorWindow(state, 40, false).cursorColumn).toBe(column);
    expect(editorWindow(frozen({ ...state, pasted: '甲\n乙' }), 40, false).cursorColumn).toBe(displayWidth('[已粘贴 2 行] ') + column);
  }
});

it('单行粘贴插入，多行规范换行、折叠、合并，整块删除或提交', () => {
  const line = edit(frozen({ value: '前后', cursor: 1 }), { type: 'paste', text: '备注\t' });
  const short = edit(line, { type: 'paste', text: '\r\n甲\r乙\r\n' });
  expect(short.value).toBe('前备注\n甲\n乙\n后');
  const eight = Array(8).fill('行').join('\n');
  expect(edit(frozen(), { type: 'paste', text: eight }).value).toBe(eight);
  const long = eight + '\n末';
  const pasted = edit(short, { type: 'paste', text: long });
  const merged = edit(pasted, { type: 'paste', text: long });
  expect(editorSubmit(merged).text).toBe([long, long, short.value].join('\n'));
  expect(edit({ ...merged, cursor: 0 }, { type: 'backspace' }).pasted).toBeUndefined();
});

it('历史可来回浏览并恢复草稿，编辑退出浏览，直接提交保留多行原文', () => {
  const history = ['最旧', '甲\n乙'];
  const draft = frozen({ history, value: '草稿', cursor: 2, pasted: '一\n二' });
  const latest = edit(draft, { type: 'historyPrev' });
  expect(latest).toMatchObject({ value: '甲\n乙', cursor: 3, draft: '草稿', pasted: undefined, historyIndex: 1 });
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

it('上下穿过短行后恢复目标显示列，到首末行才翻历史', () => {
  const state = frozen({ value: 'ab中\n短\n中文末', cursor: 3, history: ['历史'] });
  const short = edit(state, { type: 'down' });
  expect(short.cursor).toBe(5);
  expect(edit(short, { type: 'down' }).cursor).toBe(8);
  expect(edit(edit(short, { type: 'up' }), { type: 'up' }).value).toBe('历史');
  const long = Array(9).fill('长').join('\n');
  const recall = edit(frozen({ history: [long] }), { type: 'up' });
  expect(recall.value).toBe('长 …');
  expect(editorSubmit(recall).text).toBe(long);
  const editable = edit(frozen({ history: ['一\n二'] }), { type: 'up' });
  expect(editorSubmit(edit(editable, { type: 'insert', text: '三' })).text).toBe('一\n二三');
});

it('换行从光标处分开，行首退格或行尾删除重新合并', () => {
  const split = edit(frozen({ value: '甲乙', cursor: 1 }), { type: 'newline' });
  expect(split).toMatchObject({ value: '甲\n乙', cursor: 2 });
  expect(edit(split, { type: 'backspace' }).value).toBe('甲乙');
  expect(edit(edit(split, { type: 'left' }), { type: 'delete' }).value).toBe('甲乙');
});

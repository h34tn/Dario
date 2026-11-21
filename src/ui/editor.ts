import { clip, displayWidth, graphemes } from './text.js';

export interface EditorState {
  value: string;
  /** 从正文开头计数的字素位置。 */
  cursor: number;
  /** 折行交界处，End 和纵向移动可停在上一行末尾。 */
  previousLineEnd?: boolean;
  preferredColumn?: number;
  pasted?: string;
  history: string[];
  historyIndex?: number;
  draft?: string;
}

export const EMPTY_EDITOR: EditorState = { value: '', cursor: 0, history: [] };

export function editorSetValue(state: EditorState, value: string): EditorState {
  return { ...state, previousLineEnd: undefined, preferredColumn: undefined, value, cursor: graphemes(value).length, historyIndex: undefined, draft: undefined };
}

export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'newline' | 'up' | 'down' }
  | { type: 'backspace' | 'delete' | 'left' | 'right' | 'home' | 'end' | 'historyPrev' | 'historyNext' | 'clear' };

function recall(state: EditorState, index: number): EditorState {
  const entry = state.history[index]!;
  const newline = entry.indexOf('\n');
  const value = entry.split('\n').length <= MAX_INPUT_ROWS ? entry : entry.slice(0, newline) + ' …';
  return { ...state, previousLineEnd: undefined, preferredColumn: undefined, value, cursor: graphemes(value).length, pasted: undefined,
    historyIndex: index, draft: state.draft ?? state.value };
}

export function editorReduce(state: EditorState, action: EditorAction, width = Infinity, wide = false): EditorState {
  const { cursor, historyIndex, history } = state;
  const letters = graphemes(state.value);
  function replace(start: number, end: number, text: string): EditorState {
    const before = letters.slice(0, start).join('') + text;
    const value = before + letters.slice(end).join('');
    // 拼接处可能形成新的字素，光标停在包含插入末尾的字素之后。
    return { ...state, previousLineEnd: undefined, preferredColumn: undefined, value, cursor: graphemes(before).length, historyIndex: undefined, draft: undefined };
  }
  function move(next: number): EditorState {
    return next === cursor && !state.previousLineEnd && state.preferredColumn === undefined ? state
      : { ...state, cursor: next, previousLineEnd: undefined, preferredColumn: undefined };
  }
  switch (action.type) {
    case 'insert': {
      const text = action.text.replace(/[\x00-\x1f\x7f]/g, '');
      return text ? replace(cursor, cursor, text) : state;
    }
    case 'paste': {
      const lines = action.text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length === 1) {
        return action.text.trim() ? editorReduce(state, { type: 'insert', text: action.text }) : state;
      }
      const text = lines.join('\n');
      if (lines.length <= MAX_INPUT_ROWS) return replace(cursor, cursor, text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ''));
      return { ...state, pasted: state.pasted ? state.pasted + '\n' + text : text,
        historyIndex: undefined, draft: undefined };
    }
    case 'backspace':
      if (cursor > 0) {
        const image = letters[cursor - 1] === ']' && /\[Image #[1-9]\d*\]$/.exec(letters.slice(0, cursor).join(''));
        return replace(cursor - (image ? image[0].length : 1), cursor, '');
      }
      return state.pasted ? { ...state, pasted: undefined } : state;
    case 'delete': {
      if (cursor >= letters.length) return state;
      const image = letters[cursor] === '[' && /^\[Image #[1-9]\d*\]/.exec(letters.slice(cursor).join(''));
      return replace(cursor, cursor + (image ? image[0].length : 1), '');
    }
    case 'left': return move(Math.max(0, cursor - 1));
    case 'right': return move(Math.min(letters.length, cursor + 1));
    case 'newline': return replace(cursor, cursor, '\n');
    case 'up':
    case 'down':
    case 'home':
    case 'end': {
      const { rows, row, column } = editorLayout(state, width, wide);
      const direction = action.type === 'up' ? -1 : action.type === 'down' ? 1 : 0;
      const target = rows[row + direction];
      if (!target) return editorReduce(state, { type: direction < 0 ? 'historyPrev' : 'historyNext' });
      const goal = state.preferredColumn ?? column;
      let offset = 0;
      if (action.type === 'end') offset = target.columns.length - 1;
      else if (direction) {
        while (offset + 1 < target.columns.length && target.columns[offset + 1]! <= goal) offset++;
      }
      const next = target.start + offset;
      return { ...state, cursor: next, preferredColumn: direction ? goal : undefined,
        previousLineEnd: rows[row + direction + 1]?.start === next || undefined };
    }
    case 'historyPrev':
      return history.length && historyIndex !== 0 ? recall(state, (historyIndex ?? history.length) - 1) : state;
    case 'historyNext': {
      if (historyIndex === undefined) return state;
      if (historyIndex + 1 < history.length) return recall(state, historyIndex + 1);
      const value = state.draft ?? '';
      return { value, cursor: graphemes(value).length, history };
    }
    case 'clear': return { ...EMPTY_EDITOR, history };
  }
}

export function editorSubmit(state: EditorState): { text?: string; state: EditorState } {
  const entry = state.historyIndex === undefined
    ? [state.pasted, state.value].filter(Boolean).join('\n') : state.history[state.historyIndex]!;
  const text = entry.trim();
  if (!text) return { state };
  const history = state.history.at(-1) === text ? state.history : [...state.history.slice(-199), text];
  return { text, state: { ...EMPTY_EDITOR, history } };
}

export const MAX_INPUT_ROWS = 8;

interface InputRow {
  start: number;
  text: string;
  prefix: string;
  /** 每个可停光标处在提示符之后的显示列。 */
  columns: number[];
}

export function editorLayout(state: EditorState, width: number, wide: boolean) {
  const limit = Math.max(1, width);
  const prefix = state.pasted ? clip('[已粘贴 ' + state.pasted.split('\n').length + ' 行] ', limit - 1, wide, '…') : '';
  const rows: InputRow[] = [];
  function begin(start: number, prefix = '') {
    const line: InputRow = { start, text: '', prefix, columns: [displayWidth(prefix, wide)] };
    rows.push(line);
    return line;
  }
  let line = begin(0, prefix);
  for (const [i, letter] of graphemes(state.value).entries()) {
    if (letter === '\n') { line = begin(i + 1); continue; }
    const size = displayWidth(letter, wide);
    if (line.columns.at(-1)! + size > limit && (line.text || line.prefix)) line = begin(i);
    line.text += letter;
    line.columns.push(line.columns.at(-1)! + size);
  }
  let row = rows.length - 1;
  while (row > 0 && rows[row]!.start > state.cursor) row--;
  if (state.previousLineEnd && row > 0 && rows[row - 1]!.start + rows[row - 1]!.columns.length - 1 === state.cursor) row--;
  return { rows, row, column: rows[row]!.columns[state.cursor - rows[row]!.start]! };
}

/** 溢出标注各占一行；空间极少时优先显示光标。 */
export function editorWindow(state: EditorState, width: number, wide: boolean, maxRows = MAX_INPUT_ROWS) {
  const { rows, row, column } = editorLayout(state, width, wide);
  const height = Math.max(1, Math.min(MAX_INPUT_ROWS, maxRows, rows.length));
  const start = Math.max(0, Math.min(rows.length - height, row - Math.floor(height / 2)));
  const visible = rows.slice(start, start + height).map((line, i) => {
    const index = start + i;
    let marker = '';
    if (index !== row && i === 0 && start > 0) marker = '… 上面还有 ' + (start + 1) + ' 行';
    if (index !== row && i === height - 1 && index < rows.length - 1) marker = '… 下面还有 ' + (rows.length - index) + ' 行';
    return { ...line, first: index === 0, marker };
  });
  return { visible, cursorRow: row - start, cursorColumn: column };
}

import { clip, displayWidth, graphemes } from './text.js';

export interface EditorState {
  value: string;
  /** 按字素计数，零为行首。 */
  cursor: number;
  pasted?: string;
  history: string[];
  historyIndex?: number;
  draft?: string;
}

export const EMPTY_EDITOR: EditorState = { value: '', cursor: 0, history: [] };

export function editorSetValue(state: EditorState, value: string): EditorState {
  return { ...state, value, cursor: graphemes(value).length, historyIndex: undefined, draft: undefined };
}

export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'backspace' | 'delete' | 'left' | 'right' | 'home' | 'end' | 'historyPrev' | 'historyNext' | 'clear' };

function recall(state: EditorState, index: number): EditorState {
  const entry = state.history[index]!;
  const newline = entry.indexOf('\n');
  const value = newline < 0 ? entry : entry.slice(0, newline) + ' …';
  return { ...state, value, cursor: graphemes(value).length, pasted: undefined,
    historyIndex: index, draft: state.draft ?? state.value };
}

export function editorReduce(state: EditorState, action: EditorAction): EditorState {
  const { cursor, historyIndex, history } = state;
  const letters = graphemes(state.value);
  function replace(start: number, end: number, text: string): EditorState {
    const before = letters.slice(0, start).join('') + text;
    const value = before + letters.slice(end).join('');
    // 拼接处可能形成新的字素，光标停在包含插入末尾的字素之后。
    return { ...state, value, cursor: graphemes(before).length, historyIndex: undefined, draft: undefined };
  }
  function move(next: number): EditorState {
    return next === cursor ? state : { ...state, cursor: next };
  }
  switch (action.type) {
    case 'insert': {
      const text = action.text.replace(/[\x00-\x1f\x7f]/g, '');
      return text ? replace(cursor, cursor, text) : state;
    }
    case 'paste': {
      const lines = action.text.replace(/\r\n?/g, '\n').split('\n');
      const first = lines.findIndex(line => line.trim() !== '');
      if (first < 0) return state;
      while (!lines.at(-1)!.trim()) lines.pop();
      const text = lines.slice(first).join('\n');
      if (!text.includes('\n')) return editorReduce(state, { type: 'insert', text });
      return { ...state, pasted: state.pasted ? state.pasted + '\n' + text : text,
        historyIndex: undefined, draft: undefined };
    }
    case 'backspace':
      if (cursor > 0) return replace(cursor - 1, cursor, '');
      return state.pasted ? { ...state, pasted: undefined } : state;
    case 'delete': return cursor < letters.length ? replace(cursor, cursor + 1, '') : state;
    case 'left': return move(Math.max(0, cursor - 1));
    case 'right': return move(Math.min(letters.length, cursor + 1));
    case 'home': return move(0);
    case 'end': return move(letters.length);
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

export function editorView(state: EditorState, wide = false): { text: string; cursorColumn: number } {
  const prefix = pastePrefix(state);
  const before = graphemes(state.value).slice(0, state.cursor).join('');
  return { text: prefix + state.value, cursorColumn: displayWidth(prefix + before, wide) };
}

function pastePrefix(state: EditorState): string {
  return state.pasted ? `[已粘贴 ${state.pasted.split('\n').length} 行] ` : '';
}

/** 在提示符之后显示光标附近的正文，留一格给行尾光标。 */
export function editorWindow(state: EditorState, avail: number, wide: boolean, ellipsis: string) {
  const limit = Math.max(0, avail - 1);
  const prefix = pastePrefix(state);
  const letters = graphemes(state.value);
  let left = letters.slice(0, state.cursor).join('');
  let cursorColumn = displayWidth(left, wide);
  if (displayWidth(prefix + state.value, wide) <= limit) {
    return { prefix, text: state.value, cursorColumn: displayWidth(prefix, wide) + cursorColumn };
  }

  const after = letters.slice(state.cursor).join('');
  // 先给右侧留出完整余文或省略号所需的最小空间。
  const leftBudget = limit - Math.min(displayWidth(after, wide), displayWidth(ellipsis, wide), limit);
  if (cursorColumn > leftBudget) {
    const marker = clip(ellipsis, leftBudget, wide, '');
    cursorColumn = displayWidth(marker, wide);
    let start = state.cursor;
    while (start > 0) {
      const size = displayWidth(letters[start - 1]!, wide);
      if (cursorColumn + size > leftBudget) break;
      cursorColumn += size;
      start--;
    }
    left = marker + letters.slice(start, state.cursor).join('');
  }
  return { prefix: '', text: left + clip(after, limit - cursorColumn, wide, ellipsis), cursorColumn };
}

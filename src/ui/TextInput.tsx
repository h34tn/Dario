import { Box, Text, useCursor, useInput, usePaste, type Key } from 'ink';
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { editorReduce, editorSubmit, editorWindow, type EditorAction, type EditorState } from './editor.js';
import { useScreen } from './screen.js';
import { clip, displayWidth, graphemes } from './text.js';
import { toneColor } from './theme.js';

export interface TextInputProps {
  state: EditorState;
  /** 与上层快捷键共享同一批按键产生的最新输入。 */
  currentState?: RefObject<EditorState>;
  onChange: (state: EditorState) => void;
  onSubmit: (text: string) => void;
  onMenuKey?: (key: 'up' | 'down' | 'tab' | 'enter') => boolean;
  prompt?: string;
  view?: ReturnType<typeof editorWindow>;
  onNewline?: (key: string) => void;
  /** 输入框在动态输出区的行号，从零开始。 */
  row: number;
  isActive?: boolean;
  color: boolean;
}

function editKey(input: string, key: Key): EditorAction | undefined {
  if (key.meta || key.escape || key.tab) return;
  if (key.ctrl) {
    if (input === 'a') return { type: 'home' };
    if (input === 'e') return { type: 'end' };
    if (input === 'u') return { type: 'clear' };
    return;
  }
  if (key.backspace) return { type: 'backspace' };
  if (key.delete) return { type: 'delete' };
  if (key.leftArrow) return { type: 'left' };
  if (key.rightArrow) return { type: 'right' };
  if (key.home) return { type: 'home' };
  if (key.end) return { type: 'end' };
  if (key.upArrow) return { type: 'up' };
  if (key.downArrow) return { type: 'down' };
  if (input) return { type: 'insert', text: input };
}

export function TextInput({ state, currentState, onChange, onSubmit, onMenuKey, prompt = '> ', view: suppliedView, onNewline, row, isActive = true, color }: TextInputProps) {
  // 同一批输入可能在父组件重画前连续到达。
  const local = useRef(state);
  const current = currentState ?? local;
  useLayoutEffect(() => { local.current = state; }, [state]);
  function change(next: EditorState) {
    if (next === current.current) return;
    local.current = next;
    onChange(next);
  }
  const { columns, wide, ellipsis } = useScreen();
  const visiblePrompt = clip(prompt, columns - 2, wide, ellipsis);
  const promptWidth = displayWidth(visiblePrompt, wide);
  const width = columns - 1 - promptWidth;
  const view = useMemo(() => suppliedView ?? editorWindow(state, width, wide), [suppliedView, state, width, wide]);
  useInput((input, key) => {
    const state = current.current;
    let newline: string | undefined;
    if (key.return && key.shift && !key.meta && !key.ctrl) newline = 'Shift+Enter';
    else if (!key.meta && (input === '\n' || (key.ctrl && input === 'j'))) newline = 'Ctrl+J';
    else if (key.return && !key.ctrl && !key.meta && !key.shift && !key.super && !key.hyper) {
      const letters = graphemes(state.value);
      if (letters[state.cursor - 1] === '\\' && (state.cursor === letters.length || letters[state.cursor] === '\n')) {
        newline = '反斜杠+Enter';
      } else {
        if (onMenuKey?.('enter')) return;
        const result = editorSubmit(current.current);
        if (result.text !== undefined) {
          change(result.state);
          onSubmit(result.text);
        }
        return;
      }
    }
    if (newline) {
      const base = newline === '反斜杠+Enter' ? editorReduce(state, { type: 'backspace' }) : state;
      change(editorReduce(base, { type: 'newline' }));
      onNewline?.(newline);
      return;
    }
    if (!key.ctrl && !key.meta && (key.tab || key.upArrow || key.downArrow)) {
      if (onMenuKey?.(key.tab ? 'tab' : key.upArrow ? 'up' : 'down')) return;
    }
    const action = editKey(input, key);
    if (action) change(editorReduce(state, action, width, wide));
  }, { isActive });
  usePaste(text => change(editorReduce(current.current, { type: 'paste', text })), { isActive });

  const { setCursorPosition } = useCursor();
  setCursorPosition(isActive ? { x: promptWidth + view.cursorColumn, y: row + view.cursorRow } : undefined);
  return <Box flexDirection="column">{view.visible.map((line, i) =>
    <Text key={i} wrap="truncate-end"><Text {...toneColor('role', color)}>{line.first ? visiblePrompt : ' '.repeat(promptWidth)}</Text>
      <Text {...toneColor('dim', color)}>{line.marker ? clip(ellipsis + line.marker.slice(1), width, wide, ellipsis) : line.prefix}</Text>
      {!line.marker && line.text}</Text>)}</Box>;
}

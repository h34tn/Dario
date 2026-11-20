import { Text, useCursor, useInput, usePaste, type Key } from 'ink';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { editorReduce, editorSubmit, editorWindow, type EditorAction, type EditorState } from './editor.js';
import { useScreen } from './screen.js';
import { clip, displayWidth } from './text.js';
import { toneColor } from './theme.js';

export interface TextInputProps {
  state: EditorState;
  /** 与上层快捷键共享同一批按键产生的最新输入。 */
  currentState?: RefObject<EditorState>;
  onChange: (state: EditorState) => void;
  onSubmit: (text: string) => void;
  prompt?: string;
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
  if (key.upArrow) return { type: 'historyPrev' };
  if (key.downArrow) return { type: 'historyNext' };
  if (input) return { type: 'insert', text: input };
}

export function TextInput({ state, currentState, onChange, onSubmit, prompt = '> ', row, isActive = true, color }: TextInputProps) {
  // 同一批输入可能在父组件重画前连续到达。
  const local = useRef(state);
  const current = currentState ?? local;
  useLayoutEffect(() => { local.current = state; }, [state]);
  function change(next: EditorState) {
    if (next === current.current) return;
    current.current = next;
    onChange(next);
  }
  useInput((input, key) => {
    if (key.return && !key.ctrl && !key.meta) {
      const result = editorSubmit(current.current);
      if (result.text !== undefined) {
        change(result.state);
        onSubmit(result.text);
      }
      return;
    }
    const action = editKey(input, key);
    if (action) change(editorReduce(current.current, action));
  }, { isActive });
  usePaste(text => change(editorReduce(current.current, { type: 'paste', text })), { isActive });

  const { columns, wide, ellipsis } = useScreen();
  const visiblePrompt = clip(prompt, columns - 2, wide, ellipsis);
  const promptWidth = displayWidth(visiblePrompt, wide);
  const view = editorWindow(state, columns - 1 - promptWidth, wide, ellipsis);
  const { setCursorPosition } = useCursor();
  setCursorPosition(isActive ? { x: promptWidth + view.cursorColumn, y: row } : undefined);
  return <Text wrap="truncate-end"><Text {...toneColor('role', color)}>{visiblePrompt}</Text>
    <Text {...toneColor('dim', color)}>{view.prefix}</Text>{view.text}</Text>;
}

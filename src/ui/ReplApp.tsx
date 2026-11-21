import { GlyphContext, useScreen } from './screen.js';
import { clip } from './text.js';
import { Box, Static, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ModelPrompt } from './ModelPrompt.js';
import { CommandMenu, menuLayout } from './CommandMenu.js';
import { suggest } from './completion.js';
import { editorReduce, editorWindow, editorSetValue, EMPTY_EDITOR, type EditorState } from './editor.js';
import { CurrentStep, StepRow, visibleActivities } from './LiveJob.js';
import { itemLines } from './lines.js';
import { FallbackPrompt } from './FallbackPrompt.js';
import { PlanPrompt } from './PlanPrompt.js';
import { DisplayBoundary } from './RunApp.js';
import type { HistoryItem, Session } from './session.js';
import { StatusBar } from './StatusBar.js';
import { TextInput, type TextInputProps } from './TextInput.js';
import { toneColor, type Symbols } from './theme.js';

interface Props {
  session: Session;
  suspended?: boolean;
  symbols: Symbols;
  color: boolean;
  onExit: (kind: 'exit' | 'plain') => void;
  onError: (error: Error) => void;
}

function Entry({ item, color, symbols }: Pick<Props, 'color' | 'symbols'> & { item: HistoryItem }) {
  const { columns, wide } = useScreen();
  switch (item.type) {
    case 'step': return <StepRow step={item.step} now={0} symbols={symbols} color={color} />;
    case 'banner':
    case 'title': return <Text {...toneColor('title', color)}>{item.text}</Text>;
    // 与全屏界面用同一套排版：整行铺灰色底，按当前宽度折行
    case 'input': return <Box flexDirection="column">{itemLines(item, Math.max(1, columns - 1), { symbols, color, wide })
      .map((line, i) => <Text key={i} wrap="truncate-end">{line}</Text>)}</Box>;
    case 'notice': return <Text {...toneColor('warn', color)}>{symbols.warn} {item.text}</Text>;
    case 'error': return <Text {...toneColor('fail', color)}>{symbols.fail} {item.text}</Text>;
    case 'text': return <Text>{item.text}</Text>;
  }
}

/** 两种交互布局共用会话订阅、编辑快捷键与退出流程。 */
export function useSessionEditor({ session, onExit, suspended }: Pick<Props, 'session' | 'onExit' | 'suspended'>) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [editor, setEditor] = useState(EMPTY_EDITOR);
  const current = useRef(editor);
  const [selected, setSelected] = useState(0);
  const selection = useRef(0);
  function select(index: number) {
    selection.current = index;
    setSelected(index);
  }
  function candidates(state: EditorState) {
    const value = state.historyIndex === undefined ? state.value : state.history[state.historyIndex]!;
    return state.pasted || snap.plan || snap.ask || snap.picker ? [] : suggest(value, session.completionContext());
  }
  const onMenuKey: NonNullable<TextInputProps['onMenuKey']> = key => {
    const state = current.current;
    const options = candidates(state);
    if (!options.length) return false;
    const index = Math.min(selection.current, options.length - 1);
    if (key === 'up' || key === 'down') {
      select((index + (key === 'up' ? -1 : 1) + options.length) % options.length);
      return true;
    }
    const item = options[index]!;
    if (key === 'enter' && state.value === item.value) return false;
    change(editorSetValue(state, item.value));
    // 返回 false 时输入框按通常流程提交最新内容，并记入输入历史。
    return key === 'tab' || !item.submitOnSelect;
  };
  const [warning, setWarning] = useState(false);
  const armed = useRef(false);
  const exited = useRef(false);
  const [now, setNow] = useState(Date.now);
  const active = !!snap.feed.current;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (snap.exiting && !exited.current) {
      exited.current = true;
      onExit(snap.exiting);
    }
  }, [snap.exiting, onExit]);

  function arm(value: boolean) {
    armed.current = value;
    setWarning(value);
  }
  function change(next: EditorState) {
    if (next.value !== current.current.value) select(0);
    current.current = next;
    setEditor(next);
    arm(false);
  }
  useInput((input, key) => {
    const state = current.current;
    const ctrlC = key.ctrl && input === 'c';
    if (!ctrlC) arm(false);
    if (key.escape || ctrlC) {
      if (state.value || state.pasted) change(editorReduce(state, { type: 'clear' }));
      else if (key.escape) session.interrupt();
      else if (armed.current) session.requestExit('exit');
      else arm(true);
    }
  }, { isActive: !suspended && !snap.picker && !snap.plan && !snap.ask });
  const warningText = warning ? '再按一次 Ctrl+C 退出' + (snap.runningJobId ? '（正在运行的任务会被取消）' : '') : '';
  const suggestions = candidates(editor);
  return { snap, editor, current, change, now, warningText, selected: Math.min(selected, suggestions.length - 1), onMenuKey, suggestions };
}

function Screen({ session, symbols, color, onExit, suspended }: Props) {
  const { columns, rows, wide, ellipsis } = useScreen();
  const limit = columns - 1;
  const { snap, editor, current, change, now, warningText, selected, onMenuKey, suggestions } = useSessionEditor({ session, onExit, suspended });
  const active = !!snap.feed.current;
  // 极矮的窗口先缩短菜单，给状态栏、输入框、当前步骤和终端末行留位。
  const minimum = active ? 6 : 4;
  const maxRows = rows - minimum + 1;
  const inputView = useMemo(() => editorWindow(editor, limit - 2, wide, maxRows), [editor, limit, wide, maxRows]);
  const inputHeight = inputView.visible.length;
  const minRows = minimum + inputHeight - 1;
  const layout = menuLayout(suggestions.length, rows - minRows + 1);
  const hintRows = warningText ? 1 : Math.max(1, layout.height);
  const activityLines = visibleActivities(snap.feed.activities, rows, 1 + inputHeight + hintRows, ellipsis);
  const stepRows = active ? 1 + activityLines.length : 0;

  return <Box flexDirection="column">
    <Static items={snap.history}>{item => <Entry key={item.id} {...{ item, color, symbols }} />}</Static>
    {!suspended && snap.picker && <ModelPrompt color={color} picker={snap.picker} onKey={key => void session.modelKey(key)} />}
    {!suspended && !snap.picker && (snap.plan || snap.ask || rows >= minRows) && <>
      <CurrentStep feed={snap.feed} {...{ activityLines, now, color, symbols }} truncate />
      {snap.plan && <PlanPrompt key={snap.runningJobId} plan={snap.plan} roleLabel={session.planRoleLabel} color={color}
        onDecide={approved => session.decidePlan(approved)} />}
      {snap.ask && <FallbackPrompt key={snap.ask.from[0]?.agent + '>' + snap.ask.to.agent} question={snap.ask} symbols={symbols} color={color}
        onDecide={approved => session.decideFallback(approved)} />}
      <StatusBar status={snap.status} queued={snap.queued} contextJobId={snap.contextJobId} color={color} />
      <TextInput view={inputView} state={editor} currentState={current} onChange={change} onMenuKey={onMenuKey} onSubmit={text => session.submit(text)}
        isActive={!snap.plan && !snap.ask} row={stepRows + 1} color={color} />
      {warningText ? <Text {...toneColor('warn', color)}>{clip(warningText, limit, wide, ellipsis)}</Text>
        : suggestions.length ? <CommandMenu {...{ suggestions, selected, layout, color }} />
        : <Text wrap="truncate-end" {...toneColor('dim', color)}>{clip('  / 指令   Shift+Enter 换行   Esc 中断当前任务   Ctrl+C 退出', limit, wide, ellipsis)}</Text>}
    </>}
  </Box>;
}

export function ReplApp(props: Props) {
  return <GlyphContext.Provider value={props.symbols}>
    <DisplayBoundary onError={props.onError}><Screen {...props} /></DisplayBoundary>
  </GlyphContext.Provider>;
}

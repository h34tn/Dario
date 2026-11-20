import { GlyphContext, useScreen } from './screen.js';
import { clip } from './text.js';
import { Box, Static, Text, useInput } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CommandMenu } from './CommandMenu.js';
import { suggest } from './completion.js';
import { editorReduce, editorSetValue, EMPTY_EDITOR, type EditorState } from './editor.js';
import { CurrentStep, StepRow, visibleActivities } from './LiveJob.js';
import { PlanPrompt } from './PlanPrompt.js';
import { DisplayBoundary } from './RunApp.js';
import type { HistoryItem, Session } from './session.js';
import { StatusBar } from './StatusBar.js';
import { TextInput } from './TextInput.js';
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
  switch (item.type) {
    case 'step': return <StepRow step={item.step} now={0} symbols={symbols} color={color} />;
    case 'banner':
    case 'title': return <Text {...toneColor('title', color)}>{item.text}</Text>;
    case 'input': return <Text><Text {...toneColor('role', color)}>&gt; </Text>{item.text}</Text>;
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
    current.current = next;
    setEditor(next);
    arm(false);
  }
  useInput((input, key) => {
    const state = current.current;
    const ctrlC = key.ctrl && input === 'c';
    if (!ctrlC) arm(false);
    if (key.tab) {
      const first = suggest(state.value, session.completionContext())[0];
      if (first) change(editorSetValue(state, first.value));
    } else if (key.escape || ctrlC) {
      if (state.value || state.pasted) change(editorReduce(state, { type: 'clear' }));
      else if (key.escape) session.interrupt();
      else if (armed.current) session.requestExit('exit');
      else arm(true);
    }
  }, { isActive: !suspended && !snap.plan });
  const warningText = warning ? '再按一次 Ctrl+C 退出' + (snap.runningJobId ? '（正在运行的任务会被取消）' : '') : '';
  return { snap, editor, current, change, now, warningText, suggestions: suggest(editor.value, session.completionContext()) };
}

function Screen({ session, symbols, color, onExit, suspended }: Props) {
  const { columns, rows, wide, ellipsis } = useScreen();
  const limit = columns - 1;
  const { snap, editor, current, change, now, warningText, suggestions: candidates } = useSessionEditor({ session, onExit, suspended });
  const active = !!snap.feed.current;
  // 极矮的窗口先缩短菜单，给状态栏、输入框、当前步骤和终端末行留位。
  const minRows = active ? 6 : 4;
  const suggestions = candidates.slice(0, Math.max(1, rows - minRows + 1));
  const hintRows = warningText ? 1 : Math.max(1, suggestions.length);
  const activityLines = visibleActivities(snap.feed.activities, rows, 2 + hintRows, ellipsis);
  const stepRows = active ? 1 + activityLines.length : 0;

  return <Box flexDirection="column">
    <Static items={snap.history}>{item => <Entry key={item.id} {...{ item, color, symbols }} />}</Static>
    {!suspended && (snap.plan || rows >= minRows) && <>
      <CurrentStep feed={snap.feed} {...{ activityLines, now, color, symbols }} truncate />
      {snap.plan && <PlanPrompt key={snap.runningJobId} plan={snap.plan} roleLabel={session.roleLabel} color={color}
        onDecide={approved => session.decidePlan(approved)} />}
      <StatusBar status={snap.status} queued={snap.queued} contextJobId={snap.contextJobId} color={color} />
      <TextInput state={editor} currentState={current} onChange={change} onSubmit={text => session.submit(text)}
        isActive={!snap.plan} row={stepRows + 1} color={color} />
      {warningText ? <Text {...toneColor('warn', color)}>{clip(warningText, limit, wide, ellipsis)}</Text>
        : suggestions.length ? <CommandMenu suggestions={suggestions} color={color} />
        : <Text wrap="truncate-end" {...toneColor('dim', color)}>{clip('  / 指令   Esc 中断当前任务   Ctrl+C 退出', limit, wide, ellipsis)}</Text>}
    </>}
  </Box>;
}

export function ReplApp(props: Props) {
  return <GlyphContext.Provider value={props.symbols}>
    <DisplayBoundary onError={props.onError}><Screen {...props} /></DisplayBoundary>
  </GlyphContext.Provider>;
}

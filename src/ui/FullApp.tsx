import { Box, Text, useInput, useStdout } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ModelPrompt } from './ModelPrompt.js';
import { CommandMenu, menuLayout } from './CommandMenu.js';
import { createLineCache, FALLBACK_HINT, fallbackLines, planLines, stepText, wrapAnsi } from './lines.js';
import { useSessionEditor } from './ReplApp.js';
import { DisplayBoundary } from './RunApp.js';
import { GlyphContext, useScreen } from './screen.js';
import type { Session } from './session.js';
import { StatusBar } from './StatusBar.js';
import { TextInput } from './TextInput.js';
import { editorReduce, editorWindow } from './editor.js';
import type { CopyResult, ReadResult } from './clipboard.js';
import type { Mouse, Pointer } from './mouse.js';
import { columns as selectedColumns, highlight, paragraph, selectedText, word, type Point, type Selection } from './selection.js';
import { clip, displayWidth, graphemes } from './text.js';
import { paint, type Symbols } from './theme.js';
import { afterChange, FOLLOW, scrollBy, sliceView } from './viewport.js';

interface Drag {
  origin: Point;
  end: Point;
  pointer: Pointer;
  preset?: Selection;
  moved: boolean;
}

export interface FullAppProps {
  session: Session;
  symbols: Symbols;
  color: boolean;
  readClipboard?: () => Promise<ReadResult>;
  copy?: (text: string) => Promise<CopyResult>;
  /** 订阅鼠标事件，返回取消订阅的函数。 */
  onMouse?: (listener: (event: Mouse) => void) => () => void;
  onExit: (kind: 'exit' | 'plain') => void;
  onError: (error: Error) => void;
}

function Screen({ session, symbols, color, onMouse, copy, readClipboard, onExit }: FullAppProps) {
  const { stdout } = useStdout();
  const [, resize] = useReducer(n => n + 1, 0);
  useEffect(() => {
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout]);
  const { rows, columns, wide, ellipsis } = useScreen();
  const limit = Math.max(0, columns - 1);
  const small = rows < 8 || columns < 40;
  const { snap, editor, current, change, now, warningText, suggestions, selected, onMenuKey } = useSessionEditor({ session, onExit, suspended: small });
  const [expanded, expand] = useState<typeof snap.plan>();
  const [cache] = useState(createLineCache);
  const ctx = { symbols, color, wide };
  const fit = (text: string) => clip(text, limit, wide, ellipsis);
  // 转动标记每秒变化四次，活动只在内容或排版变化时重新截断。
  const activities = useMemo(() => small ? [] : snap.feed.activities.map(activity => {
    const first = stripVTControlCharacters(activity.split(/[\r\n]/, 1)[0]).replaceAll('\t', '    ');
    return paint('dim', clip('    ' + first, limit, wide, ellipsis), color);
  }), [small, snap.feed.activities, limit, wide, ellipsis, color]);
  const lines = small ? [] : cache.lines(snap.history, limit, ctx).slice();
  const joins = small ? [] : cache.joins.slice();
  const stepLine = !small && snap.feed.current
    ? wrapAnsi(stepText(snap.feed.current, { ...ctx, now, ellipsis, stopping: snap.feed.stopping }), limit, wide)[0]
    : undefined;
  const stepHeight = stepLine === undefined ? 0 : 1;
  if (stepHeight) {
    lines.push(...activities);
    for (const _ of activities) joins.push({ continuation: false });
  }
  if (!small && snap.plan) {
    for (const line of planLines(snap.plan, session.planRoleLabel, expanded === snap.plan, limit, ctx, joins)) lines.push(line);
  }
  if (!small && snap.ask) for (const line of fallbackLines(snap.ask, limit, ctx, joins)) lines.push(line);
  const total = lines.length;
  const [anchor, setAnchor] = useState({ view: FOLLOW, total: 0, height: 0 });
  const [selection, select] = useState<Selection>();
  const [notice, setNotice] = useState('');
  const drag = useRef<Drag | undefined>(undefined);
  const clicks = useRef<{ press: Pointer; time: number; count: number } | undefined>(undefined);
  const generation = useRef(0);
  const noticeTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const [edge, setEdge] = useState(0);
  const autoScroll = useRef<((delta: number) => void) | undefined>(undefined);
  function clearNotice() {
    generation.current++;
    clearTimeout(noticeTimer.current);
    setNotice('');
  }
  function clearSelection() {
    drag.current = undefined;
    clicks.current = undefined;
    setEdge(0);
    select(undefined);
  }
  useLayoutEffect(() => { clearSelection(); }, [limit]);
  useLayoutEffect(() => {
    if (small || snap.picker) {
      drag.current = undefined;
      clicks.current = undefined;
      setEdge(0);
    }
  }, [small, !!snap.picker]);
  useEffect(() => () => { generation.current++; clearTimeout(noticeTimer.current); }, []);
  function showNotice(message: string) {
    clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(''), 3000);
  }
  const inputActive = !small && !snap.plan && !snap.ask && !snap.picker;
  const pasteGeneration = useRef(0);
  useLayoutEffect(() => () => { pasteGeneration.current++; }, [inputActive]);
  async function pasteClipboard() {
    if (!readClipboard || !inputActive) return;
    const request = pasteGeneration.current;
    const id = ++generation.current;
    let result: ReadResult;
    try { result = await readClipboard(); } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : '无法读取剪贴板' };
    }
    const { plan, ask, picker } = session.getSnapshot();
    if (request !== pasteGeneration.current || plan || ask || picker) return;
    if (result.ok && result.text) change(editorReduce(current.current, { type: 'paste', text: result.text }));
    if (id === generation.current) showNotice(!result.ok ? '粘贴失败：' + result.reason
      : result.text ? '已粘贴 ' + graphemes(result.text).length + ' 个字符' : '剪贴板里没有文字');
  }
  async function copySelection(range: Selection) {
    const text = selectedText(lines, joins, range, wide);
    if (!text || !copy) return;
    const id = generation.current;
    let result: CopyResult;
    try { result = await copy(text); } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : '无法写入剪贴板' };
    }
    if (id !== generation.current) return;
    showNotice(result.ok ? '已复制 ' + graphemes(text).length + ' 个字符到剪贴板' : '复制失败：' + result.reason);
  }
  const maxRows = Math.floor(rows / 3);
  const inputView = useMemo(() => editorWindow(editor, limit - 2, wide, maxRows), [editor, limit, wide, maxRows]);
  const inputHeight = inputView.visible.length;
  const baseHeight = Math.max(0, rows - 4 - inputHeight - stepHeight - Number(!!notice));
  // 离开底部时固定首行，计入历史内容和下方固定区域的高度变化。
  function adjusted(height: number) {
    return afterChange(anchor.view, total - anchor.total + anchor.height - height, total, height);
  }
  const menuVisible = baseHeight > 0 && !warningText && !adjusted(baseHeight).offset;
  const layout = menuLayout(suggestions.length, menuVisible ? baseHeight : 0);
  const height = baseHeight - Math.max(0, layout.height - 1);
  const view = layout.height ? FOLLOW : adjusted(height);
  const { visible, below, above } = sliceView(lines, height, view);
  // 收缩后触底便恢复跟随，避免旧偏移在下一次追加时复现。
  if (!small && (anchor.total !== total || anchor.height !== height)) setAnchor({ view, total, height });

  function scroll(delta: number) {
    setAnchor(previous => {
      const active = afterChange(previous.view, total - previous.total + previous.height - height, total, height);
      // 开始翻看后菜单收为一行，以收起后的高度计算底部还有多少行。
      return { view: scrollBy(active, delta, total, baseHeight), total, height: baseHeight };
    });
  }
  // 同一批输入可能先于 React 重画到达，立即推进本批事件使用的视口。
  useLayoutEffect(() => {
    if (small) return;
    if (snap.picker) {
      return onMouse?.(event => {
        if (typeof event !== 'string' && event.type === 'press') { clearNotice(); clearSelection(); }
      });
    }
    let first = above, offset = below, visibleCount = visible.length;
    function pointAt(event: Pointer): Point {
      return { line: first + Math.max(0, Math.min(visibleCount - 1, event.row - 1)),
        col: Math.max(0, Math.min(limit - 1, event.col - 1)) };
    }
    function move(active: Drag, pointer: Pointer, scrolled = false) {
      if (scrolled || pointer.row !== active.pointer.row || pointer.col !== active.pointer.col) {
        active.end = pointAt(pointer);
        active.moved = true;
      }
      active.pointer = pointer;
      const range = active.moved ? { start: active.origin, end: active.end } : active.preset;
      select(range);
      return range;
    }
    function scrollMouse(delta: number) {
      const next = scrollBy({ offset }, delta, total, baseHeight);
      if (next.offset === offset) return;
      offset = next.offset;
      first = Math.max(0, total - offset - baseHeight);
      visibleCount = Math.min(total, baseHeight);
      setAnchor({ view: next, total, height: baseHeight });
      if (drag.current) move(drag.current, drag.current.pointer, true);
    }
    autoScroll.current = delta => {
      const pointer = drag.current?.pointer;
      if (pointer && (delta > 0 ? pointer.row <= 1 : pointer.row > height)) scrollMouse(delta);
    };
    return onMouse?.(event => {
      if (typeof event === 'string') { scrollMouse(event === 'up' ? 3 : -3); return; }
      if (event.type === 'rightPress') {
        const top = height + stepHeight + Number(!!notice) + 1;
        if (event.col >= 1 && event.col <= limit && event.row >= top && event.row <= top + inputHeight + 1) void pasteClipboard();
        return;
      }
      if (event.type === 'press') {
        clearNotice();
        const last = clicks.current;
        clearSelection();
        if (event.row < 1 || event.row > visibleCount) return;
        const point = pointAt(event);
        const time = Date.now();
        const count = last && last.press.row === event.row && last.press.col === event.col && time - last.time <= 400
          ? last.count % 3 + 1 : 1;
        clicks.current = { press: event, count, time };
        const preset = count === 2 ? word(lines, joins, point, wide) : count === 3 ? paragraph(lines, joins, point, wide) : undefined;
        drag.current = { origin: point, end: point, pointer: event, moved: false, preset };
        select(preset);
      } else if (drag.current) {
        const active = drag.current;
        const range = move(active, event);
        if (event.type === 'release') {
          setEdge(0);
          drag.current = undefined;
          if (active.moved) clicks.current = undefined;
          if (range) void copySelection(range);
        } else {
          // 历史区贴着屏幕顶端，终端能上报的最小行号通常就是 1。
          setEdge(event.row <= 1 ? 1 : event.row > height ? -1 : 0);
        }
      }
    });
  });
  const canAutoScroll = !small && !snap.picker && (edge > 0 ? above > 0 : below > 0);
  useEffect(() => {
    if (!edge || !canAutoScroll) return;
    const timer = setInterval(() => {
      if (drag.current) autoScroll.current?.(edge);
    }, 50);
    return () => clearInterval(timer);
  }, [edge, canAutoScroll]);

  function follow() { setAnchor({ view: FOLLOW, total, height }); }
  useInput((input, key) => {
    if (key.escape) clearSelection();
    if (small) {
      if (key.ctrl && input === 'c') session.requestExit('exit');
    } else if (key.pageUp || key.pageDown) {
      scroll((key.pageUp ? 1 : -1) * (height - 1));
    } else if (snap.ask) {
      const letter = input.toLowerCase();
      if (letter === 'y' || letter === 'n' || key.escape || (key.ctrl && letter === 'c')) session.decideFallback(letter === 'y');
    } else if (snap.plan) {
      const letter = input.toLowerCase();
      if (letter === 'd') expand(previous => previous === snap.plan ? undefined : snap.plan);
      else if (letter === 'y' || letter === 'n' || key.escape || (key.ctrl && letter === 'c')) {
        session.decidePlan(letter === 'y');
      }
    } else if (key.end && !current.current.value && !current.current.pasted) follow();
  });

  function row(text: string, i: number) {
    return <Text key={i} wrap="truncate-end">{text || ' '}</Text>;
  }
  if (small) return <Box flexDirection="column">{Array.from({ length: rows }, (_, i) =>
    row(i ? '' : fit('窗口太小，请放大窗口，或按 Ctrl+C 退出'), i))}</Box>;

  if (snap.picker) return <ModelPrompt color={color} picker={snap.picker} onKey={key => void session.modelKey(key)} />;

  const rule = paint('dim', symbols.rule.repeat(limit), color);
  const hint = snap.ask ? FALLBACK_HINT : snap.plan ? '执行吗？  y 执行   n 取消   d 查看每一步的完整任务说明'
    : warningText || (below ? '  ' + symbols.down + ' 下面还有 ' + below + ' 行   PgDn 向下翻   End 回到最新'
      : '  / 指令   PgUp/PgDn 翻看   Shift+Enter 换行   Esc 中断当前任务   Ctrl+C 退出');
  return <Box flexDirection="column">
    {Array.from({ length: height }, (_, i) => row(highlight(visible[i] ?? '', selectedColumns(selection, above + i), wide), i))}
    {stepLine !== undefined && <Text wrap="truncate-end">{stepLine}</Text>}
    {!!notice && <Text wrap="truncate-end">{' '.repeat(Math.max(0, limit - displayWidth(fit(notice), wide))) + paint('dim', fit(notice), color)}</Text>}
    <Text wrap="truncate-end">{rule}</Text>
    <TextInput view={inputView} state={editor} currentState={current} onChange={change} onMenuKey={menuVisible ? onMenuKey : undefined} onSubmit={text => { follow(); session.submit(text); }}
      row={height + stepHeight + Number(!!notice) + 1} isActive={!snap.plan && !snap.ask} color={color} />
    <Text wrap="truncate-end">{rule}</Text>
    {layout.height ? <CommandMenu {...{ suggestions, selected, layout, color }} />
      : <Text wrap="truncate-end">{paint(snap.plan || snap.ask || warningText ? 'warn' : 'dim', fit(hint), color)}</Text>}
    <StatusBar status={snap.status} queued={snap.queued} contextJobId={snap.contextJobId} color={color} />
  </Box>;
}

export function FullApp(props: FullAppProps) {
  return <GlyphContext.Provider value={props.symbols}>
    <DisplayBoundary onError={props.onError}><Screen {...props} /></DisplayBoundary>
  </GlyphContext.Provider>;
}

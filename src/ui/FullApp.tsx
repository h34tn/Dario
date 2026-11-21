import { Box, Text, useInput, useStdout } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { CommandMenu } from './CommandMenu.js';
import { createLineCache, FALLBACK_HINT, fallbackLines, planLines, stepText, wrapAnsi } from './lines.js';
import { useSessionEditor } from './ReplApp.js';
import { DisplayBoundary } from './RunApp.js';
import { GlyphContext, useScreen } from './screen.js';
import type { Session } from './session.js';
import { StatusBar } from './StatusBar.js';
import { TextInput } from './TextInput.js';
import { clip } from './text.js';
import { paint, type Symbols } from './theme.js';
import { afterChange, FOLLOW, scrollBy, sliceView } from './viewport.js';

type Direction = 'up' | 'down';

export interface FullAppProps {
  session: Session;
  symbols: Symbols;
  color: boolean;
  /** 订阅滚轮事件，返回取消订阅的函数。 */
  onWheel?: (listener: (direction: Direction) => void) => () => void;
  onExit: (kind: 'exit' | 'plain') => void;
  onError: (error: Error) => void;
}

function Screen({ session, symbols, color, onWheel, onExit }: FullAppProps) {
  const { stdout } = useStdout();
  const [, resize] = useReducer(n => n + 1, 0);
  useEffect(() => {
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout]);
  const { rows, columns, wide, ellipsis } = useScreen();
  const limit = Math.max(0, columns - 1);
  const small = rows < 8 || columns < 40;
  const { snap, editor, current, change, now, warningText, suggestions } = useSessionEditor({ session, onExit, suspended: small });
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
  const stepLine = !small && snap.feed.current
    ? wrapAnsi(stepText(snap.feed.current, { ...ctx, now, ellipsis, stopping: snap.feed.stopping }), limit, wide)[0]
    : undefined;
  const stepHeight = stepLine === undefined ? 0 : 1;
  if (stepHeight) lines.push(...activities);
  if (!small && snap.plan) {
    for (const line of planLines(snap.plan, session.roleLabel, expanded === snap.plan, limit, ctx)) lines.push(line);
  }
  if (!small && snap.ask) for (const line of fallbackLines(snap.ask, limit, ctx)) lines.push(line);
  const total = lines.length;
  const [anchor, setAnchor] = useState({ view: FOLLOW, total: 0, height: 0 });
  const baseHeight = Math.max(0, rows - 5 - stepHeight);
  // 离开底部时固定首行，计入历史内容和下方固定区域的高度变化。
  function adjusted(height: number) {
    return afterChange(anchor.view, total - anchor.total + anchor.height - height, total, height);
  }
  const menu = !snap.plan && !snap.ask && !warningText && !adjusted(baseHeight).offset ? suggestions.slice(0, baseHeight) : [];
  const height = baseHeight - Math.max(0, menu.length - 1);
  const view = menu.length ? FOLLOW : adjusted(height);
  const { visible, below } = sliceView(lines, height, view);
  // 收缩后触底便恢复跟随，避免旧偏移在下一次追加时复现。
  if (!small && (anchor.total !== total || anchor.height !== height)) setAnchor({ view, total, height });

  function scroll(delta: number) {
    setAnchor(previous => {
      const active = afterChange(previous.view, total - previous.total + previous.height - height, total, height);
      // 开始翻看后菜单收为一行，以收起后的高度计算底部还有多少行。
      return { view: scrollBy(active, delta, total, baseHeight), total, height: baseHeight };
    });
  }
  useEffect(() => {
    if (!small) return onWheel?.(direction => scroll(direction === 'up' ? 3 : -3));
  }, [onWheel, small, total, height, baseHeight]);

  function follow() { setAnchor({ view: FOLLOW, total, height }); }
  useInput((input, key) => {
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

  const rule = paint('dim', symbols.rule.repeat(limit), color);
  const hint = snap.ask ? FALLBACK_HINT : snap.plan ? '执行吗？  y 执行   n 取消   d 查看每一步的完整任务说明'
    : warningText || (below ? '  ' + symbols.down + ' 下面还有 ' + below + ' 行   PgDn 向下翻   End 回到最新'
      : '  / 指令   PgUp/PgDn 翻看   Esc 中断当前任务   Ctrl+C 退出');
  return <Box flexDirection="column">
    {Array.from({ length: height }, (_, i) => row(visible[i] ?? '', i))}
    {stepLine !== undefined && <Text wrap="truncate-end">{stepLine}</Text>}
    <Text wrap="truncate-end">{rule}</Text>
    <TextInput state={editor} currentState={current} onChange={change} onSubmit={text => { follow(); session.submit(text); }}
      row={height + stepHeight + 1} isActive={!snap.plan && !snap.ask} color={color} />
    <Text wrap="truncate-end">{rule}</Text>
    {menu.length ? <CommandMenu suggestions={menu} color={color} />
      : <Text wrap="truncate-end">{paint(snap.plan || snap.ask || warningText ? 'warn' : 'dim', fit(hint), color)}</Text>}
    <StatusBar status={snap.status} queued={snap.queued} contextJobId={snap.contextJobId} color={color} />
  </Box>;
}

export function FullApp(props: FullAppProps) {
  return <GlyphContext.Provider value={props.symbols}>
    <DisplayBoundary onError={props.onError}><Screen {...props} /></DisplayBoundary>
  </GlyphContext.Provider>;
}

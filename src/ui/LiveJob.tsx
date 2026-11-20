import { Box, Static, Text } from 'ink';
import { useScreen } from './screen.js';
import { clip } from './text.js';
import { formatDuration } from '../core/util.js';
import type { FeedLine, FeedState, StepView } from './feed.js';
import { toneColor, type Symbols } from './theme.js';

export interface LiveJobProps {
  jobId: string;
  title: string;
  suspended?: boolean;
  feed: FeedState;
  now: number;
  symbols: Symbols;
  color: boolean;
}

const phases = { plan: '计划', step: '执行', review: '审查', rework: '返工', summary: '汇总' };

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

type StepProps = Pick<LiveJobProps, 'now' | 'symbols' | 'color'> & { truncate?: boolean };

export function StepRow({ step, now, symbols, color, stopping, truncate }: StepProps & { step: StepView; stopping?: boolean }) {
  const running = step.state === 'running';
  const tone = running ? 'dim' : step.state === 'done' ? 'done' : 'fail';
  const symbol = tone === 'dim' ? symbols.frames[Math.floor(now / 250) % symbols.frames.length] : symbols[tone];
  const suffix = running && stopping ? '正在终止…' : step.state === 'timeout' ? '超时' : step.state === 'failed' ? '未完成' : '';
  return <Text wrap={truncate ? 'truncate-end' : undefined}>
    <Text {...toneColor(tone, color)}>{symbol}</Text> {phases[step.kind]}{'   '}
    <Text {...toneColor('role', color)}>{step.role}</Text>
    {step.agent && <> · <Text {...toneColor('agent', color)}>{step.agent}</Text></>}
    {'   '}<Text {...toneColor('dim', color)}>{running ? elapsed(now - step.startedAt) : formatDuration(step.durationMs ?? 0)}</Text>
    {suffix && `  ${suffix}`}
  </Text>;
}

/** 步骤状态占一行，动态区底部另留两行余量。 */
export function visibleActivities(activities: string[], rows: number, footerRows: number, ellipsis: string): string[] {
  const available = Math.max(1, rows - 1 - footerRows - 2);
  if (activities.length <= available) return activities;
  const omitted = activities.length - available + 1;
  return [`${ellipsis}前面还有 ${omitted} 条`, ...activities.slice(omitted)];
}

export function CurrentStep({ feed, activityLines, ...props }: StepProps & { feed: FeedState; activityLines: string[] }) {
  const { columns, wide, ellipsis } = useScreen();
  const limit = columns - 1;
  const { color } = props;
  return feed.current && <>
    <StepRow {...props} step={feed.current} stopping={feed.stopping} />
    {activityLines.map((text, i) => <Text key={i} wrap="truncate-end" {...toneColor('dim', color)}>{clip('    ' + text.split(/\r?\n/, 1)[0], limit, wide, ellipsis)}</Text>)}
  </>;
}

export function LiveJob({ jobId, title, feed, now, symbols, color, suspended }: LiveJobProps) {
  const { rows, ellipsis } = useScreen();
  const items: (FeedLine | { type: 'title' })[] = [{ type: 'title' }, ...feed.lines];
  return <Box flexDirection="column">
    <Static items={items}>{line => {
      if (line.type === 'title') return <Text key="title" {...toneColor('title', color)}>{jobId} · {title}</Text>;
      if (line.type === 'notice') return <Text key={line.key} {...toneColor('warn', color)}>{symbols.warn} {line.text}</Text>;
      return <StepRow key={line.key} step={line.step} {...{ now, symbols, color }} />;
    }}</Static>
    {!suspended && rows >= 3 && <CurrentStep {...{ feed, now, symbols, color }} truncate
      activityLines={visibleActivities(feed.activities, rows, 0, ellipsis)} />}
  </Box>;
}

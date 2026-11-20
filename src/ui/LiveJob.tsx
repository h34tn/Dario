import { Box, Static, Text } from 'ink';
import { useScreen } from './screen.js';
import { clip } from './text.js';
import { stepText } from './lines.js';
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

type StepProps = Pick<LiveJobProps, 'now' | 'symbols' | 'color'> & { truncate?: boolean };

export function StepRow({ step, now, symbols, color, stopping, truncate }: StepProps & { step: StepView; stopping?: boolean }) {
  return <Text wrap={truncate ? 'truncate-end' : undefined}>{stepText(step, { now, symbols, color, stopping })}</Text>;
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

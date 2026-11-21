import { useState } from 'react';
import { Box, Text } from 'ink';
import type { Suggestion } from './completion.js';
import { useScreen } from './screen.js';
import { clip, displayWidth } from './text.js';
import { toneColor } from './theme.js';

/** 行数预算含位置提示；只余一行时优先显示选中的候选。 */
export function menuLayout(total: number, rows: number) {
  const position = total > 6 && rows >= 2;
  const count = Math.min(total, 6, Math.max(0, rows - Number(position)));
  return { count, position, height: count + Number(position) };
}

export function CommandMenu({ suggestions, selected, layout, color }: {
  suggestions: Suggestion[]; selected: number; layout: ReturnType<typeof menuLayout>; color: boolean;
}) {
  const { columns, wide, ellipsis } = useScreen();
  const limit = columns - 1;
  const [offset, setOffset] = useState(0);
  const start = Math.max(0, selected - layout.count + 1, Math.min(offset, selected, suggestions.length - layout.count));
  if (start !== offset) setOffset(start);
  const visible = suggestions.slice(start, start + layout.count);
  const width = Math.max(...visible.map(s => displayWidth(s.label, wide))) + 2;
  const remaining = limit - 2 - width;
  return <Box flexDirection="column">{visible.map((s, i) => {
    const active = start + i === selected;
    return <Text key={s.value} wrap="truncate-end" {...toneColor('role', active && color)}>
      {clip((active ? '> ' : '  ') + s.label, limit, wide, ellipsis)}
      {remaining > 0 && <>{' '.repeat(width - displayWidth(s.label, wide))}
        <Text {...toneColor('dim', !active && color)}>{clip(s.hint, remaining, wide, ellipsis)}</Text></>}</Text>;
  })}
    {layout.position && <Text {...toneColor('dim', color)}>{clip('（' + (selected + 1) + '/' + suggestions.length + '）', limit, wide, ellipsis)}</Text>}
  </Box>;
}

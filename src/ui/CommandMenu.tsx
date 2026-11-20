import { Box, Text } from 'ink';
import type { Suggestion } from './completion.js';
import { useScreen } from './screen.js';
import { clip, displayWidth } from './text.js';
import { toneColor } from './theme.js';

export function CommandMenu({ suggestions, color }: { suggestions: Suggestion[]; color: boolean }) {
  const { columns, wide, ellipsis } = useScreen();
  const limit = columns - 1;
  if (!suggestions.length) return null;
  const width = Math.max(...suggestions.map(s => displayWidth(s.label, wide))) + 2;
  const remaining = limit - 2 - width;
  return <Box flexDirection="column">{suggestions.map(s =>
    <Text key={s.value} wrap="truncate-end">{clip('  ' + s.label, limit, wide, ellipsis)}
      {remaining > 0 && <>{' '.repeat(width - displayWidth(s.label, wide))}
        <Text {...toneColor('dim', color)}>{clip(s.hint, remaining, wide, ellipsis)}</Text></>}</Text>)}</Box>;
}

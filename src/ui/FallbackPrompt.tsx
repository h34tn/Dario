import { Box, Text, useInput } from 'ink';
import { useRef } from 'react';
import type { FallbackQuestion } from '../core/types.js';
import { FALLBACK_HINT, fallbackLines } from './lines.js';
import { useScreen } from './screen.js';
import { clip } from './text.js';
import type { Symbols } from './theme.js';

export interface FallbackPromptProps {
  question: FallbackQuestion;
  symbols: Symbols;
  color: boolean;
  onDecide: (approved: boolean) => void;
}

/** 某家 AI 不可用、要换备选之前问一句。y 继续，n、Esc、Ctrl+C 都算不同意。 */
export function FallbackPrompt({ question, symbols, color, onDecide }: FallbackPromptProps) {
  const { columns, wide, ellipsis } = useScreen();
  const limit = Math.max(1, columns - 1);
  const decided = useRef(false);
  useInput((input, key) => {
    if (decided.current) return;
    const letter = input.toLowerCase();
    if (letter === 'y' || letter === 'n' || key.escape || (key.ctrl && letter === 'c')) {
      decided.current = true;
      onDecide(letter === 'y');
    }
  });
  return <Box flexDirection="column">
    {fallbackLines(question, limit, { symbols, color, wide }).map((line, i) => <Text key={i} wrap="truncate-end">{line}</Text>)}
    <Text wrap="truncate-end">{clip(FALLBACK_HINT, limit, wide, ellipsis)}</Text>
  </Box>;
}

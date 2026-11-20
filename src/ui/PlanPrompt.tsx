import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import type { Plan } from '../core/types.js';
import { useScreen } from './screen.js';
import { clip, displayWidth, wrapText } from './text.js';
import { shortRole } from './feed.js';
import { toneColor } from './theme.js';

export interface PlanPromptProps {
  plan: Plan;
  roleLabel: (roleId: string) => string;
  color: boolean;
  onDecide: (approved: boolean) => void;
}

export function PlanPrompt({ plan, roleLabel, color, onDecide }: PlanPromptProps) {
  const { columns, wide, ellipsis } = useScreen();
  const limit = columns - 1;
  const [details, setDetails] = useState(false);
  const decided = useRef(false);
  useInput((input, key) => {
    if (decided.current) return;
    const letter = input.toLowerCase();
    if (letter === 'd') setDetails(value => !value);
    if (letter === 'y' || letter === 'n' || key.escape || (key.ctrl && letter === 'c')) {
      decided.current = true;
      onDecide(letter === 'y');
    }
  });
  function lines(prefix: string, styledPrefix: React.ReactNode, body: string) {
    const prefixWidth = displayWidth(prefix, wide);
    const remaining = limit - prefixWidth;
    if (remaining < (details ? 2 : 1)) {
      return <>
        <Text wrap="truncate-end">{clip(prefix, limit, wide, ellipsis)}</Text>
        {details && wrapText(body, limit, wide).map((line, i) => <Text key={i} wrap="truncate-end">{line}</Text>)}
      </>;
    }
    const rows = details ? wrapText(body, remaining, wide) : [clip(body.split(/\r?\n/, 1)[0]!, remaining, wide, ellipsis)];
    return rows.map((line, i) => <Text key={i} wrap="truncate-end">
      {i === 0 ? styledPrefix : ' '.repeat(prefixWidth)}{line}</Text>);
  }

  return <Box flexDirection="column">
    <Text wrap="truncate-end" {...toneColor('warn', color)}>{clip('这份计划会改动文件：', limit, wide, ellipsis)}</Text>
    {plan.steps.map((step, i) => {
      const role = shortRole(roleLabel(step.role));
      const mode = step.writes ? '改文件' : '只读';
      const prefix = `${i + 1}. ${role}  ${mode}  `;
      const styled = <>{i + 1}. <Text {...toneColor('role', color)}>{role}</Text>  {mode}{'  '}</>;
      return <Box key={i} flexDirection="column">
        {lines(prefix, styled, step.task)}
        {details && step.acceptance && lines('验收：', '验收：', step.acceptance)}
      </Box>;
    })}
    <Text wrap="truncate-end">{clip('执行吗？  y 执行   n 取消   d 查看每一步的完整任务说明', limit, wide, ellipsis)}</Text>
  </Box>;
}

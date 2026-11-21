import { Text } from 'ink';
import { useScreen } from './screen.js';
import { clip, displayWidth } from './text.js';
import type { StatusView } from './session.js';
import { paint } from './theme.js';

export function StatusBar({ status, queued, contextJobId, color }: {
  status: StatusView; queued: number; contextJobId?: string; color: boolean;
}) {
  const { columns, wide, ellipsis } = useScreen();
  const limit = columns - 1;
  const parts = [status.project];
  const extraRoles: number[] = [];
  for (const role of status.roles) {
    if (!role.priority) extraRoles.push(parts.length);
    const tone = !role.holder ? 'fail' : role.degraded ? 'warn' : 'agent';
    const name = role.holder ? role.model || role.holder : '无可用';
    const percent = role.quotaPercent;
    const usage = percent === undefined ? '' : ' ' + paint(percent >= 90 ? 'fail' : percent >= 75 ? 'warn' : 'dim', `${percent}%`, color);
    parts.push(paint('role', role.label, color) + ' ' + paint(tone, name, color) + usage);
  }
  if (queued) parts.push(`排队 ${queued}`);
  if (contextJobId) parts.push(paint('dim', `上文 ${contextJobId}`, color));
  while (parts.length > 1 && displayWidth(parts.join(' · '), wide) > limit) {
    const index = extraRoles.pop() ?? parts.length - 1;
    parts.splice(index, 1);
  }
  return <Text wrap="truncate-end">{parts.length === 1 ? clip(status.project, limit, wide, ellipsis) : parts.join(' · ')}</Text>;
}

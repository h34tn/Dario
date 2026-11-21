import type { ReactNode } from 'react';
import { findModel } from '../core/ports.js';
import { Box, Text, useInput } from 'ink';
import { formatModelTable } from '../core/report.js';
import { pickerEfforts, type ModelKey, type ModelPicker } from './session.js';
import { useScreen } from './screen.js';
import { clip, displayWidth } from './text.js';

export function ModelPrompt({ picker: p, color, onKey }: { picker: ModelPicker; color: boolean; onKey: (key: ModelKey) => void }) {
  const { rows, columns, wide, ellipsis } = useScreen();
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) onKey('back');
    else if (key.return) onKey('enter');
    else if (key.upArrow) onKey('up');
    else if (key.downArrow) onKey('down');
    else if (key.leftArrow) onKey('left');
    else if (key.rightArrow) onKey('right');
  });
  const header: string[] = [];
  const footer: string[] = [];
  let items: ReactNode[] = [];
  let selected = p.roleIndex;
  if (p.step === 'roles') {
    header.push('设置哪个角色？', '↑↓ 选择 · Enter 确定 · Esc 取消');
    items = formatModelTable(p.roles, p.modelLabel, wide);
  } else {
    const role = p.roles[p.roleIndex]!;
    header.push(`${role.alias[0] ?? role.id} · ${role.holder} — 选择模型`, '↑↓ 型号 · ←→ 强度 · Enter 保存 · Esc 返回');
    if (p.loading) header.push('正在读取型号清单…');
    if (p.list.error) header.push('没能取到型号清单：' + p.list.error);
    const current = role.candidates.find(c => c.agent === role.holder)?.model;
    selected = p.modelIndex;
    const match = findModel(p.list.models, current);
    const labelWidth = Math.min(Math.floor(columns / 2), p.list.models.reduce((width, m) =>
      Math.max(width, displayWidth(m.label || m.id, wide)), 0));
    items = p.list.models.map(m => {
      const label = clip(m.label || m.id, labelWidth, wide, ellipsis);
      const gap = ' '.repeat(labelWidth - displayWidth(label, wide) + 2);
      return <Text>{label}{gap}<Text dimColor={color}>{m.id}</Text>
        {m === match && '  ● 当前'}{m.id === p.outside && !p.list.error && '  不在清单里'}</Text>;
    });
    const efforts = pickerEfforts(p);
    if (!p.loading && efforts.length) footer.push('强度   ' + [undefined, ...efforts].map(e =>
      e === p.effort ? `[${e ?? '默认'}]` : e ?? '默认').join('   '));
    if (p.saving) footer.push('正在保存…');
  }
  if (p.message) footer.push(p.message);
  const count = Math.max(1, rows - header.length - footer.length - 2);
  const first = Math.max(0, selected - count + 1);
  const lines = [...header, ...items.slice(first, first + count).map((item, i) =>
    <Text>{first + i === selected ? '> ' : '  '}{item}</Text>), ...footer];
  return <Box flexDirection="column" width={columns - 1}>{lines.map((line, i) =>
    <Text key={i} wrap="truncate-end">{typeof line === 'string' ? clip(line, columns - 1, wide, ellipsis) : line}</Text>)}</Box>;
}

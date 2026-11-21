import { stripVTControlCharacters } from 'node:util';
import type { ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { StatusBar } from '../src/ui/StatusBar.js';
import type { StatusView } from '../src/ui/session.js';
import { paint } from '../src/ui/theme.js';
import { clip, displayWidth } from '../src/ui/text.js';

// 直接调用组件取出它自己截断好的文字，逐列扫描时不必每次经过渲染库；真实渲染见 ui-screen.test.tsx。
const screen = vi.hoisted(() => ({ columns: 80, wide: true, ellipsis: '...' }));
vi.mock('../src/ui/screen.js', () => ({ useScreen: () => screen }));

function line(status: StatusView, color: boolean): string {
  const element = StatusBar({ status, queued: 2, contextJobId: 'J0001', color }) as ReactElement<{ children: string }>;
  return element.props.children;
}

/** 改动前的状态栏：只列主控、可写角色、审查，放不下时从末尾逐段收起。 */
function legacy(status: StatusView, columns: number, wide: boolean) {
  const limit = columns - 1;
  const parts = [status.project];
  for (const role of status.roles) parts.push(`${role.label} ${role.holder ?? '无可用'}`);
  parts.push('排队 2', '上文 J0001');
  while (parts.length > 1 && displayWidth(parts.join(' · '), wide) > limit) parts.pop();
  return parts.length === 1 ? clip(status.project, limit, wide, screen.ellipsis) : parts.join(' · ');
}

const roles = {
  lead: { label: '主控', holder: 'a1', degraded: false, priority: true },
  coder: { label: '实现', holder: 'a2', degraded: true, priority: true },
  tester: { label: '测试', degraded: true, priority: false },
  review: { label: '审查', holder: 'a3', degraded: false, priority: true },
  helper: { label: '杂活', holder: 'a4', degraded: false, priority: false },
};
const project = '项目·“中”';
const three: StatusView = { project, roles: [roles.lead, roles.coder, roles.review] };
const variants: Array<[string, StatusView]> = [
  ['额外角色夹在中间和末尾', { project, roles: [roles.lead, roles.coder, roles.tester, roles.review, roles.helper] }],
  ['额外角色排在最前面', { project, roles: [roles.helper, roles.tester, roles.lead, roles.coder, roles.review] }],
];
const extra = /^(测试|杂活) /;

it('混排型号、担当者名字和无可用时，按实际文字宽度收起', () => {
  const model = 'claude-fable-5-2';
  const status: StatusView = { project, roles: [...three.roles, roles.tester].map(r => ({ ...r, model: r === roles.coder ? undefined : model })) };
  const reference = { project, roles: status.roles.map(r => ({ ...r, holder: r.holder ? r.model ?? r.holder : undefined, model: undefined })) };
  for (const wide of [true, false]) {
    for (let columns = 1; columns <= 140; columns++) {
      Object.assign(screen, { columns, wide });
      const text = line(status, true);
      expect(text).toBe(line(reference, true));
      expect(displayWidth(text, wide)).toBeLessThanOrEqual(columns - 1);
    }
  }
  expect(line(status, false)).toContain('主控 claude-fable-5-2 · 实现 a2 · 审查 claude-fable-5-2 · 测试 无可用');
});

it.each([true, false])('只有三个角色时，任何列数下都与改动前逐字相同（着色 %s）', color => {
  for (const wide of [true, false]) {
    for (let columns = 1; columns <= 120; columns++) {
      Object.assign(screen, { columns, wide });
      const text = line(three, color);
      const at = `${wide ? '宽' : '窄'} ${columns} 列`;
      expect(displayWidth(text, wide), at).toBeLessThanOrEqual(Math.max(columns - 1, 0));
      expect(stripVTControlCharacters(text), at).toBe(legacy(three, columns, wide));
    }
  }
});

it.each(variants.flatMap(([name, status]) => [true, false].map(color => [name, color, status] as const)))(
  '%s：任何列数下只先收起额外角色，去掉它们后与改动前相同（着色 %s）', (_name, color, status) => {
    let shown = 0;
    for (const wide of [true, false]) {
      for (let columns = 1; columns <= 120; columns++) {
        Object.assign(screen, { columns, wide });
        const text = line(status, color);
        const at = `${wide ? '宽' : '窄'} ${columns} 列`;
        expect(displayWidth(text, wide), at).toBeLessThanOrEqual(Math.max(columns - 1, 0));
        const parts = stripVTControlCharacters(text).split(' · ');
        const extras = parts.filter(part => extra.test(part));
        // 还列着额外角色时，排队数和上文一定都在。
        if (extras.length) expect(parts.slice(-2), at).toEqual(['排队 2', '上文 J0001']);
        shown += extras.length;
        expect(parts.filter(part => !extra.test(part)).join(' · '), at).toBe(legacy(three, columns, wide));
      }
    }
    expect(shown).toBeGreaterThan(0);
  });

it('百分数按三档着色，未知时留空，窄屏将百分数计入宽度', () => {
  Object.assign(screen, { columns: 160, wide: false });
  const status = { project, roles: [
    { ...roles.lead, quotaPercent: 74 }, { ...roles.coder, quotaPercent: 75 },
    { ...roles.review, quotaPercent: 90 }, roles.helper,
  ] };
  expect(line(status, false)).toContain('主控 a1 74% · 实现 a2 75% · 审查 a3 90% · 杂活 a4 ·');
  expect(line(status, true)).toContain(paint('dim', '74%', true));
  expect(line(status, true)).toContain(paint('warn', '75%', true));
  expect(line(status, true)).toContain(paint('fail', '90%', true));
  screen.columns = displayWidth(line(status, false), false);
  expect(line(status, false)).not.toContain('杂活');
  expect(line(status, false)).toContain('上文 J0001');
});

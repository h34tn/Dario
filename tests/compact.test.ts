import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { createApp } from '../src/compose.js';
import { parseCommand, requiresAdmin, runCompact } from '../src/core/commands.js';
import { Sandbox } from './helpers.js';

it('解析 /compact：不带参数查看，on、off 切换，其余报用法；切换要管理员', () => {
  expect(parseCommand('/compact')).toEqual({ kind: 'compact' });
  expect(parseCommand('/compact OFF')).toEqual({ kind: 'compact', on: false });
  expect(parseCommand('/compact on')).toEqual({ kind: 'compact', on: true });
  expect(parseCommand('/compact 1').kind).toBe('invalid');
  expect(parseCommand('/compact on off').kind).toBe('invalid');
  expect(requiresAdmin({ kind: 'compact' })).toBe(false);
  expect(requiresAdmin({ kind: 'compact', on: false })).toBe(true);
});

it('没给任何 AI 设界限时提示在哪里设', async () => {
  const sb = new Sandbox();
  try {
    const { engine } = await createApp({ cwd: sb.project, env: sb.env() });
    expect(runCompact(engine, { kind: 'compact' })).toContain('compact_limit: <token 数>');
  } finally { sb.cleanup(); }
});

it('/compact off 写入本机配置并保留注释，之后的运行不带压缩界限；on 恢复，重新启动后保持', async () => {
  const sb = new Sandbox({ agentsExtra: { agents: { a1: { compact_limit: 200000 }, a2: { compact_limit: 150000 } } } });
  try {
    // a1 的插件支持压缩界限，a2 不支持
    const manifest = path.join(sb.home, 'plugins', 'a1.yaml');
    fs.writeFileSync(manifest, stringify({ ...parse(fs.readFileSync(manifest, 'utf8')), compact_args: ['--compact-at', '{compact_limit}'] }));
    const file = path.join(sb.home, 'agents.yaml');
    fs.writeFileSync(file, '# 本机配置\n' + fs.readFileSync(file, 'utf8'));
    const { engine } = await createApp({ cwd: sb.project, env: sb.env() });
    const argv = async () => {
      await engine.health('a1');
      return sb.calls().at(-1)!.argv;
    };

    expect(await argv()).toEqual(expect.arrayContaining(['--compact-at', '200000']));
    const view = runCompact(engine, { kind: 'compact' });
    expect(view).toContain('压缩界限：开启\n  a1  200000 token\n  a2  150000 token（插件不支持，不生效）');

    const off = runCompact(engine, { kind: 'compact', on: false });
    expect(off).toContain(`压缩界限已关闭，已写入 ${file}`);
    expect(off).toContain('压缩界限：关闭');
    expect(await argv()).not.toContain('--compact-at');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith('# 本机配置\n')).toBe(true);
    expect(parse(text).use_compact_limit).toBe(false);
    expect((await createApp({ cwd: sb.project, env: sb.env() })).engine.compactLimits().enabled).toBe(false);

    runCompact(engine, { kind: 'compact', on: true });
    expect(parse(fs.readFileSync(file, 'utf8')).use_compact_limit).toBe(true);
    expect(await argv()).toContain('--compact-at');
  } finally { sb.cleanup(); }
});

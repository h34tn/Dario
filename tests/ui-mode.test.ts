import fs from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
import { colorEnabled, pickOutputMode, type ModeInput } from '../src/ui/mode.js';
import { paint, pickSymbols, toneColor } from '../src/ui/theme.js';

const terminal: ModeInput = { plainFlag: false, format: 'text', stderrIsTTY: true, hasStreams: true, columns: 40, env: {} };
it.each<Partial<ModeInput>>([
  { plainFlag: true }, { env: { DARIO_PLAIN: '1' } }, { format: 'json' },
  { stderrIsTTY: false }, { hasStreams: false }, { columns: 39 },
])('满足任一降级条件时用纯文本 %j', change => {
  expect(pickOutputMode({ ...terminal, ...change })).toBe('plain');
});

it('终端达到最小宽度或宽度未知时使用动态输出', () => {
  expect(pickOutputMode(terminal)).toBe('live');
  expect(pickOutputMode({ ...terminal, columns: undefined })).toBe('live');
});

it('颜色取决于标准错误与禁色环境变量', () => {
  for (const value of [undefined, '', '1']) {
    expect(colorEnabled({ stderrIsTTY: true, env: { NO_COLOR: value } })).toBe(!value);
  }
  expect(colorEnabled({ stderrIsTTY: false, env: {} })).toBe(false);
});

it('两套符号与纯文本着色遵循终端配置', () => {
  expect(pickSymbols({})).toMatchObject({ done: '+', fail: 'x', warn: '!', frames: [...'-\\|/'] });
  expect(pickSymbols({ WT_SESSION: '1' })).toMatchObject({ done: '✓', fail: '✗', warn: '!', frames: [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'] });
  expect(toneColor('title', false)).toEqual({});
  expect(paint('warn', '注意', false)).toBe('注意');
  const colored = paint('warn', '注意', true);
  expect(colored).toContain('\x1b');
  expect(stripVTControlCharacters(colored)).toBe('注意');
});

it('状态与主题独立于渲染库，命令行按需加载界面', () => {
  const read = (file: string) => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
  const renderer = /(?:from\s*|import\s*(?:\(\s*)?)['"](?:ink|react)(?:\/|['"])/;
  for (const file of ['ui/mode.ts', 'ui/theme.ts', 'ui/feed.ts', 'ui/resize.ts']) expect(read(file)).not.toMatch(renderer);
  const main = read('cli/main.ts');
  expect(main).not.toMatch(renderer);
  expect(main).toContain("await import('../ui/run.js')");
  expect(main).not.toMatch(/(?:from\s*|import\s*)['"]\.\.\/ui\//);
});

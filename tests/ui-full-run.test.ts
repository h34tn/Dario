import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/main.js';
import * as compose from '../src/compose.js';
import type { Engine } from '../src/core/engine.js';
import { runFullUi, UiUnavailableError } from '../src/ui/full.js';
import { DISABLE_MOUSE, ENABLE_MOUSE } from '../src/ui/mouse.js';
import { plan, setup } from './ui-session-helper.js';

const enter = '\x1b[?1049h';
const leave = '\x1b[?1049l';

async function terminal(rows = 16) {
  const { engine, session } = await setup();
  session.dispose();
  let output = '';
  const input = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn(),
  });
  const stdout = Object.assign(new Writable({ write(chunk, _, cb) { output += chunk.toString(); cb(); } }),
    { columns: 100, rows, isTTY: true }) as NodeJS.WriteStream;
  const opts = { stdin: input as unknown as NodeJS.ReadStream, stdout, env: { NO_COLOR: '1' },
    printLine: (line: string) => { output += line + '\n'; }, engine: engine as unknown as Engine };
  async function line(text: string) {
    input.write(text);
    await setImmediate();
    input.write('\r');
  }
  const see = (text: string) => vi.waitFor(() => expect(output).toContain(text));
  const listeners = () => [input.listeners('readable'), input.listeners('end'), stdout.listeners('resize'),
    process.listeners('exit').length];
  return { opts, engine, input, line, see, listeners, output: () => output };
}

it.each(['exit', 'plain'])('/%s 关闭鼠标后恢复普通屏幕，写回记录并释放监听', async command => {
  const t = await terminal();
  const before = t.listeners();
  const done = runFullUi(t.opts);
  await t.see(ENABLE_MOUSE);
  expect(t.output().indexOf(enter)).toBeGreaterThanOrEqual(0);
  expect(t.output().indexOf(enter)).toBeLessThan(t.output().indexOf(ENABLE_MOUSE));
  await t.line('/new');
  await t.see('已清空会话上文');
  await t.line('/' + command);
  expect(await done).toBe(command);
  const output = t.output();
  expect(output.indexOf(DISABLE_MOUSE)).toBeGreaterThan(output.indexOf(ENABLE_MOUSE));
  expect(output.indexOf(leave)).toBeGreaterThan(output.indexOf(DISABLE_MOUSE));
  expect(output.slice(output.indexOf(leave))).toContain('> /new');
  expect(output.endsWith('\n')).toBe(true);
  expect(t.listeners()).toEqual(before);
});

it('只有开场行时直接退出，普通屏幕不回写记录', async () => {
  const t = await terminal();
  const done = runFullUi(t.opts);
  await t.see(ENABLE_MOUSE);
  t.input.write('\x03');
  await t.see('再按一次');
  t.input.write('\x03');
  expect(await done).toBe('exit');
  expect(stripVTControlCharacters(t.output().split(leave)[1]!)).toBe('');
});

it('进程退出兜底向终端描述符同步写出关闭鼠标的序列', async () => {
  const t = await terminal();
  const before = process.listeners('exit');
  const done = runFullUi(t.opts);
  await t.see(ENABLE_MOUSE);
  // 只调用新增的兜底监听，避免触发测试进程自身的退出处理。
  const dir = fs.mkdtempSync(join(tmpdir(), 'dario-mouse-'));
  const file = join(dir, 'terminal');
  const fd = fs.openSync(file, 'w');
  try {
    Object.assign(t.opts.stdout, { fd });
    const added = process.listeners('exit').filter(fn => !before.includes(fn));
    expect(added).toHaveLength(1);
    added[0]!(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(DISABLE_MOUSE);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
    await t.line('/exit');
    await done;
  }
});

it('原始输入里的滚轮向上翻三行，随后输入的指令仍完整', async () => {
  const t = await terminal(12);
  const done = runFullUi(t.opts);
  await t.see(ENABLE_MOUSE);
  await t.line('/help');
  await t.see('切换到逐行交互');
  t.input.write('\x1b[<64;4;5M');
  await t.see('下面还有 3 行');
  await t.line('/exit');
  expect(await done).toBe('exit');
  expect(t.output().split(leave)[1]).toContain('> /exit');
  expect(t.output()).not.toContain('64;4;5');
});

it('原始拖选协议与键盘输入同批到达，远程终端收到纯文字剪贴板序列', async () => {
  const t = await terminal();
  const done = runFullUi({ ...t.opts, env: { ...t.opts.env, SSH_TTY: '模拟终端' } });
  await t.see(ENABLE_MOUSE);
  t.input.write('\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m/new');
  await t.see('\x1b]52;c;RGFyaW8=\x07');
  await t.see('已复制 5 个字符到剪贴板');
  t.input.write('\r');
  await t.see('已清空会话上文');
  await t.line('/exit');
  expect(await done).toBe('exit');
});

it('计划渲染失败时先恢复终端和记录，再逐行确认并降级', async () => {
  const t = await terminal();
  const before = t.listeners();
  t.engine.advance.mockImplementationOnce(async (job, opts) => {
    t.engine.roles.label = () => { throw new Error('无法显示角色'); };
    await opts.confirm!({ ...job, plan });
    return job;
  });
  const done = runFullUi(t.opts);
  await t.see(ENABLE_MOUSE);
  await t.line('改文件');
  await t.see('执行吗？(y/N)');
  t.input.write('n\n');
  expect(await done).toBe('plain');
  const output = t.output();
  expect(output.indexOf(DISABLE_MOUSE)).toBeGreaterThan(output.indexOf(ENABLE_MOUSE));
  expect(output.indexOf(leave)).toBeGreaterThan(output.indexOf(DISABLE_MOUSE));
  expect(output.split(leave)[1]).toMatch(/> 改文件[\s\S]*界面显示出错（无法显示角色），改用逐行交互。/);
  expect(t.listeners()).toEqual(before);
});

it('挂载失败时释放过滤层且未开启鼠标', async () => {
  const t = await terminal();
  const before = t.listeners();
  t.input.setRawMode.mockImplementation(() => { throw new Error('原始输入不可用'); });
  await expect(runFullUi(t.opts)).rejects.toBeInstanceOf(UiUnavailableError);
  expect(t.output()).not.toContain(ENABLE_MOUSE);
  expect(t.listeners()).toEqual(before);
});

it.each([
  { name: '默认全屏', argv: [], env: {}, rows: 12, mode: 'full' },
  { name: '选项选择行内', argv: ['--inline'], env: {}, rows: 20, mode: 'inline' },
  { name: '环境变量选择行内', argv: [], env: { DARIO_INLINE: '1' }, rows: 20, mode: 'inline' },
  { name: '十行窗口选择行内', argv: [], env: {}, rows: 10, mode: 'inline' },
  { name: '逐行选项优先', argv: ['--plain', '--inline'], env: {}, rows: 10, mode: 'plain' },
])('命令行：$name', async ({ argv, env, rows, mode }) => {
  const t = await terminal(rows);
  const { stdin, stdout, engine, printLine } = t.opts;
  const app = vi.spyOn(compose, 'createApp').mockResolvedValue({ engine } as Awaited<ReturnType<typeof compose.createApp>>);
  try {
    const done = runCli(argv, { cwd: '.', env: { ...t.opts.env, ...env }, isTTY: true, readStdin: async () => '',
      streams: { stdin, stdout, stderr: stdout }, stdout: printLine, stderr: printLine });
    await t.see(mode === 'plain' ? 'Dario 交互方式' : 'Dario · rise');
    if (mode === 'full') await t.see(ENABLE_MOUSE);
    await t.line('/exit');
    expect(await done).toBe(0);
    expect(t.output().includes(enter)).toBe(mode === 'full');
  } finally {
    app.mockRestore();
  }
});

it('命令行只按需加载全屏入口', () => {
  const source = fs.readFileSync(new URL('../src/cli/main.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/(?:from\s*|import\s*)['"]\.\.\/ui\/full/);
});

it.each([false, true])('全屏转逐行后可继续用原输入流执行指令，挂载失败：%s', async failed => {
  const t = await terminal();
  const { stdin, stdout, env, engine, printLine } = t.opts;
  if (failed) t.input.setRawMode.mockImplementationOnce(() => { throw new Error('原始输入不可用'); });
  const app = vi.spyOn(compose, 'createApp').mockResolvedValue({ engine } as Awaited<ReturnType<typeof compose.createApp>>);
  const stderr = vi.fn();
  try {
    const done = runCli([], { cwd: '.', env, isTTY: true, readStdin: async () => '',
      streams: { stdin, stdout, stderr: stdout }, stdout: printLine, stderr });
    if (!failed) {
      await t.see(ENABLE_MOUSE);
      await t.line('/plain');
    }
    await t.see('Dario 交互方式');
    if (failed) expect(stderr).toHaveBeenCalledWith('界面不可用（原始输入不可用），改用逐行交互。');
    t.input.write('/help\n/exit\n');
    expect(await done).toBe(0);
    expect(t.output()).toContain('/to <角色> <任务>');
  } finally {
    app.mockRestore();
  }
});

import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { useState } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { runCli, type CliIO } from '../src/cli/main.js';
import { TextInput } from '../src/ui/TextInput.js';
import { EMPTY_EDITOR } from '../src/ui/editor.js';
import { InputTestScreen } from '../src/ui/input-test.js';

afterEach(cleanup);

async function inputBox(isActive = true) {
  const onSubmit = vi.fn();
  function Input() {
    const [state, onChange] = useState(EMPTY_EDITOR);
    return <TextInput state={state} onChange={onChange} onSubmit={onSubmit} isActive={isActive} row={0} color={false} />;
  }
  const view = render(<Input />);
  await setImmediate();
  return { ...view, onSubmit };
}

async function frameAfter(view: ReturnType<typeof render>, key: string, expected: string) {
  view.stdin.write(key);
  await vi.waitFor(() => expect(view.lastFrame()?.trimEnd()).toBe(expected));
}

it('输入法一次确认多个字，在光标处整词插入，提交后清空', async () => {
  const view = await inputBox();
  await frameAfter(view, '你好', '> 你好');
  await frameAfter(view, '\r', '>');
  expect(view.onSubmit).toHaveBeenCalledWith('你好');
  view.stdin.write('前后');
  view.stdin.write('\x1b[D');
  await frameAfter(view, '一个词', '> 前一个词后');
});

it('方向键、退格、向后删除、首尾与清空快捷键均可编辑', async () => {
  const view = await inputBox();
  await frameAfter(view, '甲👍🏽乙', '> 甲👍🏽乙');
  view.stdin.write('\x1b[D');
  await frameAfter(view, '\x7f', '> 甲乙');
  view.stdin.write('\x1b[C');
  await frameAfter(view, '尾', '> 甲乙尾');
  view.stdin.write('\x01');
  await frameAfter(view, '\x1b[3~', '> 乙尾');
  await frameAfter(view, '首', '> 首乙尾');
  view.stdin.write('\x05');
  await frameAfter(view, '末', '> 首乙尾末');
  await frameAfter(view, '\r', '>');
  await frameAfter(view, '草稿', '> 草稿');
  await frameAfter(view, '\x1b[A', '> 首乙尾末');
  await frameAfter(view, '\x1b[B', '> 草稿');
  await frameAfter(view, '\x15', '>');
});

it('停用时忽略输入和粘贴', async () => {
  const view = await inputBox(false);
  view.stdin.write('字');
  view.stdin.write('\x1b[200~甲\n乙\x1b[201~');
  view.stdin.write('\r');
  await setImmediate();
  expect(view.lastFrame()?.trimEnd()).toBe('>');
  expect(view.onSubmit).not.toHaveBeenCalled();
});

it('转义键、制表键和中断键均不插入文字', async () => {
  const view = await inputBox();
  view.stdin.write('\x1b');
  await new Promise(resolve => setTimeout(resolve, 100));
  view.stdin.write('\t');
  view.stdin.write('\x03');
  await frameAfter(view, '字', '> 字');
});

it('诊断回显字素数、逐个码点和多行粘贴的行数与字数', async () => {
  const onExit = vi.fn();
  const view = render(<InputTestScreen color={false} onExit={onExit} />);
  await setImmediate();
  view.stdin.write('你好');
  view.stdin.write('\r');
  await vi.waitFor(() => expect(view.frames.join('\n')).toContain('第 1 次  收到 2 个字  "你好"'));
  expect(view.frames.join('\n')).toContain('码点 4F60 597D');
  view.stdin.write('\x1b[200~甲\r\n👍🏽\n乙丙\x1b[201~');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('> [已粘贴 3 行]'));
  view.stdin.write('\r');
  await vi.waitFor(() => expect(view.frames.join('\n')).toContain('第 2 次  收到 3 行（共 4 个字）'));
  expect(view.frames.join('\n')).toContain('第一行 "甲"');
  view.stdin.write('  /exit ');
  view.stdin.write('\r');
  await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
});

it('只列前四十个码点并标记省略', async () => {
  const view = render(<InputTestScreen color={false} onExit={vi.fn()} />);
  await setImmediate();
  view.stdin.write('a'.repeat(41));
  view.stdin.write('\r');
  await vi.waitFor(() => expect(view.frames.join('\n').replace(/\s+/g, ' ')).toContain('码点 ' + '61 '.repeat(40) + '…'));
});

it('中断提示可被其他按键清除，连续两次中断才退出', async () => {
  const onExit = vi.fn();
  const view = render(<InputTestScreen color={false} onExit={onExit} />);
  await setImmediate();
  view.stdin.write('\x03');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('再按一次 Ctrl+C 退出'));
  view.stdin.write('\t');
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain('再按一次 Ctrl+C 退出'));
  expect(onExit).not.toHaveBeenCalled();
  view.stdin.write('\x03');
  view.stdin.write('\x03');
  await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
});

it('文字和编辑器独立于界面依赖，命令只按需加载诊断界面', () => {
  const source = (path: string) => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
  for (const path of ['ui/text.ts', 'ui/editor.ts']) {
    expect(source(path)).not.toMatch(/(?:from\s*|import\s*\(?\s*)['"](?:ink|react)(?:\/|['"])/);
  }
  expect(source('cli/main.ts')).not.toMatch(/(?:from\s*|import\s*)['"]\.\.\/ui\/input-test/);
});

it('诊断命令缺少标准输出流时报错，管道提示只写到提供的标准输出流', async () => {
  const io: CliIO = { env: {}, cwd: '.', isTTY: false, readStdin: vi.fn(), stdout: vi.fn(), stderr: vi.fn() };
  expect(await runCli(['input-test'], io)).toBe(2);
  expect(io.stderr).toHaveBeenCalledWith('输入检查需要在终端里直接运行。');
  const stdout = { isTTY: false, write: vi.fn() };
  const streams = { stdin: process.stdin, stderr: process.stderr, stdout: stdout as unknown as NodeJS.WriteStream };
  expect(await runCli(['input-test'], { ...io, streams })).toBe(2);
  expect(stdout.write).toHaveBeenCalledWith('输入检查需要在终端里直接运行，不能通过管道。\n');
  expect(io.stderr).toHaveBeenCalledTimes(1);
  expect(io.readStdin).not.toHaveBeenCalled();
});

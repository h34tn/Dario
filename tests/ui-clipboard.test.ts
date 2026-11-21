import { afterEach, expect, it, vi } from 'vitest';
import { copyText } from '../src/ui/clipboard.js';

afterEach(() => vi.useRealTimers());

it.each([
  ['win32', '', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']],
  ['darwin', '', 'pbcopy', []],
  ['linux', 'wayland-0', 'wl-copy', []], ['linux', '', 'xclip', ['-selection', 'clipboard']],
] as const)('在 %s 正确选择命令，显示环境为 %s，文字写到标准输入', async (platform, display, command, args) => {
  const run = vi.fn(async () => {}), write = vi.fn();
  expect(await copyText('中', { platform, env: { WAYLAND_DISPLAY: display }, run, write })).toEqual({ ok: true });
  expect(run).toHaveBeenCalledWith(command, args, Buffer.from([228, 184, 173]), expect.any(AbortSignal));
  expect(write).not.toHaveBeenCalled();
});

it.each(['SSH_TTY', 'SSH_CONNECTION'])('设置 %s 时直接发送 UTF-8 的 OSC 52', async key => {
  const run = vi.fn(), write = vi.fn();
  expect(await copyText('中', { env: { [key]: '远程' }, run, write })).toEqual({ ok: true });
  expect(write).toHaveBeenCalledExactlyOnceWith('\x1b]52;c;5Lit\x07');
  expect(run).not.toHaveBeenCalled();
});

it('X11 中依次尝试系统命令，均失败时发送终端序列', async () => {
  const run = vi.fn().mockRejectedValue(new Error('不可用')), write = vi.fn();
  expect(await copyText('中', { platform: 'linux', env: {}, run, write })).toEqual({ ok: true });
  expect(run.mock.calls.map(args => args.slice(0, 2))).toEqual([['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]);
  expect(write).toHaveBeenCalledOnce();
});

it('五秒超时终止命令，终端写入失败返回原因', async () => {
  vi.useFakeTimers();
  const run = vi.fn(() => new Promise<void>(() => {}));
  const write = vi.fn().mockRejectedValue(new Error('终端已关闭'));
  const result = copyText('中', { platform: 'darwin', env: {}, run, write });
  await vi.advanceTimersByTimeAsync(4999);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledWith('pbcopy', [], expect.any(Buffer), expect.objectContaining({ aborted: true }));
  expect(await result).toEqual({ ok: false, reason: '终端已关闭' });
});

it('OSC 52 按编码后的长度限制，恰好十万字节仍能发送', async () => {
  const write = vi.fn(), opts = { env: { SSH_TTY: '远程' }, write };
  expect(await copyText('中'.repeat(25000), opts)).toEqual({ ok: true });
  expect(await copyText('中'.repeat(25001), opts)).toEqual({ ok: false, reason: expect.stringContaining('太长') });
  expect(write).toHaveBeenCalledOnce();
});

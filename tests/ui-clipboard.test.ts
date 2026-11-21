import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/core/state.js';
import { copyText, readClipboard, readClipboardImage } from '../src/ui/clipboard.js';

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

it.each([
  ['win32', '', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']],
  ['darwin', '', 'pbpaste', []], ['linux', 'wayland-0', 'wl-paste', ['--no-newline', '--type', 'text']],
  ['linux', '', 'xclip', ['-selection', 'clipboard', '-o']],
] as const)('%s 读取剪贴板并规范换行，显示环境为 %s', async (platform, display, command, args) => {
  const run = vi.fn().mockResolvedValue('甲\r\n👍🏽\r\n');
  expect(await readClipboard({ platform, env: { WAYLAND_DISPLAY: display }, run })).toEqual({ ok: true, text: '甲\n👍🏽\n' });
  expect(run).toHaveBeenCalledExactlyOnceWith(command, args, expect.any(AbortSignal));
});

it('X11 读取失败后用 xsel，远程会话不启动读取命令', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('找不到命令')).mockResolvedValue('');
  expect(await readClipboard({ platform: 'linux', env: {}, run })).toEqual({ ok: true, text: '' });
  expect(run).toHaveBeenLastCalledWith('xsel', ['--clipboard', '--output'], expect.any(AbortSignal));
  run.mockClear();
  for (const key of ['SSH_TTY', 'SSH_CONNECTION']) {
    expect(await readClipboard({ env: { [key]: '远程' }, run })).toEqual({ ok: false, reason: '远程会话里读不到本机剪贴板，请用终端自己的粘贴' });
  }
  expect(run).not.toHaveBeenCalled();
});

it('五秒后中止读取并报告超时', async () => {
  vi.useFakeTimers();
  const run = vi.fn(() => new Promise<string>(() => {}));
  const result = readClipboard({ platform: 'linux', env: {}, run });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toEqual({ ok: false, reason: '剪贴板命令超时' });
  expect(run).toHaveBeenCalledExactlyOnceWith('xclip', ['-selection', 'clipboard', '-o'], expect.objectContaining({ aborted: true }));
});

function imageStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-image-'));
  const store = new StateStore(dir);
  return { store, target: store.newImagePath(), cleanup: () => fs.rmSync(dir, { force: true, recursive: true }) };
}

it('通过环境变量传目标，Windows STA 脚本经 UTF-16LE 编码，识别位图、文件列表和空内容', async () => {
  const { target, cleanup } = imageStore();
  try {
    const source = target + ' 中 文.GIF';
    fs.writeFileSync(source, Buffer.from('47494638396102000300', 'hex'));
    const run = vi.fn().mockImplementationOnce(async () => {
      fs.writeFileSync(target, '位图');
      return Buffer.from('image 480x200\r\n');
    });
    const read = () => readClipboardImage(() => target, { platform: 'win32', env: {}, run });
    expect(await read()).toEqual({ kind: 'image', path: target, width: 480, height: 200 });
    const [command, args, env] = run.mock.calls[0]!;
    expect(command).toBe('powershell.exe');
    expect(args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    expect(script).toContain('$env:DARIO_IMAGE_OUT');
    expect(script).not.toContain(target);
    expect(env.DARIO_IMAGE_OUT).toBe(target);
    run.mockResolvedValueOnce(Buffer.from('files x.txt|' + source + '|不存在.png\r\n'));
    const file = target.slice(0, -4) + '.GIF';
    expect(await read()).toEqual({ kind: 'image', path: file, width: 2, height: 3 });
    expect(fs.readFileSync(file)).toEqual(fs.readFileSync(source));
    for (const value of ['files a.txt', 'none']) {
      run.mockResolvedValueOnce(Buffer.from(value));
      expect(await read()).toEqual({ kind: 'none' });
    }
  } finally { cleanup(); }
});

it('图片路径不重名，清理只删修改时间超过七天的图片', () => {
  const { store, target, cleanup } = imageStore();
  try {
    const boundary = store.newImagePath();
    expect(path.isAbsolute(target)).toBe(true);
    expect(boundary).not.toBe(target);
    const now = Math.floor(Date.now() / 1000) * 1000;
    const cutoff = now / 1000 - 7 * 86400;
    for (const [file, time] of [[target, cutoff - 1], [boundary, cutoff], [target + '.txt', cutoff - 1]] as const) {
      fs.writeFileSync(file, '');
      fs.utimesSync(file, time, time);
    }
    store.cleanOldImages(now);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(boundary)).toBe(true);
    expect(fs.existsSync(target + '.txt')).toBe(true);
  } finally { cleanup(); }
});

it('远程取图不启动命令，本地超时中止，超大图片删除并说明原因', async () => {
  const { target, cleanup } = imageStore();
  try {
    const run = vi.fn();
    for (const key of ['SSH_TTY', 'SSH_CONNECTION']) {
      expect(await readClipboardImage(() => target, { env: { [key]: '是' }, run })).toEqual({ kind: 'error', reason: '远程会话里读不到本机剪贴板里的图片' });
    }
    expect(run).not.toHaveBeenCalled();
    vi.useFakeTimers();
    run.mockImplementationOnce(() => new Promise(() => {}));
    const result = readClipboardImage(() => target, { env: {}, platform: 'win32', run });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({ kind: 'error', reason: '剪贴板命令超时' });
    expect(run.mock.calls[0]![3].aborted).toBe(true);
    vi.useRealTimers();
    run.mockImplementationOnce(async () => {
      fs.writeFileSync(target, '');
      fs.truncateSync(target, 20 * 1024 * 1024 + 1);
      return Buffer.from('image 1x1');
    });
    expect(await readClipboardImage(() => target, { env: {}, platform: 'win32', run })).toEqual({ kind: 'error', reason: '图片太大' });
    expect(fs.existsSync(target)).toBe(false);
  } finally { cleanup(); }
});

it.each([
  ['darwin', '', 'osascript'], ['linux', 'wayland', 'wl-paste'], ['linux', '', 'xclip'],
] as const)('%s 取图选择 %s 显示环境下的 %s，保留 PNG 二进制', async (platform, display, command) => {
  const { target, cleanup } = imageStore();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000300000005', 'hex');
    const run = vi.fn().mockImplementationOnce(async () => {
      if (platform !== 'darwin') return png;
      fs.writeFileSync(target, png);
      return Buffer.alloc(0);
    });
    const options = { platform, env: { WAYLAND_DISPLAY: display }, run };
    expect(await readClipboardImage(() => target, options)).toEqual({ kind: 'image', path: target, width: 3, height: 5 });
    const args = command === 'osascript' ? ['-e', expect.stringContaining('«class PNGf»'), target]
      : command === 'wl-paste' ? ['--type', 'image/png'] : ['-selection', 'clipboard', '-t', 'image/png', '-o'];
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual([command, args]);
    expect(fs.readFileSync(target)).toEqual(png);
    run.mockResolvedValueOnce(Buffer.from(platform === 'darwin' ? 'none' : ''));
    expect(await readClipboardImage(() => target, options)).toEqual({ kind: 'none' });
  } finally { cleanup(); }
});

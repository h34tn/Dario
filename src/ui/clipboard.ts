import { spawn } from 'node:child_process';

export type CopyResult = { ok: true } | { ok: false; reason: string };
type Run = (command: string, args: string[], data: Buffer, signal: AbortSignal) => Promise<void>;

const runCommand: Run = (command, args, data, signal) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, signal, killSignal: 'SIGKILL' });
  child.once('error', reject);
  child.stdin.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error('剪贴板命令执行失败')));
  child.stdin.end(data);
});

interface Options {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  write: (sequence: string) => Promise<void>;
}

/**
 * Windows 上从标准输入按 UTF-8 读入、再放进剪贴板的 PowerShell 命令。
 * 不用 clip.exe：实测它对 UTF-16LE 带 BOM 的输入会把 BOM 当成文字留在剪贴板开头，
 * 不带 BOM 时又靠猜测判断编码，短的纯中文（如"三家都实时取"）会变成乱码。
 */
const WINDOWS_COPY = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
  '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'];
/** 等剪贴板命令的时限。PowerShell 冷启动常要半秒到一秒多，比其他系统的命令慢。 */
const TIMEOUT_MS = 5000;

export async function copyText(text: string, { platform = process.platform, env = process.env, run = runCommand, write }: Options): Promise<CopyResult> {
  if (!env.SSH_TTY && !env.SSH_CONNECTION) {
    let commands: string[][] = [];
    if (platform === 'win32') commands = [WINDOWS_COPY];
    if (platform === 'darwin') commands = [['pbcopy']];
    if (platform === 'linux') commands = env.WAYLAND_DISPLAY ? [['wl-copy']] : [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
    const data = Buffer.from(text);
    for (const [command, ...args] of commands) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('剪贴板命令超时')); }, TIMEOUT_MS);
        }), run(command, args, data, controller.signal)]);
        return { ok: true };
      } catch {
        // 命令失败或超时，继续尝试下一种复制途径。
      } finally { clearTimeout(timer); }
    }
  }
  if (4 * Math.ceil(Buffer.byteLength(text) / 3) > 100000) return { ok: false, reason: '文字太长，无法通过 OSC 52 复制' };
  try {
    await write('\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '无法写入终端' };
  }
}

export type ReadResult = { ok: true; text: string } | { ok: false; reason: string };
type ReadCommand = (command: string, args: string[], signal: AbortSignal) => Promise<string>;

const readCommand: ReadCommand = (command, args, signal) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, signal, killSignal: 'SIGKILL' });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.once('error', reject);
  child.once('close', code => {
    if (code !== 0) reject(new Error('剪贴板命令执行失败'));
    // PowerShell 输出字符串时另写一个行结束符，剪贴板原有的末尾换行保留。
    else resolve(command === 'powershell.exe' ? output.replace(/\r\n$/, '') : output);
  });
});

export async function readClipboard({ platform = process.platform, env = process.env, run = readCommand }: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: ReadCommand;
} = {}): Promise<ReadResult> {
  if (env.SSH_TTY || env.SSH_CONNECTION) return { ok: false, reason: '远程会话里读不到本机剪贴板，请用终端自己的粘贴' };
  let commands: string[][] = [];
  if (platform === 'win32') commands = [['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']];
  if (platform === 'darwin') commands = [['pbpaste']];
  if (platform === 'linux') commands = env.WAYLAND_DISPLAY ? [['wl-paste', '--no-newline']]
    : [['xclip', '-selection', 'clipboard', '-o'], ['xsel', '--clipboard', '--output']];
  const controller = new AbortController();
  let reason = '系统没有可用的剪贴板命令';
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error('剪贴板命令超时')); controller.abort(); }, TIMEOUT_MS);
  });
  try {
    for (const [command, ...args] of commands) {
      try {
        const text = await Promise.race([run(command, args, controller.signal), timeout]);
        return { ok: true, text: text.replace(/\r\n/g, '\n') };
      } catch (error) {
        reason = error instanceof Error ? error.message : '无法读取剪贴板';
        if (controller.signal.aborted) break;
      }
    }
    return { ok: false, reason };
  } finally { clearTimeout(timer); }
}

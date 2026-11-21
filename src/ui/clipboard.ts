import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';

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

/** X11 和 Wayland 在剪贴板没有所请求的类型时返回非零退出码。 */
function missingClipboardType(command: string, stderr: string) {
  return (command === 'wl-paste' && /no suitable type|nothing is copied|no selection/i.test(stderr))
    || (command === 'xclip' && /target .+ not available/i.test(stderr));
}

const readCommand: ReadCommand = (command, args, signal) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal, killSignal: 'SIGKILL' });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.once('error', reject);
  child.once('close', code => {
    if (code !== 0 && missingClipboardType(command, stderr)) resolve('');
    else if (code !== 0) reject(new Error('剪贴板命令执行失败'));
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
  if (platform === 'linux') commands = env.WAYLAND_DISPLAY ? [['wl-paste', '--no-newline', '--type', 'text']]
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

const IMAGE_LIMIT = 20 * 1024 * 1024;
const WINDOWS_IMAGE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($image) {
  $image.Save($env:DARIO_IMAGE_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ('image ' + $image.Width + 'x' + $image.Height)
} elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  Write-Output ('files ' + ([System.Windows.Forms.Clipboard]::GetFileDropList() -join '|'))
} else { Write-Output 'none' }`;

const MAC_IMAGE = `on run argv
  try
    set pngData to the clipboard as «class PNGf»
  on error
    return "none"
  end try
  set handle to open for access POSIX file (item 1 of argv) with write permission
  try
    write pngData to handle
  on error messageText
    close access handle
    error messageText
  end try
  close access handle
end run`;

type ImageCommand = (command: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<Buffer>;
const runImage: ImageCommand = async (command, args, env, signal) => {
  try {
    return (await promisify(execFile)(command, args, {
      env, signal, windowsHide: true, killSignal: 'SIGKILL', encoding: 'buffer', maxBuffer: IMAGE_LIMIT + 1,
    })).stdout;
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: Buffer };
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('图片太大');
    if (typeof failure.code === 'number' && missingClipboardType(command, String(failure.stderr ?? ''))) return Buffer.alloc(0);
    throw new Error('剪贴板命令执行失败' + (failure.code ? '（' + failure.code + '）' : ''));
  }
};

export type ClipboardImage = { kind: 'image'; path: string; width?: number; height?: number }
  | { kind: 'none' } | { kind: 'error'; reason: string };

function windowsImage(output: string) {
  const dimensions = /^image (\d+)x(\d+)$/.exec(output);
  if (dimensions) return { kind: 'image' as const, width: Number(dimensions[1]), height: Number(dimensions[2]) };
  if (output.startsWith('files ')) return { kind: 'files' as const, paths: output.slice(6).split('|') };
  if (output === 'none') return { kind: 'none' as const };
  throw new Error('剪贴板命令返回了无法识别的结果');
}

/** 从格式头读取尺寸，不解码像素。 */
function imageDimensions(data: Buffer): { width?: number; height?: number } {
  if (data.length < 10) return {};
  const type = data.toString('ascii', 0, 4);
  if (data.length >= 24 && data.toString('ascii', 12, 16) === 'IHDR') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (type.startsWith('GIF8')) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (type.startsWith('BM') && data.length >= 26) {
    if (data.readUInt32LE(14) === 12) return { width: data.readUInt16LE(18), height: data.readUInt16LE(20) };
    return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
  }
  if (type === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.length >= 30) {
    switch (data.toString('ascii', 12, 16)) {
      case 'VP8X': return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
      case 'VP8 ': return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      case 'VP8L': {
        const bits = data.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
    }
  }
  if (data.readUInt16BE(0) === 0xffd8) {
    // JPEG 的帧头可能位于较长的 EXIF 等元数据之后。
    for (let pos = 2; pos + 8 < data.length && data[pos] === 0xff;) {
      const marker = data[++pos]!;
      if (marker === 0xff) continue;
      const length = data.readUInt16BE(++pos);
      if (length < 2 || marker === 0xda) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(pos + 5), height: data.readUInt16BE(pos + 3) };
      }
      pos += length;
    }
  }
  return {};
}

/** 路径由状态存储分配；只有成功才把文件交给输入框。 */
export async function readClipboardImage(newPath: () => string, { platform = process.platform, env = process.env, run = runImage }: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: ImageCommand;
} = {}): Promise<ClipboardImage> {
  if (env.SSH_TTY || env.SSH_CONNECTION) return { kind: 'error', reason: '远程会话里读不到本机剪贴板里的图片' };
  let target: string;
  try { target = newPath(); }
  catch (error) { return { kind: 'error', reason: error instanceof Error ? error.message : '无法分配图片路径' }; }
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error('剪贴板命令超时')); controller.abort(); }, TIMEOUT_MS);
  });
  const read = (command: string, args: string[]) => Promise.race([
    run(command, args, { ...env, DARIO_IMAGE_OUT: target }, controller.signal), timeout,
  ]);
  let file = target;
  try {
    let size: { width?: number; height?: number } = {};
    if (platform === 'win32') {
      const script = Buffer.from(WINDOWS_IMAGE, 'utf16le').toString('base64');
      const result = windowsImage((await read('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', script])).toString().trimEnd());
      if (result.kind === 'none') return result;
      if (result.kind === 'files') {
        const source = result.paths.find(p => /\.(png|jpe?g|gif|webp|bmp)$/i.test(p));
        if (!source) return { kind: 'none' };
        file = target.slice(0, -4) + path.extname(source);
        if ((await fs.stat(source)).size > IMAGE_LIMIT) throw new Error('图片太大');
        await fs.copyFile(source, file);
      } else size = { width: result.width, height: result.height };
    } else if (platform === 'darwin') {
      if ((await read('osascript', ['-e', MAC_IMAGE, target])).toString().trim() === 'none') return { kind: 'none' };
    } else if (platform === 'linux') {
      const png = env.WAYLAND_DISPLAY ? await read('wl-paste', ['--type', 'image/png'])
        : await read('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
      if (!png.length) return { kind: 'none' };
      if (png.length > IMAGE_LIMIT) throw new Error('图片太大');
      await fs.writeFile(file, png, { mode: 0o600 });
    } else throw new Error('系统没有可用的剪贴板命令');
    if ((await fs.stat(file)).size > IMAGE_LIMIT) throw new Error('图片太大');
    if (!size.width) size = imageDimensions(await fs.readFile(file));
    return { kind: 'image', path: file, ...size };
  } catch (error) {
    await fs.rm(file, { force: true }).catch(() => {});
    return { kind: 'error', reason: error instanceof Error ? error.message : '无法读取剪贴板' };
  } finally { clearTimeout(timer); }
}

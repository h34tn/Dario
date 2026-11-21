import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class DarioError extends Error {
  constructor(
    message: string,
    /** 无头方式下对应的退出码。 */
    readonly exitCode: number = 2,
  ) {
    super(message);
    this.name = 'DarioError';
  }
}

/** 配置或用法错误，退出码 2。 */
export class ConfigError extends DarioError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'ConfigError';
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/**
 * 路径的真实形式：解开符号链接，并把 Windows 的短文件名（如 PROGRA~1）展开成长文件名。
 * 路径不存在时退回到绝对化的结果。
 */
export function realPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** 规范化路径用于比较：取真实路径、统一分隔符，Windows 上忽略大小写。 */
export function normPath(p: string): string {
  const abs = realPath(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 先写临时文件再改名，避免读到写了一半的内容。 */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows 上目标文件正被另一个进程读取时会短暂失败
      lastError = e;
      sleepSync(15);
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // 忽略
  }
  throw lastError;
}

export function writeJsonAtomic(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 跨进程互斥：以"创建目录"为原子操作。持有者进程已不存在或锁超过 staleMs 时视为失效。
 */
export function withLock<T>(lockDir: string, fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T {
  const waitMs = opts.waitMs ?? 5000;
  const staleMs = opts.staleMs ?? 30000;
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const ownerFile = path.join(lockDir, 'owner');
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile, String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        const owner = Number(readText(ownerFile));
        stale = age > staleMs || (Number.isFinite(owner) && owner > 0 && !isPidAlive(owner));
      } catch {
        stale = true;
      }
      if (stale) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new DarioError(`等待锁超时：${lockDir}`, 2);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字）`;
}

/** 压成一行并在超长时加省略号，用于列表里的简短显示。 */
export function ellipsis(text: string, max: number): string {
  const oneLine = text.replace(/s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** 本地时间，形如 2026-01-31 09:05。 */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** token 数的短写法：426、35.7k、1.2M。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}

import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { killProcessTree } from '../core/proc.js';

/** 默认传给 AI 子进程的系统环境变量。其余变量一律不传，除非插件或用户配置里列出。 */
export const SYSTEM_ENV = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PSModulePath',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_*',
  'TERM',
  'TZ',
  'XDG_*',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

function matcher(patterns: string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of patterns) {
    const key = p.toUpperCase();
    if (key.endsWith('*')) prefixes.push(key.slice(0, -1));
    else exact.add(key);
  }
  return (name) => {
    const key = name.toUpperCase();
    return exact.has(key) || prefixes.some((p) => key.startsWith(p));
  };
}

/** 按名单挑出要传给子进程的环境变量。名字不区分大小写，支持以 * 结尾的前缀。 */
export function buildEnv(source: NodeJS.ProcessEnv, patterns: string[], extra: Record<string, string> = {}): Record<string, string> {
  const allowed = matcher(patterns);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowed(name)) env[name] = value;
  }
  return { ...env, ...extra };
}

/** 在 PATH 里查找可执行文件，返回完整路径。 */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const isWin = process.platform === 'win32';
  // Windows 上先试带扩展名的：npm 会同时放一个没有扩展名的脚本，那个不能直接运行
  const exts = isWin ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''] : [''];
  const tryFile = (base: string): string | undefined => {
    for (const ext of exts) {
      const candidate = base + ext;
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 不存在
      }
    }
    return undefined;
  };
  if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) return tryFile(path.resolve(command));
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const found = tryFile(path.join(dir, command));
    if (found) return found;
  }
  return undefined;
}

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  /** 启动后这么久没有任何输出就终止。不填则不检查。 */
  startupTimeoutMs?: number;
  onSpawn?: (pid: number) => void;
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut: boolean;
  startupTimedOut: boolean;
  durationMs: number;
}

const MAX_CAPTURE = 32 * 1024 * 1024;

/** 启动一个进程并等它结束。超时或启动后无输出时终止整个进程树。 */
export function runProcess(req: ProcessRequest): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let startupTimedOut = false;
    let spawnError: string | undefined;
    let settled = false;
    let gotOutput = false;
    let overall: NodeJS.Timeout | undefined;
    let startup: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (overall) clearTimeout(overall);
      if (startup) clearTimeout(startup);
      resolve({ exitCode, stdout, stderr, spawnError, timedOut, startupTimedOut, durationMs: Date.now() - started });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: req.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // 非 Windows 上放进独立进程组，便于整组终止
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      spawnError = (e as Error).message;
      finish(null);
      return;
    }

    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e.code === 'ENOENT' ? `找不到命令：${req.command}` : e.message;
      finish(null);
    });
    if (child.pid) req.onSpawn?.(child.pid);

    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      gotOutput = true;
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      gotOutput = true;
      stderr = append(stderr, chunk);
    });

    child.stdin?.on('error', () => {
      // 进程提前退出时写入会失败，结果以退出码为准
    });
    child.stdin?.end(req.stdin ?? '');

    overall = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, req.timeoutMs);
    if (req.startupTimeoutMs && req.startupTimeoutMs < req.timeoutMs) {
      startup = setTimeout(() => {
        if (gotOutput) return;
        startupTimedOut = true;
        killProcessTree(child.pid);
      }, req.startupTimeoutMs);
    }

    child.on('close', (code) => finish(code));
  });
}

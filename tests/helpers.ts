import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { runCli } from '../src/cli/main.js';

const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent', 'fake-agent.mjs');

export const DEFAULT_TEST_ROLES = `
roles:
  lead:
    alias: [主控]
    candidates: [a1]
    access: read-only
  coder:
    alias: [实现]
    candidates: [a2, a3]
    access: write
  reviewer:
    alias: [审查]
    candidates: [a3, a2]
    access: read-only
    must_differ_from: coder
fallback: auto
`;

/** 假 AI 的一条回应，字段含义见 fake-agent.mjs。 */
export interface FakeResponse {
  stream?: Array<{ line: string; delayMs?: number }>;
  text?: string;
  exit?: number;
  stderr?: string;
  delayMs?: number;
  hang?: boolean;
  silent?: boolean;
  files?: Array<{ path: string; content: string | null }>;
  spawnChild?: boolean;
  echoPrompt?: boolean;
  sessionLost?: boolean;
  /** [输入, 其中命中缓存, 输出]，按整个会话的累计值报。只对支持续接的假 AI 有效。 */
  usage?: [number, number, number];
  /** 写完文件后依次执行的命令，失败的记在 <剧本>.commands.log。 */
  commands?: string[][];
}

export interface FakeCall {
  name: string;
  access: string;
  call: number;
  argv: string[];
  prompt: string;
  cwd: string;
  envNames: string[];
  depth?: string;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

export interface SandboxOptions {
  roles?: string;
  projectYaml?: string;
  /** 把项目目录初始化成 git 仓库（检测改动需要）。 */
  git?: boolean;
  /** 假 AI 的名字，默认 a1、a2、a3。 */
  agents?: string[];
  /** 假 AI 是否声明为"启动后很快有输出"。 */
  streams?: boolean;
  progressLines?: boolean;
  /** 追加到 agents.yaml 顶层的设置。 */
  agentsExtra?: Record<string, unknown>;
  /** 假 AI 是否支持续接会话。为 true 时用代码式插件接入。 */
  resumable?: boolean;
  /** 假 AI 逐行输出并能认出执行命令、改文件的活动（见 writeActivityPlugin）。用代码式插件接入。 */
  activity?: boolean;
}

export function sh(cwd: string, command: string, args: string[]): string {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
}

export function gitInit(dir: string): void {
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.name', 'tester']);
  sh(dir, 'git', ['config', 'user.email', 'tester@example.com']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
}

/** 一套互相隔离的临时环境：本机配置目录、项目目录、假 AI 与它们的剧本。 */
export class Sandbox {
  readonly dir: string;
  readonly home: string;
  readonly project: string;
  readonly scenarioFile: string;
  readonly agents: string[];
  /** 额外传入命令行的环境变量。 */
  extraEnv: Record<string, string> = {};

  constructor(opts: SandboxOptions = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-test-'));
    this.home = path.join(this.dir, 'home');
    this.project = path.join(this.dir, 'project');
    this.scenarioFile = path.join(this.dir, 'scenario.json');
    this.agents = opts.agents ?? ['a1', 'a2', 'a3'];
    fs.mkdirSync(path.join(this.home, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(this.project, '.dario'), { recursive: true });

    for (const name of this.agents) {
      if (opts.activity) this.writeActivityPlugin(name, opts.resumable);
      else if (opts.resumable) this.writeResumablePlugin(name);
      else this.writeFakePlugin(name, opts.streams ?? false, undefined, undefined, opts.progressLines);
    }
    fs.writeFileSync(
      path.join(this.home, 'agents.yaml'),
      stringify({
        plugins: this.agents.map((n) => `./plugins/${n}.${opts.resumable || opts.activity ? 'mjs' : 'yaml'}`),
        cooldown_minutes: 10,
        startup_timeout_seconds: 2,
        ...(opts.agentsExtra ?? {}),
      }),
    );
    this.writeRoles(opts.roles ?? DEFAULT_TEST_ROLES);
    if (opts.projectYaml) fs.writeFileSync(path.join(this.project, '.dario', 'project.yaml'), opts.projectYaml);
    this.setScenario({});
    if (opts.git) {
      gitInit(this.project);
      fs.writeFileSync(path.join(this.project, 'README.md'), '# 测试项目\n');
      sh(this.project, 'git', ['add', '-A']);
      sh(this.project, 'git', ['commit', '-q', '-m', 'chore: 初始化']);
    }
  }

  writeFakePlugin(name: string, streams: boolean, command: string = process.execPath, prefix: string[] = [FAKE_AGENT], progressLines = false): void {
    const common = [...prefix, '--name', name, '--scenario', this.scenarioFile];
    fs.writeFileSync(
      path.join(this.home, 'plugins', `${name}.yaml`),
      stringify({
        id: name,
        display_name: `假 AI ${name}`,
        command,
        version_args: [...prefix, '--name', name, '--version'],
        args: { read_only: [...common, '--access', 'read-only'], write: [...common, '--access', 'write'] },
        streams,
        ...(progressLines && { progress: 'lines' }),
      }),
    );
  }

  /**
   * 支持续接的假 AI：续接时参数里带 --resume <会话号>，会话号取自输出的第一行。
   * 剧本里写了 usage 时第二行是用量，按"整个会话的累计值"报，和 Codex 一样。
   */
  writeResumablePlugin(name: string, modelQueryName?: string): void {
    const base = [FAKE_AGENT, '--name', name, '--scenario', this.scenarioFile, '--emit-session'];
    fs.writeFileSync(
      path.join(this.home, 'plugins', `${name}.mjs`),
      `const base = ${JSON.stringify(base)};
export default {
  apiVersion: 1,
  id: ${JSON.stringify(name)},
  displayName: ${JSON.stringify(`假 AI ${name}`)},
  defaultCommand: ${JSON.stringify(process.execPath)},
  versionArgs: ${JSON.stringify([FAKE_AGENT, '--name', name, '--version'])},
  streams: false,
  resumes: true,
  efforts: ['low', 'high'],
  ${modelQueryName ? `modelsQuery: { args: ${JSON.stringify([FAKE_AGENT, '--name', modelQueryName, '--scenario', this.scenarioFile])}, parse: JSON.parse },` : ''}
  models: [{ id: 'light', efforts: ['low'] }, ...['custom', 'base', 'review', 'work'].map(id => ({ id }))],
  build: (req) => ({
    args: [...base, '--access', req.access, ...(req.resume ? ['--resume', req.resume] : []),
      ...(req.images ?? []).flatMap(image => ['-i', image]),
      ...(req.model ? ['--model', req.model] : []), ...(req.effort ? ['--effort', req.effort] : [])],
    stdin: req.prompt,
  }),
  parse: (raw) => {
    const m = /^SESSION:([^ ]+?)[\\r\\n]+(USAGE:[^ ]+?[\\r\\n]+)?/.exec(raw.stdout);
    return { text: (m ? raw.stdout.slice(m[0].length) : raw.stdout).trim(), sessionId: m?.[1] };
  },
  meter: () => (line) => {
    if (!line.startsWith('USAGE:')) return undefined;
    const [input, cachedInput, output] = line.slice(6).split('/').map(Number);
    return { input, cachedInput, output, sessionTotal: true };
  },
};
`,
    );
  }

  /**
   * 逐行输出、能认出活动的假 AI：输出里 `RUN:<命令>` 的行算执行命令，`EDIT:<路径>` 的行算改文件，其余非空行算说话。
   * 用来测试干活监控。resumable 时同时支持续接会话：第一行是 `SESSION:<会话号>`，续接时带 --resume <会话号>。
   */
  writeActivityPlugin(name: string, resumable = false): void {
    const common = [FAKE_AGENT, '--name', name, '--scenario', this.scenarioFile, ...(resumable ? ['--emit-session'] : [])];
    fs.writeFileSync(
      path.join(this.home, 'plugins', `${name}.mjs`),
      `const common = ${JSON.stringify(common)};
export default {
  apiVersion: 1,
  id: ${JSON.stringify(name)},
  displayName: ${JSON.stringify(`假 AI ${name}`)},
  defaultCommand: ${JSON.stringify(process.execPath)},
  versionArgs: ${JSON.stringify([FAKE_AGENT, '--name', name, '--version'])},
  streams: true,
  resumes: ${resumable},
  build: (req) => ({ args: [...common, '--access', req.access, ...(req.resume ? ['--resume', req.resume] : [])], stdin: req.prompt }),
  parse: (raw) => {
    const lines = raw.stdout.split('\\n');
    const session = lines.find((l) => l.startsWith('SESSION:'))?.slice(8).trim();
    const text = lines.filter((l) => !/^(RUN|EDIT|SESSION|USAGE):/.test(l)).join('\\n').trim();
    return { text, ...(session && { sessionId: session }) };
  },
  meter: () => (line) => {
    if (!line.startsWith('USAGE:')) return undefined;
    const [input, cachedInput, output] = line.slice(6).split('/').map(Number);
    return { input, cachedInput, output, sessionTotal: true };
  },
  progress: (line) => {
    if (/^(SESSION|USAGE):/.test(line)) return [];
    if (line.startsWith('RUN:')) return [{ kind: 'run', target: line.slice(4) }];
    if (line.startsWith('EDIT:')) return [{ kind: 'edit', target: line.slice(5) }];
    return line.trim() ? [{ kind: 'say', text: line.trim() }] : [];
  },
};
`,
    );
  }

  writeRoles(yaml: string): void {
    fs.writeFileSync(path.join(this.project, '.dario', 'roles.yaml'), yaml);
  }

  /** 设置剧本并清空调用计数与记录。 */
  setScenario(scenario: Record<string, FakeResponse[]>): void {
    fs.writeFileSync(this.scenarioFile, JSON.stringify(scenario));
    for (const suffix of ['.count.json', '.log.jsonl', '.child.pid', '.commands.log']) fs.rmSync(this.scenarioFile + suffix, { force: true });
  }

  calls(): FakeCall[] {
    try {
      return fs
        .readFileSync(`${this.scenarioFile}.log.jsonl`, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeCall);
    } catch {
      return [];
    }
  }

  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, DARIO_HOME: this.home, ...this.extraEnv };
    delete env.DARIO_DEPTH;
    delete env.DARIO_ALLOW_NESTED;
    for (const [k, v] of Object.entries(this.extraEnv)) if (v === '') delete env[k];
    return env;
  }

  async cli(
    args: string[],
    opts: { stdin?: string; cwd?: string; env?: Record<string, string>; interruptWhen?: () => boolean } = {},
  ): Promise<CliResult> {
    const out: string[] = [];
    const err: string[] = [];
    let onInterrupt: (() => void) | undefined;
    // 模拟用户按 Ctrl+C：条件满足时触发一次已登记的中断处理
    const timer = opts.interruptWhen
      ? setInterval(() => {
          if (onInterrupt && opts.interruptWhen!()) {
            const fire = onInterrupt;
            onInterrupt = undefined;
            fire();
          }
        }, 50)
      : undefined;
    const code = await runCli(args, {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      env: { ...this.env(), ...(opts.env ?? {}) },
      cwd: opts.cwd ?? this.project,
      isTTY: false,
      readStdin: async () => opts.stdin ?? '',
      onInterrupt: (handler) => {
        onInterrupt = handler;
        return () => {
          onInterrupt = undefined;
        };
      },
    }).finally(() => {
      if (timer) clearInterval(timer);
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  /** 运行任务并解析 JSON 输出。 */
  async runJson(args: string[], opts: { stdin?: string } = {}): Promise<{ code: number; json: any; err: string }> {
    const r = await this.cli([...args, '--output-format', 'json'], opts);
    let json: any;
    try {
      json = JSON.parse(r.out);
    } catch {
      throw new Error(`输出不是 JSON（退出码 ${r.code}）：\n${r.out}\n${r.err}`);
    }
    return { code: r.code, json, err: r.err };
  }

  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export function plan(steps: Array<{ role: string; task: string; writes?: boolean; files?: string[]; refs?: string[]; git?: boolean }>, summary = '测试计划'): string {
  return `思路略。\n\n\`\`\`json\n${JSON.stringify({ summary, answer: null, steps: steps.map((s) => ({ writes: false, ...s })) })}\n\`\`\``;
}

export function verdict(pass: boolean, issues: string[] = []): string {
  return `审查意见略。\n\n\`\`\`json\n${JSON.stringify({ verdict: pass ? 'pass' : 'fail', issues })}\n\`\`\``;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

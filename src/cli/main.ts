#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, serve } from '../compose.js';
import { resolveHome } from '../core/config.js';
import {
  DEFAULT_ACCESS_YAML,
  DEFAULT_AGENTS_YAML,
  DEFAULT_CHANNELS_YAML,
  DEFAULT_DISPATCH_RULES,
  DEFAULT_PROJECT_YAML,
  DEFAULT_ROLES_YAML,
} from '../core/defaults.js';
import { describePlan } from '../core/orchestrator.js';
import { formatJob, formatRoles, formatSteps, jobToJson } from '../core/report.js';
import { exitCodeForJob, STATUS_LABEL } from '../core/types.js';
import { ConfigError, DarioError, ellipsis, formatLocalTime } from '../core/util.js';
import { runRepl } from './repl.js';

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** 标准输入是否连着终端。 */
  isTTY: boolean;
  readStdin: () => Promise<string>;
  /** 在终端上提问（交互方式确认计划用）。 */
  ask?: (question: string) => Promise<string>;
  /** 登记"用户按了 Ctrl+C"时的处理，返回取消登记的函数。 */
  onInterrupt?: (handler: () => void) => () => void;
}

const VERSION = '0.1.0';

const USAGE = `Dario ${VERSION} — 按角色调用各家 AI 编码工具

用法：
  dario "任务描述"                 交给主控安排
  dario --to <角色> "任务描述"     直接交给指定角色
  dario                            进入交互
  dario -p ["任务描述"]            无头：执行完打印结果并退出；不带描述时从标准输入读取

  dario roles                      查看角色表
  dario role <角色> <AI> [--save]  临时指定担当者；--save 同时写回项目角色表
  dario role <角色> --reset        取消临时指定
  dario agents                     列出各家 AI
  dario health [AI]                实际调用一次，确认可用（会消耗额度）
  dario jobs                       最近的任务
  dario job <任务号>               任务详情
  dario approve <任务号>           批准等待确认的计划
  dario cancel <任务号>            取消任务
  dario init                       在当前目录生成 .dario/ 配置
  dario check                      校验配置，确认各家命令存在
  dario serve                      常驻运行，启动已启用的渠道

选项：
  --to <角色>              指定角色（角色 id 或别名）
  -p, --print              无头方式
  --output-format <格式>   text（默认）或 json
  -y, --yes                含改文件步骤的计划免确认
  --project <目录>         指定项目根目录
  -h, --help               显示本帮助
  -v, --version            显示版本

退出码：0 完成 · 1 任务失败 · 2 用法或配置错误 · 3 没有可用的 AI · 4 计划等待确认 · 5 取消或超时`;

const SUBCOMMANDS = new Set(['roles', 'role', 'agents', 'health', 'jobs', 'job', 'approve', 'cancel', 'init', 'check', 'serve', 'help']);

interface Parsed {
  positionals: string[];
  to?: string;
  print: boolean;
  format: 'text' | 'json';
  yes: boolean;
  save: boolean;
  reset: boolean;
  project?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { positionals: [], print: false, format: 'text', yes: false, save: false, reset: false, help: false, version: false };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new ConfigError(`${flag} 后面缺少取值。`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      p.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--to') p.to = need(++i, '--to');
    else if (a.startsWith('--to=')) p.to = a.slice(5);
    else if (a === '-p' || a === '--print') p.print = true;
    else if (a === '--output-format') {
      const v = need(++i, '--output-format');
      if (v !== 'text' && v !== 'json') throw new ConfigError('--output-format 只能是 text 或 json。');
      p.format = v;
    } else if (a === '-y' || a === '--yes') p.yes = true;
    else if (a === '--save') p.save = true;
    else if (a === '--reset') p.reset = true;
    else if (a === '--project') p.project = need(++i, '--project');
    else if (a === '-h' || a === '--help') p.help = true;
    else if (a === '-v' || a === '--version') p.version = true;
    else if (a.startsWith('-') && a.length > 1) throw new ConfigError(`不认识的选项：${a}。运行 dario --help 查看用法。`);
    else p.positionals.push(a);
  }
  return p;
}

function writeIfAbsent(file: string, content: string, report: string[]): void {
  if (fs.existsSync(file)) {
    report.push(`已存在，未改动：${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  report.push(`已生成：${file}`);
}

async function cmdInit(io: CliIO, p: Parsed): Promise<number> {
  const home = resolveHome(io.env);
  const root = path.resolve(io.cwd, p.project ?? '.');
  const report: string[] = [];
  writeIfAbsent(path.join(root, '.dario', 'roles.yaml'), DEFAULT_ROLES_YAML, report);
  writeIfAbsent(path.join(root, '.dario', 'project.yaml'), DEFAULT_PROJECT_YAML, report);
  writeIfAbsent(path.join(root, '.dario', 'dispatch-rules.md'), DEFAULT_DISPATCH_RULES, report);
  writeIfAbsent(path.join(home, 'agents.yaml'), DEFAULT_AGENTS_YAML, report);
  writeIfAbsent(path.join(home, 'channels.yaml'), DEFAULT_CHANNELS_YAML, report);
  writeIfAbsent(path.join(home, 'access.yaml'), DEFAULT_ACCESS_YAML, report);
  io.stdout(report.join('\n'));
  io.stdout(`\n项目级配置在 ${path.join(root, '.dario')}（随仓库提交），本机配置在 ${home}（不要提交）。`);
  return 0;
}

async function cmdCheck(io: CliIO, p: Parsed): Promise<number> {
  const app = await createApp({ cwd: io.cwd, env: io.env, projectRoot: p.project });
  const { engine, project, user, home } = app;
  const problems: string[] = [];
  io.stdout(`本机配置：${home}`);
  io.stdout(`项目根目录：${project.root}${project.hasProjectDir ? '' : '（没有 .dario/，使用内置或本机默认角色表）'}`);
  io.stdout(`已加载插件：${app.plugins.map((x) => x.id).join('、')}`);

  io.stdout('\nAI：');
  const agents = await engine.agentsView();
  for (const a of agents) {
    const st = !a.enabled ? '已停用' : !a.installed ? '未安装' : '已安装';
    io.stdout(`  ${a.id}（插件 ${a.plugin}${a.model ? `，模型 ${a.model}` : ''}）：${st}${a.version ? ` · ${a.version}` : ''}${a.path ? ` · ${a.path}` : ''}`);
  }

  const known = new Set(agents.map((a) => a.id));
  const views = await engine.rolesView();
  for (const v of views) {
    for (const c of v.candidates) if (!known.has(c.agent)) problems.push(`角色 ${v.id} 的候选 ${c.agent} 在本机没有配置`);
    if (!v.holder) problems.push(`角色 ${v.id} 目前没有可用的 AI`);
  }
  const s = project.settings;
  if (!engine.roles.has(s.leadRole)) problems.push(`项目设置的主控角色 ${s.leadRole} 不在角色表中`);
  if (!engine.roles.has(s.reviewRole)) problems.push(`项目设置的审查角色 ${s.reviewRole} 不在角色表中（改了文件的任务将不会自动审查）`);
  io.stdout(`\n角色表：\n${formatRoles(views, engine.roles.fallback)}`);

  const feishu = user.channels.feishu;
  if (feishu?.enabled) {
    io.stdout('\n飞书渠道：已启用');
    if (!io.env[feishu.appIdEnv] || !io.env[feishu.appSecretEnv]) problems.push(`没有设置环境变量 ${feishu.appIdEnv} / ${feishu.appSecretEnv}`);
    if (!feishu.project) problems.push('channels.yaml 的 feishu.project 没有填写');
    else if (!fs.existsSync(feishu.project)) problems.push(`飞书渠道的隔离克隆不存在：${feishu.project}`);
    if (feishu.conversations.length === 0) problems.push('飞书渠道没有配置允许的会话（conversations）');
    const acc = user.access.feishu;
    if (!acc || acc.members.length + acc.admins.length === 0) problems.push('access.yaml 里飞书的成员与管理员名单是空的');
  } else {
    io.stdout('\n飞书渠道：未启用');
  }

  if (problems.length) {
    io.stdout(`\n需要注意（${problems.length}）：\n${problems.map((x) => `  - ${x}`).join('\n')}`);
    return 1;
  }
  io.stdout('\n配置没有问题。');
  return 0;
}

async function cmdServe(io: CliIO): Promise<number> {
  const handle = await serve({ env: io.env, log: (line) => io.stderr(line) });
  io.stderr('按 Ctrl+C 停止。');
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await handle.stop();
  return 0;
}

async function runTask(io: CliIO, p: Parsed): Promise<number> {
  const depth = Number(io.env.DARIO_DEPTH ?? '0') || 0;
  if (depth >= 1 && io.env.DARIO_ALLOW_NESTED !== '1') {
    io.stderr('当前进程是被 Dario 启动的 AI，为避免循环调用，这里不能再用 dario 下达任务。');
    return 2;
  }
  const interactive = io.isTTY && !p.print;
  let task = p.positionals.join(' ').trim();
  if (!task && !interactive) task = (await io.readStdin()).trim();

  const app = await createApp({ cwd: io.cwd, env: io.env, projectRoot: p.project });
  const { engine } = app;
  if (!task) {
    if (!interactive) throw new ConfigError('没有任务描述。用法：dario "任务描述"，或通过标准输入传入。');
    return runRepl(engine, io.stdout);
  }

  engine.onProgress((e) => io.stderr(e.kind === 'plan' ? `[${e.jobId}] 计划：\n${e.text}` : `[${e.jobId}] ${e.text}`));
  const ask = io.ask;
  const created = engine.create({ task, role: p.to, origin: { channel: 'terminal', senderId: os.userInfo().username } });
  const stopWatching = io.onInterrupt?.(() => {
    io.stderr(`
[${created.id}] 收到中断，正在终止…`);
    try {
      engine.cancel(created.id);
    } catch {
      // 任务已经结束
    }
  });
  let job;
  try {
    job = await engine.advance(created, {
      autoApprove: p.yes,
      confirm:
        interactive && ask
          ? async () => {
              const answer = (await ask('这份计划会改动文件，执行吗？(y/N) ')).trim().toLowerCase();
              return answer === 'y' || answer === 'yes' || answer === '确认';
            }
          : undefined,
    });
  } finally {
    stopWatching?.();
  }

  if (p.format === 'json') {
    io.stdout(JSON.stringify(jobToJson(job), null, 2));
  } else if (job.status === 'awaiting_approval') {
    io.stdout(job.plan ? describePlan(job.plan, engine.roles) : '');
    io.stderr(`\n[${job.id}] 这份计划会改动文件，尚未执行。运行 dario approve ${job.id} 开始执行，或加 --yes 免确认。`);
  } else {
    // 结论走标准输出，方便管道使用；其余信息走标准错误
    io.stdout(job.result?.conclusion?.trim() ?? '');
    const r = job.result;
    const notes: string[] = [`\n[${job.id}] ${STATUS_LABEL[job.status]}`];
    if (r?.changedFiles.length) notes.push(`改动的文件（${r.changedFiles.length}）：${r.changedFiles.join('、')}`);
    if (r?.branch) notes.push(`产出所在分支：${r.branch}`);
    if (job.steps.length) notes.push(`各步：\n${formatSteps(job)}`);
    if (r?.warnings.length) notes.push(`注意：\n${r.warnings.map((w) => `  - ${w}`).join('\n')}`);
    io.stderr(notes.join('\n'));
  }
  return exitCodeForJob(job);
}

async function dispatch(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv);
  if (p.version) {
    io.stdout(VERSION);
    return 0;
  }
  const first = p.positionals[0];
  const sub = first && SUBCOMMANDS.has(first) && !p.to && !p.print ? first : undefined;
  if (p.help || sub === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  if (!sub) return runTask(io, p);

  const args = p.positionals.slice(1);
  if (sub === 'init') return cmdInit(io, p);
  if (sub === 'check') return cmdCheck(io, p);
  if (sub === 'serve') return cmdServe(io);

  const { engine } = await createApp({ cwd: io.cwd, env: io.env, projectRoot: p.project });
  switch (sub) {
    case 'roles':
      io.stdout(formatRoles(await engine.rolesView(), engine.roles.fallback));
      return 0;
    case 'role': {
      const [role, agent] = args;
      if (!role) throw new ConfigError('用法：dario role <角色> <AI> [--save]，或 dario role <角色> --reset');
      if (p.reset || agent === 'reset') {
        io.stdout(engine.resetRole(role));
        return 0;
      }
      if (!agent) throw new ConfigError('用法：dario role <角色> <AI> [--save]，或 dario role <角色> --reset');
      io.stdout(engine.setRole(role, agent, p.save));
      return 0;
    }
    case 'agents': {
      for (const a of await engine.agentsView()) {
        const st = !a.enabled ? '已停用' : !a.installed ? '未安装' : a.unavailable ? `暂时不可用（${a.unavailable}）` : '可用';
        io.stdout(`${a.id}（插件 ${a.plugin}${a.model ? `，模型 ${a.model}` : ''}）：${st}${a.version ? ` · ${a.version}` : ''}`);
      }
      return 0;
    }
    case 'health': {
      io.stderr('正在检查，会实际调用一次 AI…');
      const results = await engine.health(args[0]);
      for (const r of results) io.stdout(`${r.agent}：${r.ok ? '可用' : '不可用'} — ${r.detail}`);
      return results.every((r) => r.ok) ? 0 : 3;
    }
    case 'jobs': {
      const jobs = engine.jobs(20);
      if (jobs.length === 0) io.stdout('还没有任务。');
      for (const j of jobs) {
        io.stdout(`${j.id}  ${STATUS_LABEL[j.status].padEnd(4, '　')}  ${formatLocalTime(j.createdAt)}  ${ellipsis(j.task, 50)}`);
      }
      return 0;
    }
    case 'job': {
      if (!args[0]) throw new ConfigError('用法：dario job <任务号>');
      const job = engine.job(args[0]);
      if (p.format === 'json') io.stdout(JSON.stringify(jobToJson(job), null, 2));
      else {
        io.stdout(`任务：${job.task}`);
        if (job.plan) io.stdout(`计划：\n${describePlan(job.plan, engine.roles)}`);
        io.stdout(formatJob(job));
      }
      return 0;
    }
    case 'approve': {
      if (!args[0]) throw new ConfigError('用法：dario approve <任务号>');
      const pending = engine.requireJob(args[0]);
      if (pending.strategy === 'isolated') throw new ConfigError(`任务 ${pending.id} 来自远程渠道，请在那个渠道里确认。`);
      const depth = Number(io.env.DARIO_DEPTH ?? '0') || 0;
      if (depth >= 1 && io.env.DARIO_ALLOW_NESTED !== '1') {
        io.stderr('当前进程是被 Dario 启动的 AI，不能批准计划。');
        return 2;
      }
      // 任务属于哪个项目，就在哪个项目的配置下继续
      const target = await createApp({ cwd: pending.projectRoot, env: io.env, projectRoot: pending.projectRoot });
      target.engine.onProgress((e) => io.stderr(`[${e.jobId}] ${e.text}`));
      const stopWatching = io.onInterrupt?.(() => {
        io.stderr(`
[${pending.id}] 收到中断，正在终止…`);
        try {
          target.engine.cancel(pending.id);
        } catch {
          // 任务已经结束
        }
      });
      let job;
      try {
        job = await target.engine.approve(pending.id);
      } finally {
        stopWatching?.();
      }
      if (p.format === 'json') io.stdout(JSON.stringify(jobToJson(job), null, 2));
      else io.stdout(formatJob(job));
      return exitCodeForJob(job);
    }
    case 'cancel': {
      if (!args[0]) throw new ConfigError('用法：dario cancel <任务号>');
      const job = engine.cancel(args[0]);
      io.stdout(job.status === 'cancelled' ? `[${job.id}] 已取消。` : `[${job.id}] 正在终止。`);
      return 0;
    }
    default:
      throw new ConfigError(`不认识的子命令：${sub}`);
  }
}

/** 命令行入口。返回退出码，不直接结束进程，便于测试。 */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (e) {
    if (e instanceof DarioError) {
      io.stderr(e.message);
      return e.exitCode;
    }
    io.stderr(`出错：${(e as Error).stack ?? String(e)}`);
    return 1;
  }
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const io: CliIO = {
    stdout: (t) => process.stdout.write(`${t}\n`),
    stderr: (t) => process.stderr.write(`${t}\n`),
    env: process.env,
    cwd: process.cwd(),
    isTTY: process.stdin.isTTY === true,
    readStdin: () => readAll(process.stdin),
    onInterrupt: (handler) => {
      const onSignal = (): void => handler();
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      return () => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      };
    },
    ask: async (question) => {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
  runCli(process.argv.slice(2), io).then(
    (code) => {
      // 只设置退出码，让输出自然写完后再结束，避免管道里的内容被截断
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${String(e)}\n`);
      process.exit(1);
    },
  );
}

import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/main.js';
import { createApp } from '../src/compose.js';
import type { Job, ProgressEvent } from '../src/core/types.js';
import { runLive } from '../src/ui/run.js';
import { isAlive, plan, Sandbox, verdict, type SandboxOptions } from './helpers.js';

/**
 * 动态界面的端到端测试：真实的引擎与假 AI（要启动子进程），界面画到一对假的终端流上。
 */

interface FakeTerminal {
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WriteStream;
  /** 写到"终端"的全部内容，已去掉控制字符。 */
  screen(): string;
  press(keys: string): void;
}

function terminal(inputIsTTY = true): FakeTerminal {
  const chunks: string[] = [];
  const stderr = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }),
    { isTTY: true, columns: 100, rows: 30 },
  );
  const input = new PassThrough();
  const stdin = Object.assign(input, { isTTY: inputIsTTY, setRawMode: () => input, ref: () => input, unref: () => input });
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    screen: () => stripVTControlCharacters(chunks.join('')),
    press: (keys) => void input.write(keys),
  };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

const boxes: Sandbox[] = [];
function sandbox(options?: SandboxOptions): Sandbox {
  const box = new Sandbox(options);
  boxes.push(box);
  return box;
}
afterEach(() => {
  for (const box of boxes.splice(0)) box.cleanup();
});

const origin = { channel: 'terminal', senderId: 'tester' };

async function start(box: Sandbox, term: FakeTerminal, request: { task: string; role?: string }, autoApprove = false) {
  const { engine } = await createApp({ cwd: box.project, env: box.env() });
  const job = engine.create({ ...request, origin });
  const plain: ProgressEvent[] = [];
  const notices: string[] = [];
  const done = runLive({
    engine,
    job,
    resume: false,
    autoApprove,
    env: { NO_COLOR: '1' },
    stdin: term.stdin,
    stderr: term.stderr,
    printPlain: (e) => plain.push(e),
    notice: (line) => notices.push(line),
  });
  return { engine, job, done, plain, notices };
}

describe('动态界面：主控流程', () => {
  const scenario = {
    a1: [{ text: plan([{ role: 'coder', task: '新建 src/x.txt\n第二行说明', writes: true }]) }, { text: '汇总：已新建文件' }],
    a2: [{ text: '已新建', files: [{ path: 'src/x.txt', content: 'x' }] }],
    a3: [{ text: verdict(true) }],
  };

  it('显示计划并等待按键，按 y 后逐步执行到完成', async () => {
    const box = sandbox({ git: true });
    box.setScenario(scenario);
    const term = terminal();
    const run = await start(box, term, { task: '新建一个文件' });

    await waitFor(() => term.screen().includes('执行吗？'), '出现计划确认');
    expect(term.screen()).toContain('这份计划会改动文件：');
    expect(term.screen()).toContain('1. 实现  改文件  新建 src/x.txt');
    expect(term.screen()).not.toContain('第二行说明');
    // 确认之前没有执行任何改动
    expect(fs.existsSync(path.join(box.project, 'src', 'x.txt'))).toBe(false);
    expect(box.calls().map((c) => c.name)).toEqual(['a1']);

    term.press('y');
    const job = await run.done;
    expect(job.status).toBe('done');
    expect(job.result?.conclusion).toBe('汇总：已新建文件');
    expect(job.result?.changedFiles).toEqual(['src/x.txt']);

    const screen = term.screen();
    expect(screen).toContain(`${job.id} · 主控安排 · 新建一个文件`);
    // 四个步骤各有一条定稿行：符号、阶段、角色、AI
    for (const row of ['+ 计划   主控 · a1', '+ 执行   实现 · a2', '+ 审查   审查 · a3', '+ 汇总   主控 · a1']) {
      expect(screen, row).toContain(row);
    }
    // 定稿行只打印一次，不随刷新重复
    expect(screen.split('+ 执行   实现 · a2').length - 1).toBe(1);
    expect(run.notices).toEqual([]);
    expect(run.plain).toEqual([]);
  });

  it('按 d 查看完整任务说明，按 n 取消，之后不执行', async () => {
    const box = sandbox({ git: true });
    box.setScenario(scenario);
    const term = terminal();
    const run = await start(box, term, { task: '新建一个文件' });
    await waitFor(() => term.screen().includes('执行吗？'), '出现计划确认');
    term.press('d');
    await waitFor(() => term.screen().includes('第二行说明'), '显示完整任务说明');
    term.press('n');
    const job = await run.done;
    expect(job.status).toBe('cancelled');
    expect(box.calls().map((c) => c.name)).toEqual(['a1']);
    expect(fs.existsSync(path.join(box.project, 'src', 'x.txt'))).toBe(false);
  });

  it('免确认时不出现确认界面', async () => {
    const box = sandbox({ git: true });
    box.setScenario(scenario);
    const term = terminal();
    const run = await start(box, term, { task: '新建一个文件' }, true);
    const job = await run.done;
    expect(job.status).toBe('done');
    expect(term.screen()).not.toContain('执行吗？');
  });

  it('标准输入不是终端时不询问，任务停在等待确认', async () => {
    const box = sandbox({ git: true });
    box.setScenario(scenario);
    const term = terminal(false);
    const run = await start(box, term, { task: '新建一个文件' });
    const job = await run.done;
    expect(job.status).toBe('awaiting_approval');
    expect(term.screen()).not.toContain('执行吗？');
    expect(box.calls().map((c) => c.name)).toEqual(['a1']);
  });
});

describe('动态界面：换人、活动与中断', () => {
  it('第一家不可用时显示换人提示，由下一家完成', async () => {
    const box = sandbox();
    box.setScenario({ a2: [{ exit: 1, stderr: 'Error: 401 Unauthorized, please login' }], a3: [{ text: 'a3 完成' }] });
    const term = terminal();
    const run = await start(box, term, { task: '写点东西', role: 'coder' });
    const job = await run.done;
    expect(job.status).toBe('done');
    const screen = term.screen();
    expect(screen).toContain(`${job.id} · 交给 实现 · 写点东西`);
    expect(screen).toMatch(/! a2 不可用（.*401.*），改用 a3/);
    expect(screen).toContain('+ 执行   实现 · a3');
    expect(screen).not.toContain('+ 执行   实现 · a2');
  });

  it('运行中的步骤下方实时显示活动，带四个空格缩进', async () => {
    const box = sandbox({ progressLines: true });
    box.setScenario({ a2: [{ stream: [{ line: '正在读取配置', delayMs: 200 }, { line: '正在改写文件', delayMs: 400 }], delayMs: 0, text: '好了' }] });
    const term = terminal();
    const run = await start(box, term, { task: '改文件', role: 'coder' });
    // 活动必须在任务结束之前就出现在屏幕上
    let seenWhileRunning = false;
    void run.done.then(() => undefined);
    await waitFor(() => term.screen().includes('    正在读取配置'), '第一条活动出现');
    seenWhileRunning = run.engine.job(run.job.id).status !== 'done';
    const job = await run.done;
    expect(seenWhileRunning).toBe(true);
    expect(job.status).toBe('done');
    expect(term.screen()).toContain('    正在改写文件');
    expect(term.screen()).toMatch(/[-\\|/] 执行 {3}实现 · a2 {3}00:0\d/);
  });

  it('任务失败时定稿行标出未完成', async () => {
    const box = sandbox();
    box.setScenario({ a2: [{ exit: 1, stderr: 'TypeError: boom' }] });
    const term = terminal();
    const run = await start(box, term, { task: '任务', role: 'coder' });
    const job = await run.done;
    expect(job.status).toBe('failed');
    expect(term.screen()).toMatch(/x 执行 {3}实现 · a2 .*未完成/);
  });

  it('按 Ctrl+C 取消任务并终止 AI 进程树', async () => {
    const box = sandbox();
    box.setScenario({ a2: [{ hang: true, spawnChild: true }] });
    const term = terminal();
    const run = await start(box, term, { task: '跑不完的任务', role: 'coder' });
    const pidFile = `${box.scenarioFile}.child.pid`;
    await waitFor(() => fs.existsSync(pidFile), '假 AI 启动子进程');
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(isAlive(childPid)).toBe(true);

    term.press('\u0003');
    const job = await run.done;
    expect(job.status).toBe('cancelled');
    expect(term.screen()).toContain('正在终止');
    await new Promise((r) => setTimeout(r, 500));
    expect(isAlive(childPid)).toBe(false);
  });
});

describe('命令行接入动态方式', () => {
  async function cli(box: Sandbox, term: FakeTerminal, args: string[], env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      // 符号按是否在 Windows Terminal 里分两套，测试里固定用基础符号
      env: { ...box.env(), NO_COLOR: '1', WT_SESSION: '', ...env },
      cwd: box.project,
      isTTY: true,
      readStdin: async () => '',
      stderrIsTTY: true,
      columns: 100,
      streams: { stdin: term.stdin, stderr: term.stderr },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('结论单独写到标准输出，收尾信息不再重复列出各步', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a2: [{ text: '结论在这里', files: [{ path: 'src/a.txt', content: '1' }] }] });
    const term = terminal();
    const r = await cli(box, term, ['--to', 'coder', '写一个文件']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('结论在这里');
    expect(r.err).toContain('[J0001] 完成');
    expect(r.err).toContain('改动的文件（1）：src/a.txt');
    expect(r.err).not.toContain('各步：');
    // 步骤行在界面上，不在逐行输出里
    expect(term.screen()).toContain('+ 执行   实现 · a2');
    expect(r.err).not.toContain('交给 a2');
  });

  it('--plain 与 DARIO_PLAIN 强制纯文本，界面流上没有任何输出', async () => {
    for (const [args, env] of [[['--plain'], {}], [[], { DARIO_PLAIN: '1' }]] as Array<[string[], Record<string, string>]>) {
      const box = sandbox();
      box.setScenario({ a2: [{ text: 'ok' }] });
      const term = terminal();
      const r = await cli(box, term, ['--to', 'coder', '任务', ...args], env);
      expect(r.code).toBe(0);
      expect(term.screen()).toBe('');
      expect(r.err).toContain('执行（实现（coder））：交给 a2');
      expect(r.err).toContain('各步：');
    }
  });

  it('终端过窄或输出 JSON 时使用纯文本', async () => {
    const box = sandbox();
    box.setScenario({ a2: [{ text: 'ok' }] });
    const term = terminal();
    const out: string[] = [];
    const code = await runCli(['--to', 'coder', '任务', '--output-format', 'json'], {
      stdout: (t) => out.push(t),
      stderr: () => {},
      env: box.env(),
      cwd: box.project,
      isTTY: true,
      readStdin: async () => '',
      stderrIsTTY: true,
      columns: 100,
      streams: { stdin: term.stdin, stderr: term.stderr },
    });
    expect(code).toBe(0);
    expect((JSON.parse(out.join('\n')) as { status: string }).status).toBe('done');
    expect(term.screen()).toBe('');

    box.setScenario({ a2: [{ text: 'ok' }] });
    const narrow = terminal();
    const narrowCode = await runCli(['--to', 'coder', '任务'], {
      stdout: () => {},
      stderr: () => {},
      env: box.env(),
      cwd: box.project,
      isTTY: true,
      readStdin: async () => '',
      stderrIsTTY: true,
      columns: 30,
      streams: { stdin: narrow.stdin, stderr: narrow.stderr },
    });
    expect(narrowCode).toBe(0);
    expect(narrow.screen()).toBe('');
  });

  it('含改文件的计划在界面里确认后执行，退出码为 0', async () => {
    const box = sandbox({ git: true });
    box.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '新建文件', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: 'ok', files: [{ path: 'y.txt', content: 'y' }] }],
      a3: [{ text: verdict(true) }],
    });
    const term = terminal();
    const pending = cli(box, term, ['新建一个文件']);
    await waitFor(() => term.screen().includes('执行吗？'), '出现计划确认');
    term.press('y');
    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.out).toBe('汇总');
    expect(fs.readFileSync(path.join(box.project, 'y.txt'), 'utf8')).toBe('y');
  });
});

/** 类型占位：确保任务记录的类型在本文件里被引用到。 */
export type { Job };

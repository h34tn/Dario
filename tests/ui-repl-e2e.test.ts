import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/main.js';
import { createApp } from '../src/compose.js';
import { runReplUi } from '../src/ui/repl.js';
import { plan, Sandbox, verdict, type SandboxOptions } from './helpers.js';

/**
 * 完整交互界面的端到端测试：真实的引擎与假 AI（要启动子进程），界面画到一对假的终端流上，
 * 按键通过假的标准输入送进去。
 */

interface FakeTerminal {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** 写到"终端"的全部内容，已去掉控制字符。 */
  screen(): string;
  /** 输入一行并回车。 */
  line(text: string): Promise<void>;
  press(keys: string): void;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function terminal(): FakeTerminal {
  const chunks: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }),
    { isTTY: true, columns: 100, rows: 30 },
  );
  const input = new PassThrough();
  const stdin = Object.assign(input, { isTTY: true, setRawMode: () => input, ref: () => input, unref: () => input });
  const press = (keys: string) => void input.write(keys);
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    screen: () => stripVTControlCharacters(chunks.join('')),
    press,
    // 文字与回车分两次送，和真实键盘一样是两个按键事件
    line: async (text) => {
      press(text);
      await pause(40);
      press('\r');
      await pause(40);
    },
  };
}

async function waitFor(check: () => boolean, what: string, screen?: () => string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}${screen ? `\n--- 屏幕内容 ---\n${screen().slice(-1500)}` : ''}`);
    await pause(30);
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

async function open(box: Sandbox) {
  const term = terminal();
  const { engine } = await createApp({ cwd: box.project, env: box.env() });
  const plain: string[] = [];
  const done = runReplUi({ engine, stdin: term.stdin, stdout: term.stdout, env: { NO_COLOR: '1' }, printLine: (l) => plain.push(l) });
  const see = (text: string) => waitFor(() => term.screen().includes(text), `屏幕上出现"${text}"`, term.screen);
  await see('/help 查看全部');
  return { term, engine, done, plain, see };
}

describe('完整交互界面：下达任务', () => {
  it('开场显示项目与各角色担当者；直接交给角色的任务执行完后显示结果卡片', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a2: [{ text: '## 结论\n\n已写好 **文件**。', files: [{ path: 'src/x.txt', content: 'x' }] }] });
    const ui = await open(box);
    expect(ui.term.screen()).toContain('Dario · project');
    await ui.see('project · 主控 a1 · 实现 a2 · 审查 a3');

    await ui.term.line('/to 实现 写一个文件');
    await ui.see('> /to 实现 写一个文件');
    await ui.see('J0001 · 交给 实现 · 写一个文件');
    await ui.see('[J0001] 完成');
    const screen = ui.term.screen();
    // 结论做了轻量排版：标记符号被去掉
    expect(screen).toContain('已写好 文件。');
    expect(screen).not.toContain('## 结论');
    expect(screen).not.toContain('**文件**');
    expect(screen).toContain('改动的文件（1）：');
    expect(screen).toContain('  src/x.txt');
    expect(screen).toMatch(/\+ 执行 {3}实现 · a2 {3}\d+/);
    expect(fs.readFileSync(path.join(box.project, 'src', 'x.txt'), 'utf8')).toBe('x');
    // 状态栏带上了会话上文来自哪个任务
    await ui.see('上文 J0001');

    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
    expect(ui.plain).toEqual([]);
  });

  it('主控流程：显示计划并等待按键，确认之前不改文件，按 y 后执行到完成', async () => {
    const box = sandbox({ git: true });
    box.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '新建 src/x.txt', writes: true }]) }, { text: '汇总：已新建文件' }],
      a2: [{ text: '已新建', files: [{ path: 'src/x.txt', content: 'x' }] }],
      a3: [{ text: verdict(true) }],
    });
    const ui = await open(box);
    await ui.term.line('新建一个文件');
    await ui.see('J0001 · 主控安排 · 新建一个文件');
    await ui.see('执行吗？');
    expect(ui.term.screen()).toContain('1. 实现  改文件  新建 src/x.txt');
    expect(fs.existsSync(path.join(box.project, 'src', 'x.txt'))).toBe(false);

    // 等待确认时输入框不接收文字：这些字不会被当成新任务
    ui.term.press('y');
    await ui.see('[J0001] 完成');
    expect(ui.term.screen()).toContain('汇总：已新建文件');
    expect(box.calls().map((c) => c.name)).toEqual(['a1', 'a2', 'a3', 'a1']);
    expect(fs.existsSync(path.join(box.project, 'src', 'x.txt'))).toBe(true);

    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
  });

  it('计划确认时按 n：任务取消，不执行任何改动，界面继续可用', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a1: [{ text: plan([{ role: 'coder', task: '新建 src/x.txt', writes: true }]) }] });
    const ui = await open(box);
    await ui.term.line('新建一个文件');
    await ui.see('执行吗？');
    ui.term.press('n');
    await ui.see('[J0001] 已取消');
    expect(box.calls().map((c) => c.name)).toEqual(['a1']);
    expect(fs.existsSync(path.join(box.project, 'src', 'x.txt'))).toBe(false);

    await ui.term.line('/status');
    await ui.see('J0001 已取消');
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
  });
});

describe('完整交互界面：排队与会话上文', () => {
  it('任务运行时再输入的任务会排队；后一个任务带上前一个的结论，/new 之后不再带', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a2: [{ text: '第一个任务的结论', delayMs: 1200 }, { text: '第二个任务的结论' }, { text: '第三个任务的结论' }] });
    const ui = await open(box);
    await ui.term.line('/to 实现 第一个任务');
    await ui.see('J0001 · 交给 实现 · 第一个任务');
    await ui.term.line('/to 实现 第二个任务');
    await ui.see('已排队，前面还有 1 个任务。');
    await ui.see('排队 1');
    await ui.see('[J0001] 完成');
    await ui.see('J0002 · 交给 实现 · 第二个任务');
    await ui.see('[J0002] 完成');

    const calls = box.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).not.toContain('上一个任务');
    expect(calls[1].prompt).toContain('同一次会话里上一个任务（J0001）的结论：');
    expect(calls[1].prompt).toContain('第一个任务的结论');

    await ui.term.line('/new');
    await ui.see('已清空会话上文');
    await ui.term.line('/to 实现 第三个任务');
    await ui.see('[J0003] 完成');
    expect(box.calls()[2].prompt).not.toContain('上一个任务');

    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
  });

  it('同一角色的后一个任务续接前一个任务的 AI 会话，/new 之后新开', async () => {
    const box = sandbox({ git: true, resumable: true });
    box.setScenario({ a2: [{ text: '第一个任务的结论' }, { text: '第二个任务的结论' }, { text: '第三个任务的结论' }] });
    const ui = await open(box);
    await ui.term.line('/to 实现 第一个任务');
    await ui.see('[J0001] 完成');
    await ui.term.line('/to 实现 第二个任务');
    await ui.see('[J0002] 完成');
    await ui.term.line('/new');
    await ui.see('已清空会话上文');
    await ui.term.line('/to 实现 第三个任务');
    await ui.see('[J0003] 完成');

    const resumes = box.calls().map((c) => (c.argv.includes('--resume') ? c.argv[c.argv.indexOf('--resume') + 1] : '新开'));
    expect(resumes).toEqual(['新开', 'a2-s0', '新开']);
    expect(box.calls()[1].prompt).toContain('这是同一次会话里的新任务');

    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
  });
});

describe('完整交互界面：中断与退出', () => {
  it('按 Esc 中断正在运行的任务，界面继续可用', async () => {
    const box = sandbox({ git: true, streams: true });
    box.setScenario({ a2: [{ hang: true }, { text: '第二次正常完成' }] });
    const ui = await open(box);
    await ui.term.line('/to 实现 一个不会结束的任务');
    await ui.see('执行   实现 · a2');
    await pause(300);
    ui.term.press('\u001B');
    await ui.see('[J0001] 已取消');

    await ui.term.line('/to 实现 再来一个');
    await ui.see('[J0002] 完成');
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
  });

  it('任务运行中连按两次 Ctrl+C：先提示，再取消任务并退出', async () => {
    const box = sandbox({ git: true, streams: true });
    box.setScenario({ a2: [{ hang: true }] });
    const ui = await open(box);
    await ui.term.line('/to 实现 一个不会结束的任务');
    await ui.see('执行   实现 · a2');
    await pause(300);
    ui.term.press('\u0003');
    await ui.see('再按一次 Ctrl+C 退出（正在运行的任务会被取消）');
    ui.term.press('\u0003');
    expect(await ui.done).toBe('exit');
    expect(ui.engine.job('J0001').status).toBe('cancelled');
  });

  it('输入框里有内容时 Ctrl+C 只清空输入，不退出', async () => {
    const box = sandbox({ git: true });
    const ui = await open(box);
    ui.term.press('写到一半的任务');
    await ui.see('> 写到一半的任务');
    ui.term.press('\u0003');
    await pause(150);
    expect(ui.term.screen()).not.toContain('再按一次 Ctrl+C 退出');
    // 清空之后直接回车不会提交任何东西
    ui.term.press('\r');
    await pause(150);
    expect(box.calls()).toEqual([]);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
  });

  it('/plain 返回 plain，交给逐行交互', async () => {
    const box = sandbox({ git: true });
    const ui = await open(box);
    await ui.term.line('/plain');
    expect(await ui.done).toBe('plain');
  });
});

describe('完整交互界面：指令', () => {
  it('/diff 显示上一个任务对已跟踪文件的改动，并列出未跟踪的新文件', async () => {
    const box = sandbox({ git: true });
    box.setScenario({
      a2: [{ text: '改好了', files: [{ path: 'README.md', content: '# 测试项目\n新增的一行\n' }, { path: 'src/new.txt', content: 'n' }] }],
    });
    const ui = await open(box);
    await ui.term.line('/diff');
    await ui.see('上一个任务没有改动文件。');

    await ui.term.line('/to 实现 改两个文件');
    await ui.see('[J0001] 完成');
    await ui.term.line('/diff');
    await ui.see('+新增的一行');
    const screen = ui.term.screen();
    expect(screen).toContain('README.md');
    expect(screen).toContain('新文件（尚未被 git 跟踪，不在上面的差异里）：src/new.txt');

    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
  });

  it('输入 / 弹出指令菜单，Tab 补全；/roles、/role、无效指令各有输出', async () => {
    const box = sandbox({ git: true });
    const ui = await open(box);
    ui.term.press('/ro');
    await ui.see('/roles');
    expect(ui.term.screen()).toContain('查看角色表');
    expect(ui.term.screen()).toContain('/role <角色> <AI>');
    ui.term.press('\t');
    await ui.see('> /roles');
    ui.term.press('\r');
    await ui.see('实现（coder） · 可写 · 当前担当：a2');

    await ui.term.line('/role 实现 a3');
    await ui.see('临时改由 a3 担当');
    await ui.see('实现 a3');

    await ui.term.line('/role 不存在的角色 a3');
    await ui.see('x ');
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
  });
});

describe('完整交互界面：命令行入口', () => {
  function io(box: Sandbox, term: FakeTerminal, args: { env?: Record<string, string>; columns?: number } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    if (args.columns) (term.stdout as unknown as { columns: number }).columns = args.columns;
    const env = { ...box.env(), NO_COLOR: '1', ...(args.env ?? {}) };
    delete (env as Record<string, string | undefined>).WT_SESSION;
    return {
      out,
      err,
      io: {
        stdout: (t: string) => void out.push(t),
        stderr: (t: string) => void err.push(t),
        env,
        cwd: box.project,
        isTTY: true,
        stderrIsTTY: true,
        columns: args.columns ?? 100,
        streams: { stdin: term.stdin, stderr: term.stdout, stdout: term.stdout },
        readStdin: async () => '',
      },
    };
  }

  it('不带任务运行 dario 进入完整界面，/exit 后退出码为 0', async () => {
    const box = sandbox({ git: true });
    const term = terminal();
    const h = io(box, term);
    const done = runCli([], h.io);
    await waitFor(() => term.screen().includes('/help 查看全部'), '出现开场行', term.screen);
    await waitFor(() => term.screen().includes('project · 主控 a1'), '出现状态栏', term.screen);
    await term.line('/exit');
    expect(await done).toBe(0);
    expect(h.err).toEqual([]);
  });

  it('带 --plain 或 DARIO_PLAIN=1 时不进入完整界面', async () => {
    for (const variant of [{ argv: ['--plain'] }, { argv: [], env: { DARIO_PLAIN: '1' } }]) {
      const box = sandbox({ git: true });
      const term = terminal();
      const h = io(box, term, { env: variant.env });
      const done = runCli(variant.argv, h.io);
      await pause(600);
      expect(term.screen()).not.toContain('/help 查看全部');
      term.press('/exit\n');
      expect(await done).toBe(0);
    }
  });
});

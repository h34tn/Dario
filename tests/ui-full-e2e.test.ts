import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/compose.js';
import type { Engine } from '../src/core/engine.js';
import { runFullUi } from '../src/ui/full.js';
import { DISABLE_MOUSE, ENABLE_MOUSE } from '../src/ui/mouse.js';
import { plan, Sandbox, verdict, type SandboxOptions } from './helpers.js';

/**
 * 全屏交互界面的端到端测试：真实的引擎与假 AI（要启动子进程），界面画到一对假的终端流上。
 *
 * 全屏界面只重画变化的行，屏幕内容不能靠"累计输出里有没有某段文字"来判断。
 * 所以流程的推进看引擎里的任务状态，画面的内容看退出后写回普通屏幕的会话记录。
 */

const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const ENTER_ALT_SCREEN = '\x1b[?1049h';

interface FakeTerminal {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** 写到"终端"的全部原始内容。 */
  raw(): string;
  /** 退出备用屏幕之后写出的内容（已去掉控制字符），也就是留在普通屏幕上的会话记录。 */
  record(): string;
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
  const raw = () => chunks.join('');
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    raw,
    record: () => {
      const all = raw();
      const at = all.lastIndexOf(LEAVE_ALT_SCREEN);
      return at < 0 ? '' : stripVTControlCharacters(all.slice(at + LEAVE_ALT_SCREEN.length));
    },
    press,
    line: async (text) => {
      press(text);
      await pause(60);
      press('\r');
      await pause(60);
    },
  };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
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

function statusOf(engine: Engine, id: string): string | undefined {
  try {
    return engine.job(id).status;
  } catch {
    return undefined;
  }
}

async function open(box: Sandbox) {
  const term = terminal();
  const { engine } = await createApp({ cwd: box.project, env: box.env() });
  const plain: string[] = [];
  const done = runFullUi({ engine, stdin: term.stdin, stdout: term.stdout, env: { NO_COLOR: '1' }, printLine: (l) => plain.push(l) });
  await waitFor(() => term.raw().includes(ENABLE_MOUSE), '界面挂载并开启鼠标上报');
  const until = (id: string, status: string) => waitFor(() => statusOf(engine, id) === status, `${id} 变为 ${status}`);
  return { term, engine, done, plain, until };
}

describe('全屏界面：下达任务与会话记录', () => {
  it('进入备用屏幕；任务执行完后退出，会话记录留在普通屏幕上', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a2: [{ text: '## 结论\n\n已写好 **文件**。', files: [{ path: 'src/x.txt', content: 'x' }] }] });
    const ui = await open(box);
    expect(ui.term.raw()).toContain(ENTER_ALT_SCREEN);

    await ui.term.line('/to 实现 写一个文件');
    await ui.until('J0001', 'done');
    expect(fs.readFileSync(path.join(box.project, 'src', 'x.txt'), 'utf8')).toBe('x');
    await pause(300);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');

    const raw = ui.term.raw();
    // 先关鼠标上报，再离开备用屏幕
    expect(raw.lastIndexOf(DISABLE_MOUSE)).toBeGreaterThan(raw.lastIndexOf(ENABLE_MOUSE));
    expect(raw.lastIndexOf(DISABLE_MOUSE)).toBeLessThan(raw.lastIndexOf(LEAVE_ALT_SCREEN));

    const record = ui.term.record();
    expect(record).toContain('Dario · project');
    expect(record).toContain('> /to 实现 写一个文件');
    expect(record).toContain('J0001 · 交给 实现 · 写一个文件');
    expect(record).toMatch(/\+ 执行 {3}实现 · a2 {3}\d+/);
    expect(record).toContain('[J0001] 完成');
    expect(record).toContain('已写好 文件。');
    expect(record).not.toContain('## 结论');
    expect(record).toContain('改动的文件（1）：');
    expect(record).toContain('  src/x.txt');
    // 记录里是定稿的内容，没有运行中的转动标记行
    expect(record).not.toMatch(/[-\\|/] 执行 {3}实现/);
    expect(ui.plain).toEqual([]);
  });

  it('没有下过任何任务就退出时，不往普通屏幕写记录', async () => {
    const box = sandbox({ git: true });
    const ui = await open(box);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
    expect(ui.term.record().trim()).toBe('');
  });

  it('主控流程：计划等待按键，确认之前不改文件，按 y 后执行到完成', async () => {
    const box = sandbox({ git: true });
    box.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '新建 src/x.txt', writes: true }]) }, { text: '汇总：已新建文件' }],
      a2: [{ text: '已新建', files: [{ path: 'src/x.txt', content: 'x' }] }],
      a3: [{ text: verdict(true) }],
    });
    const ui = await open(box);
    await ui.term.line('新建一个文件');
    await ui.until('J0001', 'awaiting_approval');
    await pause(300);
    expect(fs.existsSync(path.join(box.project, 'src', 'x.txt'))).toBe(false);
    expect(box.calls().map((c) => c.name)).toEqual(['a1']);

    ui.term.press('y');
    await ui.until('J0001', 'done');
    expect(box.calls().map((c) => c.name)).toEqual(['a1', 'a2', 'a3', 'a1']);
    expect(fs.existsSync(path.join(box.project, 'src', 'x.txt'))).toBe(true);

    await pause(300);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
    const record = ui.term.record();
    expect(record).toContain('J0001 · 主控安排 · 新建一个文件');
    expect(record).toContain('汇总：已新建文件');
    // 等待确认时键入的 y 没有被当成一条输入
    expect(record).not.toContain('> y');
  });

  it('计划确认时按 n：任务取消，界面继续可用', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a1: [{ text: plan([{ role: 'coder', task: '新建 src/x.txt', writes: true }]) }] });
    const ui = await open(box);
    await ui.term.line('新建一个文件');
    await ui.until('J0001', 'awaiting_approval');
    await pause(300);
    ui.term.press('n');
    await ui.until('J0001', 'cancelled');
    expect(box.calls().map((c) => c.name)).toEqual(['a1']);

    await pause(300);
    await ui.term.line('/status');
    await pause(300);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
    expect(ui.term.record()).toContain('J0001 已取消');
  });
});

describe('全屏界面：排队、上文、中断', () => {
  it('任务运行时再输入的任务会排队，并带上前一个任务的结论', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a2: [{ text: '第一个任务的结论', delayMs: 1200 }, { text: '第二个任务的结论' }] });
    const ui = await open(box);
    await ui.term.line('/to 实现 第一个任务');
    await waitFor(() => box.calls().length === 1, '第一个任务开始执行');
    await ui.term.line('/to 实现 第二个任务');
    await ui.until('J0002', 'done');

    const calls = box.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('同一次会话里上一个任务（J0001）的结论：');
    expect(calls[1].prompt).toContain('第一个任务的结论');

    await pause(300);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
    const record = ui.term.record();
    expect(record).toContain('已排队，前面还有 1 个任务。');
    expect(record.indexOf('[J0001] 完成')).toBeLessThan(record.indexOf('J0002 · 交给 实现 · 第二个任务'));
  });

  it('按 Esc 中断正在运行的任务，界面继续可用', async () => {
    const box = sandbox({ git: true, streams: true });
    box.setScenario({ a2: [{ hang: true }, { text: '第二次正常完成' }] });
    const ui = await open(box);
    await ui.term.line('/to 实现 一个不会结束的任务');
    await waitFor(() => box.calls().length === 1, '任务开始执行');
    await pause(400);
    ui.term.press('\u001B');
    await ui.until('J0001', 'cancelled');

    await pause(300);
    await ui.term.line('/to 实现 再来一个');
    await ui.until('J0002', 'done');
    await pause(300);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
    expect(ui.term.record()).toContain('[J0001] 已取消');
  });

  it('任务运行中连按两次 Ctrl+C：取消任务并退出', async () => {
    const box = sandbox({ git: true, streams: true });
    box.setScenario({ a2: [{ hang: true }] });
    const ui = await open(box);
    await ui.term.line('/to 实现 一个不会结束的任务');
    await waitFor(() => box.calls().length === 1, '任务开始执行');
    await pause(400);
    ui.term.press('\u0003');
    await pause(200);
    ui.term.press('\u0003');
    expect(await ui.done).toBe('exit');
    expect(ui.engine.job('J0001').status).toBe('cancelled');
    expect(ui.term.raw().lastIndexOf(DISABLE_MOUSE)).toBeGreaterThan(ui.term.raw().lastIndexOf(ENABLE_MOUSE));
  });
});

describe('全屏界面：鼠标与翻看', () => {
  it('滚轮、点击事件不会变成输入框里的文字', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a2: [{ text: '完成' }] });
    const ui = await open(box);
    // 滚轮上、滚轮下、一次点击与松开，夹在正常输入的前后
    ui.term.press('\u001B[<64;10;5M');
    ui.term.press('/to 实现 ');
    ui.term.press('\u001B[<65;10;5M\u001B[<0;3;3M\u001B[<0;3;3m');
    await ui.term.line('带滚轮的输入');
    await ui.until('J0001', 'done');
    // 任务说明里只有键入的文字
    expect(box.calls()[0].prompt).toContain('带滚轮的输入');
    expect(box.calls()[0].prompt).not.toMatch(/\[<\d+;\d+;\d+/);

    await pause(300);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
    const record = ui.term.record();
    expect(record).toContain('> /to 实现 带滚轮的输入');
    expect(record).not.toMatch(/\[<\d+;\d+;\d+/);
  });

  it('PgUp 翻看时照常可以输入并提交', async () => {
    const box = sandbox({ git: true });
    box.setScenario({ a2: [{ text: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行结论`).join('\n') }, { text: '第二个完成' }] });
    const ui = await open(box);
    await ui.term.line('/to 实现 产生很长的结论');
    await ui.until('J0001', 'done');
    await pause(300);
    ui.term.press('\u001B[5~');
    await pause(150);
    ui.term.press('\u001B[5~');
    await pause(150);
    await ui.term.line('/to 实现 翻看之后再下一个');
    await ui.until('J0002', 'done');
    await pause(300);
    await ui.term.line('/exit');
    expect(await ui.done).toBe('exit');
    const record = ui.term.record();
    expect(record).toContain('第 1 行结论');
    expect(record).toContain('第 60 行结论');
    expect(record).toContain('[J0002] 完成');
  });
});

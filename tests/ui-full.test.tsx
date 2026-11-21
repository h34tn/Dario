import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { render } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { Mouse } from '../src/ui/mouse.js';
import type { CopyResult, ReadResult } from '../src/ui/clipboard.js';
import { FullApp } from '../src/ui/FullApp.js';
import { displayWidth } from '../src/ui/text.js';
import { pickSymbols } from '../src/ui/theme.js';
import { question, setup, step } from './ui-session-helper.js';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const cursor = vi.hoisted(() => vi.fn());
vi.mock('ink', async importOriginal => ({
  ...await importOriginal<typeof import('ink')>(), useCursor: () => ({ setCursorPosition: cursor }),
}));

async function screen(columns = 100, rows = 30, wide = false, color = false) {
  const data = await setup();
  let frame = '';
  const stdout = Object.assign(new Writable({ write(chunk, _, done) {
    if (chunk.toString().includes('\n')) frame = chunk.toString();
    done();
  } }), { columns, rows, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const symbols = pickSymbols(wide ? {} : { WT_SESSION: '终端' }, { platform: 'win32', locale: 'zh-CN' });
  const listeners = new Set<(d: Mouse) => void>();
  const onExit = vi.fn();
  const onError = vi.fn();
  const copy = vi.fn(async (_text: string): Promise<CopyResult> => ({ ok: true }));
  const readClipboard = vi.fn(async (): Promise<ReadResult> => ({ ok: true, text: '' }));
  const props = { readClipboard, copy, session: data.session, symbols, color, onExit, onError,
    onMouse(listener: (d: Mouse) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } };
  const view = render(<FullApp {...props} />, { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  cleanup.push(() => { view.unmount(); data.session.dispose(); });
  await setImmediate();
  const check = (fn: (lines: string[]) => void) => vi.waitFor(() => fn(frame.split('\n')));
  const contains = (text: string) => vi.waitFor(() => expect(frame).toContain(text));
  const key = async (value: string) => { stdin.write(value); await setImmediate(); };
  const wheel = (direction: Mouse) => listeners.forEach(fn => fn(direction));
  return { ...data, mouse: wheel, copy, check, contains, key, wheel, stdout, props, view, onExit, symbols, lines: () => frame.split('\n') };
}

it.each([[100, 30], [60, 20], [40, 12]])('%i 列 %i 行时历史贴顶，输入框上下有横线，状态栏固定在末行', async (columns, rows) => {
  const ui = await screen(columns, rows, columns === 40);
  await ui.check(lines => {
    expect(lines).toHaveLength(rows);
    expect(lines.every(line => displayWidth(line, ui.symbols.wide) < columns)).toBe(true);
    expect(lines[0]).toContain('Dario');
    expect(lines.at(-6)).toBe('');
    expect(lines.slice(-5, -2)).toEqual([ui.symbols.rule.repeat(columns - 1), '>', ui.symbols.rule.repeat(columns - 1)]);
    expect(lines.at(-1)).toMatch(/^rise ·/);
    if (ui.symbols.wide) expect(lines.join('')).not.toMatch(/[─…↓]/);
  });
});

it('滚轮和翻页按行移动，追加活动时保持首行，结束时折叠全部活动', async () => {
  const ui = await screen(60, 20, true);
  const finish = ui.hold();
  ui.session.submit('任务');
  const jobId = 'J0001';
  ui.emit({ jobId, kind: 'step_start', text: '', step });
  const activity = (i: number) => ui.emit({ jobId, kind: 'activity', text: '活动' + i + '\n第二行' });
  for (let i = 1; i <= 100; i++) activity(i);
  await ui.contains('活动100');
  function checkStepLine() {
    const lines = ui.lines();
    expect(lines[14]).toMatch(/^\S 执行   实现 · codex   \d+:\d{2}$/);
    expect(lines.indexOf(ui.symbols.rule.repeat(59))).toBe(15);
  }
  expect(ui.lines()[0]).toBe('    活动87');
  checkStepLine();
  ui.wheel('up');
  await ui.contains('v 下面还有 3 行');
  expect(ui.lines()[0]).toBe('    活动84');
  checkStepLine();
  ui.wheel('down');
  await ui.contains('活动100');
  await ui.key('\x1b[5~');
  await ui.contains('下面还有 13 行');
  const before = ui.lines().slice(0, 14);
  activity(101);
  await ui.contains('下面还有 14 行');
  expect(ui.lines().slice(0, 14)).toEqual(before);
  ui.stdout.rows = 18;
  ui.stdout.emit('resize');
  await ui.contains('下面还有 16 行');
  expect(ui.lines().slice(0, 12)).toEqual(before.slice(0, 12));
  ui.stdout.rows = 20;
  ui.stdout.emit('resize');
  await ui.contains('下面还有 14 行');
  await ui.key('\x1b[6~');
  await ui.contains('下面还有 1 行');
  await ui.key('\x1b[F');
  await ui.contains('活动101');
  expect(ui.lines().join('')).not.toMatch(/下面还有|第二行|[─…↓]/);
  for (let i = 0; i < 8; i++) await ui.key('\x1b[5~');
  await ui.contains('    活动1\n');
  checkStepLine();
  expect(ui.lines().slice(0, 14).join('')).not.toContain('执行   实现');
  ui.emit({ jobId, kind: 'step_end', text: '', step: { ...step, outcome: 'ok' } });
  await ui.contains('+ 执行   实现');
  expect(ui.lines().join('')).not.toContain('活动');
  finish();
  await ui.session.whenIdle();
});

it('翻看历史时步骤开始和结束均保持首行、整帧高度和输入光标位置', async () => {
  const ui = await screen(80, 12);
  ui.session.submit('/help');
  const finish = ui.hold();
  ui.session.submit('任务');
  await ui.key('\x1b[5~');
  await ui.contains('下面还有');
  function checkLayout() {
    const lines = ui.lines();
    expect(lines).toHaveLength(12);
    expect(lines[8]).toBe('>');
    expect(cursor).toHaveBeenLastCalledWith({ x: 2, y: 8 });
  }
  checkLayout();
  const history = ui.lines().slice(0, 7);
  const jobId = 'J0001';
  ui.emit({ jobId, kind: 'step_start', text: '', step });
  ui.emit({ jobId, kind: 'activity', text: '读文件' });
  await ui.contains('执行   实现');
  expect(ui.lines().slice(0, 6)).toEqual(history.slice(0, 6));
  checkLayout();
  ui.emit({ jobId, kind: 'step_end', text: '', step: { ...step, outcome: 'ok' } });
  await ui.check(lines => expect(lines.slice(0, 7)).toEqual(history));
  checkLayout();
  finish();
  await ui.session.whenIdle();
});

it('提交后回显并贴底，菜单过滤和补全沿用输入框', async () => {
  const ui = await screen(100, 20);
  ui.session.submit('/help');
  await ui.key('\x1b[5~');
  await ui.contains('下面还有');
  await ui.key('文字');
  await ui.key('\r');
  await ui.contains('上文 J0001');
  expect(ui.lines()).toContain('> 文字');
  expect(ui.lines().at(-4)).toBe('>');
  expect(ui.lines().join('')).not.toContain('下面还有');
  await ui.key('/');
  await ui.contains('直接交给指定角色');
  expect(ui.lines()).toHaveLength(20);
  ui.wheel('up');
  await ui.contains('下面还有 3 行');
  expect(ui.lines().at(-4)).toBe('> /');
  ui.wheel('down');
  await ui.contains('直接交给指定角色');
  await ui.key('r');
  await ui.key('\t');
  await ui.contains('> /roles');
});

it('全屏矮窗口的菜单跟随高亮，关闭后恢复历史和多行光标移动', async () => {
  const ui = await screen(60, 8);
  await ui.key('历史任务');
  await ui.key('\r');
  await ui.contains('上文 J0001');
  await ui.key('/');
  await ui.key('\x1b[A');
  await ui.contains('（15/15）');
  expect(ui.lines()).toContain('> /');
  expect(ui.lines().some(line => line.startsWith('> /exit '))).toBe(true);
  expect(ui.lines()).toHaveLength(8);
  await ui.key('\x1b[B');
  await ui.contains('> /to <角色>');
  await ui.key('\n');
  await ui.key('正文');
  await ui.key('\x1b[A');
  await ui.key('甲');
  await ui.contains('> /甲');
  expect(ui.lines().join('\n')).not.toContain('（1/15）');
  await ui.key('\x1b');
  await ui.check(lines => expect(lines.at(-4)).toBe('>'));
  await ui.key('\x1b[A');
  await ui.check(lines => expect(lines.at(-4)).toBe('> 历史任务'));
});

it('长计划展开后仍可翻页和滚动，确认提示始终固定', async () => {
  const ui = await screen(60, 12);
  ui.engine.advance.mockImplementationOnce(async (job, opts) => {
    const task = Array.from({ length: 24 }, (_, i) => '说明' + (i + 1)).join('\n');
    await opts.confirm!({ ...job, plan: { summary: '', steps: [{ role: 'coder', task, writes: true }] } });
    return job;
  });
  ui.session.submit('计划');
  await ui.contains('执行吗？');
  await ui.key('d');
  await ui.contains('说明24');
  await ui.key('\x1b[5~');
  await ui.contains('说明12\n');
  expect(ui.lines().at(-2)).toContain('执行吗？');
  ui.wheel('down');
  await ui.contains('说明21\n');
  await ui.key('n');
  await ui.session.whenIdle();
});

it.each([['y', true], ['n', false], ['\x1b', false], ['\x03', false]] as const)('确认期间隔离输入，切换详情并处理按键 %j', async (key, approved) => {
  const ui = await screen();
  ui.engine.advance.mockImplementationOnce(async (job, opts) => {
    await opts.confirm!({ ...job, plan: { summary: '', steps: [{ ...step, writes: true, task: '第一行\n细节', acceptance: '验收结果' }] } });
    return job;
  });
  ui.session.submit('编排');
  await ui.contains('执行吗？');
  await ui.contains('1. 实现  改文件  第一行');
  ui.mouse({ type: 'rightPress', col: 3, row: 27 });
  expect(ui.props.readClipboard).not.toHaveBeenCalled();
  const decide = vi.spyOn(ui.session, 'decidePlan');
  await ui.key('字');
  await ui.key('d');
  await ui.contains('验收结果');
  expect(ui.lines().join('')).toContain('细节');
  await ui.key('d');
  await ui.check(lines => expect(lines.join('')).not.toContain('细节'));
  expect(ui.lines().at(-4)).toBe('>');
  await ui.key(key);
  await vi.waitFor(() => expect(decide).toHaveBeenCalledExactlyOnceWith(approved));
  await ui.session.whenIdle();
});

it('转义键与中断键先清草稿，空输入可取消任务，两次中断键只退出一次', async () => {
  const ui = await screen();
  const interrupt = vi.spyOn(ui.session, 'interrupt');
  for (const key of ['\x1b', '\x03']) {
    await ui.key('草稿');
    await ui.contains('> 草稿');
    await ui.key(key);
    await ui.check(lines => expect(lines.at(-4)).toBe('>'));
  }
  expect(interrupt).not.toHaveBeenCalled();
  await ui.key('\x1b');
  await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
  await ui.key('\x03');
  await ui.contains('再按一次 Ctrl+C 退出');
  await ui.key('\x03');
  await vi.waitFor(() => expect(ui.onExit).toHaveBeenCalledExactlyOnceWith('exit'));
  const other = vi.fn();
  ui.view.rerender(<FullApp {...ui.props} onExit={other} />);
  await setImmediate();
  expect(other).not.toHaveBeenCalled();
});

it.each([[60, 7], [39, 20]])('缩小到 %i 列 %i 行后只显示提示，恢复后保留草稿', async (columns, rows) => {
  const ui = await screen();
  await ui.key('草稿');
  await ui.contains('> 草稿');
  function resize(columns: number, rows: number) {
    Object.assign(ui.stdout, { columns, rows });
    ui.stdout.emit('resize');
  }
  resize(columns, rows);
  await ui.contains('窗口太小');
  expect(ui.lines()).toHaveLength(rows);
  expect(ui.lines()[0]).toContain('Ctrl+C 退出');
  expect(ui.lines().slice(1).join('')).toBe('');
  ui.mouse({ type: 'press', col: 1, row: 1 });
  ui.mouse({ type: 'release', col: 4, row: 1 });
  expect(ui.copy).not.toHaveBeenCalled();
  resize(100, 30);
  await ui.contains('> 草稿');
  expect(ui.lines()).toHaveLength(30);
  resize(columns, rows);
  await ui.contains('窗口太小');
  await ui.key('\x03');
  await vi.waitFor(() => expect(ui.onExit).toHaveBeenCalledExactlyOnceWith('exit'));
});

it('着色时输入回显整行铺灰色底，步骤状态行在耗时之后显示 token 用量', async () => {
  const ui = await screen(60, 20, false, true);
  const finish = ui.hold();
  ui.session.submit('/to 实现 你好');
  await ui.check(lines => {
    const echo = lines.find(line => line.includes('你好') && line.includes('/to'))!;
    expect(echo.startsWith('\x1b[48;5;237m')).toBe(true);
    // 灰色底一直铺到行尾：去掉颜色后是补满到列数减一的一行
    expect(stripVTControlCharacters(echo)).toBe('> /to 实现 你好'.padEnd(59 - 4));
  });
  ui.emit({ jobId: 'J0001', kind: 'step_start', text: '', step });
  ui.emit({ jobId: 'J0001', kind: 'usage', text: '', step: { ...step, tokens: { input: 35700, cachedInput: 100, output: 426 } } });
  await ui.check(lines => expect(lines.map(stripVTControlCharacters).some(line => /00:\d\d · ↑ 35\.6k ↓ 426 tokens$/.test(line))).toBe(true));
  ui.emit({ jobId: 'J0001', kind: 'step_end', text: '', step: { ...step, outcome: 'ok', durationMs: 2000, tokens: { input: 40000, cachedInput: 100, output: 512 } } });
  await ui.check(lines => expect(lines.map(stripVTControlCharacters)).toContain('✓ 执行   实现 · codex   2秒 · ↑ 39.9k ↓ 512 tokens'));
  finish();
  await ui.session.whenIdle();
});

it.each([['y', true], ['n', false], ['\x1b', false]])('换人询问显示在历史区，提示行给出按键，按 %j 回答', async (key, expected) => {
  const ui = await screen(70, 20);
  let decision: boolean | undefined;
  ui.engine.advance.mockImplementationOnce(async (job, opts) => {
    decision = await opts.confirmFallback!(question);
    return job;
  });
  ui.session.submit('任务');
  await ui.contains('! 主控的担当者 claude（claude-x） 不可用（额度用尽）。');
  await ui.contains('  改用备选 codex（gpt-x） 继续这个任务吗？');
  await ui.check(lines => expect(lines.at(-2)).toBe('改用备选继续吗？  y 继续   n 停止任务'));
  ui.mouse({ type: 'rightPress', col: 1, row: 17 });
  expect(ui.props.readClipboard).not.toHaveBeenCalled();
  // 询问期间输入框不接收文字
  await ui.key('x');
  await ui.check(lines => expect(lines.at(-4)).toBe('>'));
  await ui.key(key);
  await ui.session.whenIdle();
  expect(decision).toBe(expected);
  await ui.check(lines => expect(lines.join('\n')).not.toContain('改用备选'));
});

it('型号选择显示角色、读取提示、实时清单及查询失败原因', async () => {
  const ui = await screen();
  const roles = await ui.engine.rolesView();
  ui.engine.rolesView.mockResolvedValue(roles.map(role => ({ ...role,
    candidates: role.candidates.map(c => ({ ...c, model: '实际型号' })),
  })));
  ui.session.submit('/model');
  await ui.contains('设置哪个角色？');
  let finish!: () => void;
  ui.engine.roles.listModels.mockImplementationOnce(() => new Promise(resolve => {
    finish = () => resolve({ models: [{ id: '新型号', label: '测试标签', resolved: '实际型号' }] });
  }));
  await ui.key('\r');
  await ui.contains('正在读取型号清单');
  finish();
  await ui.contains('测试标签  新型号  ● 当前');
  expect(ui.lines().join('')).not.toContain('不在清单里');
  await ui.key('\x1b');
  await ui.contains('设置哪个角色？');
  ui.engine.roles.listModels.mockResolvedValueOnce({ models: [{ id: '内置型号' }], error: '超时' });
  await ui.key('\r');
  await ui.contains('没能取到型号清单：超时');
  expect(ui.lines().join('')).not.toContain('内置型号');
});

it('角色选择先显示已有名称，各家并发返回后刷新当前屏并保留光标', async () => {
  const ui = await screen();
  const roles = await ui.engine.rolesView();
  ui.engine.rolesView.mockResolvedValue(roles.map(role => ({ ...role,
    candidates: role.candidates.map(c => ({ ...c, model: 'base' })),
  })));
  let label = '原名称';
  ui.engine.roles.modelLabel = (agent, model) => agent === 'codex' ? label : model;
  let finish!: () => void;
  ui.engine.roles.listModels.mockClear();
  let fail!: () => void;
  ui.engine.roles.listModels.mockImplementationOnce(() => new Promise((_, reject) => {
    fail = () => reject(new Error('清单查询失败'));
  }));
  ui.engine.roles.listModels.mockImplementationOnce(() => new Promise(resolve => {
    finish = () => { label = '新名称'; resolve({ models: [] }); };
  }));
  ui.session.submit('/model');
  await ui.contains('原名称');
  expect(ui.engine.roles.listModels.mock.calls.flat()).toEqual(['claude', 'codex']);
  await ui.key('\x1b[B');
  finish();
  await ui.contains('新名称');
  fail();
  await setImmediate();
  expect(ui.lines().join('')).not.toContain('清单查询失败');
  expect(ui.session.getSnapshot().picker).toMatchObject({ step: 'roles', roleIndex: 1 });
});

it('拖选反显，松开复制，提示位于步骤与边线之间并在三秒后消失', async () => {
  const ui = await screen(60, 20);
  const finish = ui.hold();
  ui.session.submit('任务');
  ui.emit({ jobId: 'J0001', kind: 'step_start', text: '', step });
  await ui.contains('执行   实现');
  await ui.key('\x1b[200~甲\n乙\x1b[201~');
  await ui.contains('  乙');
  ui.mouse({ type: 'press', col: 1, row: 1 });
  ui.mouse({ type: 'move', col: 5, row: 1 });
  await ui.contains('\x1b[7mDario');
  expect(ui.copy).not.toHaveBeenCalled();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    ui.mouse({ type: 'release', col: 5, row: 1 });
    await ui.contains('已复制 5 个字符到剪贴板');
    expect(ui.copy).toHaveBeenCalledExactlyOnceWith('Dario');
    const lines = ui.lines(), i = lines.findIndex(line => line.includes('已复制'));
    expect(lines[i - 1]).toContain('执行   实现');
    expect(displayWidth(lines[i])).toBe(59);
    expect(lines[i + 1]).toBe(ui.symbols.rule.repeat(59));
    await vi.advanceTimersByTimeAsync(3000);
    await ui.check(frame => expect(frame.join('')).not.toContain('到剪贴板'));
    expect(ui.lines()[0]).toContain('\x1b[7m');
  } finally {
    vi.useRealTimers();
    finish();
    await ui.session.whenIdle();
  }
});

it('单击清除，历史外不能开始拖选，键入保留高亮而重新折行会清除', async () => {
  const ui = await screen(80, 20);
  function drag(start: number, end: number) {
    ui.mouse({ type: 'press', col: 1, row: start });
    ui.mouse({ type: 'release', col: 3, row: end });
  }
  drag(20, 1);
  expect(ui.copy).not.toHaveBeenCalled();
  drag(1, 1);
  await ui.contains('已复制 3');
  await ui.key('草稿');
  await ui.contains('> 草稿');
  expect(ui.lines()[0]).toContain('\x1b[7m');
  ui.mouse({ type: 'press', col: 3, row: 1 });
  ui.mouse({ type: 'release', col: 3, row: 1 });
  await ui.check(lines => expect(lines.join('')).not.toMatch(/已复制|\x1b\[7m/));
  expect(ui.copy).toHaveBeenCalledTimes(1);
  drag(1, 1);
  await ui.contains('已复制 3');
  Object.assign(ui.stdout, { columns: 100 });
  ui.stdout.emit('resize');
  await ui.check(lines => expect(lines[0]).not.toContain('\x1b[7m'));
});

it('双击选词三击选段，Esc 清除高亮，超时后重新计数', async () => {
  const ui = await screen();
  const click = () => {
    ui.mouse({ type: 'press', col: 2, row: 1 });
    ui.mouse({ type: 'release', col: 2, row: 1 });
  };
  const now = vi.spyOn(Date, 'now');
  try {
    const start = Date.now();
    now.mockReturnValue(start);
    click(); click(); click();
    expect(ui.copy.mock.calls.map(([s]) => s)).toEqual(['Dario', expect.stringContaining('Dario · rise')]);
    await ui.contains('个字符到剪贴板');
    await ui.key('\x1b');
    await ui.check(lines => expect(lines[0]).not.toContain('\x1b[7m'));
    click();
    now.mockReturnValue(start + 401);
    click();
    expect(ui.copy).toHaveBeenCalledTimes(2);
  } finally { now.mockRestore(); }
});

it('越界自动滚动并延伸选区，拖选时滚轮可用，复制提示保持翻看位置', async () => {
  const ui = await screen(80, 12);
  ui.session.submit('/help');
  await ui.contains('切换到逐行交互');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  async function frame() {
    await setImmediate();
    await ui.view.waitUntilRenderFlush();
    return ui.lines().map(stripVTControlCharacters);
  }
  try {
    const original = await frame();
    ui.mouse({ type: 'press', col: 1, row: 2 });
    ui.mouse({ type: 'move', col: 1, row: 1 });
    await frame();
    await vi.advanceTimersByTimeAsync(100);
    const up = await frame();
    expect(up[0]).not.toBe(original[0]);
    expect(up.at(-2)).toContain('下面还有 2 行');

    ui.mouse({ type: 'move', col: 1, row: 3 });
    ui.wheel('up');
    await frame();
    await vi.advanceTimersByTimeAsync(200);
    expect((await frame()).at(-2)).toContain('下面还有 5 行');

    ui.mouse({ type: 'move', col: 2, row: 9 });
    await frame();
    await vi.advanceTimersByTimeAsync(100);
    const down = await frame();
    expect(down.at(-2)).toContain('下面还有 3 行');
    ui.mouse({ type: 'release', col: 2, row: 9 });
    await vi.advanceTimersByTimeAsync(150);
    const copied = await frame();
    expect(copied.join('')).toContain('个字符到剪贴板');
    expect(ui.copy).toHaveBeenCalledExactlyOnceWith([original[1], original[2], original[3].slice(0, 2)].join('\n'));
    expect(copied[0]).toBe(down[0]);
  } finally { vi.useRealTimers(); }
});

it('拖动期间追加大量历史，原地松开仍复制先前高亮的字', async () => {
  const ui = await screen(80, 12);
  ui.mouse({ type: 'press', col: 1, row: 1 });
  ui.mouse({ type: 'move', col: 5, row: 1 });
  await ui.contains('\x1b[7mDario');
  ui.session.submit('/help');
  await ui.contains('切换到逐行交互');
  ui.mouse({ type: 'release', col: 5, row: 1 });
  expect(ui.copy).toHaveBeenCalledExactlyOnceWith('Dario');
});

it('迟到的复制结果不会覆盖新提示，失败后仍可输入', async () => {
  const ui = await screen();
  let finish!: (result: CopyResult) => void;
  ui.copy.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  ui.copy.mockResolvedValueOnce({ ok: false, reason: '终端已关闭' });
  for (const col of [1, 2]) {
    ui.mouse({ type: 'press', col, row: 1 });
    ui.mouse({ type: 'release', col: 4, row: 1 });
  }
  await ui.contains('复制失败：终端已关闭');
  finish({ ok: true });
  await ui.key('继续');
  await ui.contains('> 继续');
  expect(ui.lines().join('')).toContain('复制失败：终端已关闭');
});

it('翻看时输入框长高保留首行，矮窗口给输入框最多三分之一', async () => {
  const ui = await screen(80, 12);
  ui.session.submit('/help');
  await ui.key('\x1b[5~');
  await ui.contains('下面还有');
  const history = ui.lines().slice(0, 4);
  for (let i = 0; i < 6; i++) await ui.key('\n');
  await ui.key('末');
  await ui.contains('上面还有 4 行');
  const frame = ui.lines();
  expect(frame).toHaveLength(12);
  expect(frame.slice(0, 4)).toEqual(history);
  expect(frame[4]).toBe(ui.symbols.rule.repeat(79));
  expect(frame[8]).toBe('  末');
  expect(cursor).toHaveBeenLastCalledWith({ x: 4, y: 8 });
});

it('右键仅在输入框和边线上读取，等待期间按最新光标插入并提示结果', async () => {
  const ui = await screen(80, 20);
  const read = ui.props.readClipboard;
  const click = (row: number) => ui.mouse({ type: 'rightPress', col: 3, row });
  click(1);
  click(19);
  expect(read).not.toHaveBeenCalled();
  let done!: (result: ReadResult) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  click(16);
  await ui.key('前后');
  await ui.key('\x1b[D');
  done({ ok: true, text: '甲\n👍🏽' });
  await ui.contains('已粘贴 3 个字符');
  expect(ui.lines().slice(15, 17)).toEqual(['> 前甲', '  👍🏽后']);
  click(17);
  await ui.contains('剪贴板里没有文字');
  read.mockResolvedValueOnce({ ok: false, reason: '测试原因' });
  click(18);
  await ui.contains('粘贴失败：测试原因');
  expect(read).toHaveBeenCalledTimes(3);
  read.mockResolvedValueOnce({ ok: true, text: Array(9).fill('行').join('\n') });
  click(15);
  await ui.contains('> [已粘贴 9 行] 前甲');
});

it('增强键盘下方向键编辑，Alt 组合忽略，中文、粘贴、Esc 和 Ctrl+C 照常处理', async () => {
  const ui = await screen();
  await ui.key('甲乙');
  await ui.key('\x1b[D');
  await ui.key('\x1b[120;3u');
  await ui.key('\x1b[200~中\n文\x1b[201~');
  await ui.contains('> 甲中\n  文乙');
  await ui.key('\x1b[27u');
  await ui.check(lines => expect(lines.at(-4)).toBe('>'));
  await ui.key('新');
  await ui.key('\x1b[99;5u');
  await ui.check(lines => expect(lines.at(-4)).toBe('>'));
  await ui.key('\x1b[99;5u');
  await ui.contains('再按一次 Ctrl+C');
});

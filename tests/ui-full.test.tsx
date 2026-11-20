import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { render } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { FullApp } from '../src/ui/FullApp.js';
import { displayWidth } from '../src/ui/text.js';
import { pickSymbols } from '../src/ui/theme.js';
import { setup, step } from './ui-session-helper.js';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const cursor = vi.hoisted(() => vi.fn());
vi.mock('ink', async importOriginal => ({
  ...await importOriginal<typeof import('ink')>(), useCursor: () => ({ setCursorPosition: cursor }),
}));

async function screen(columns = 100, rows = 30, wide = false) {
  const data = await setup();
  let frame = '';
  const stdout = Object.assign(new Writable({ write(chunk, _, done) {
    if (chunk.toString().includes('\n')) frame = chunk.toString();
    done();
  } }), { columns, rows, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const symbols = pickSymbols(wide ? {} : { WT_SESSION: '终端' }, { platform: 'win32', locale: 'zh-CN' });
  const listeners = new Set<(d: 'up' | 'down') => void>();
  const onExit = vi.fn();
  const onError = vi.fn();
  const props = { session: data.session, symbols, color: false, onExit, onError,
    onWheel(listener: (d: 'up' | 'down') => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } };
  const view = render(<FullApp {...props} />, { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  cleanup.push(() => { view.unmount(); data.session.dispose(); });
  await setImmediate();
  const check = (fn: (lines: string[]) => void) => vi.waitFor(() => fn(frame.split('\n')));
  const contains = (text: string) => vi.waitFor(() => expect(frame).toContain(text));
  const key = async (value: string) => { stdin.write(value); await setImmediate(); };
  const wheel = (direction: 'up' | 'down') => listeners.forEach(fn => fn(direction));
  return { ...data, check, contains, key, wheel, stdout, props, view, onExit, symbols, lines: () => frame.split('\n') };
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
  resize(100, 30);
  await ui.contains('> 草稿');
  expect(ui.lines()).toHaveLength(30);
  resize(columns, rows);
  await ui.contains('窗口太小');
  await ui.key('\x03');
  await vi.waitFor(() => expect(ui.onExit).toHaveBeenCalledExactlyOnceWith('exit'));
});

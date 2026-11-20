import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { ReplApp } from '../src/ui/ReplApp.js';
import type { Engine } from '../src/core/engine.js';
import { runReplUi, UiUnavailableError } from '../src/ui/repl.js';
import { pickSymbols } from '../src/ui/theme.js';
import { DEFAULT_ROWS, plan, setup, step, type RoleRow } from './ui-session-helper.js';

afterEach(cleanup);

async function screen(rows?: RoleRow[]) {
  const data = await setup({}, rows);
  const onExit = vi.fn();
  const props = { session: data.session, color: false, symbols: pickSymbols({}), onExit, onError: vi.fn() };
  const view = render(<ReplApp {...props} />);
  await setImmediate();
  const contains = (text: string) => vi.waitFor(() => expect(view.lastFrame()).toContain(text));
  const absent = (text: string) => vi.waitFor(() => expect(view.lastFrame()).not.toContain(text));
  return { ...data, props, view, contains, absent, key: (key: string) => view.stdin.write(key) };
}

it('收起后保留历史和输入草稿，恢复时显示原有内容', async () => {
  const { props, view, key, contains, session } = await screen();
  key('草稿');
  await contains('> 草稿');
  view.rerender(<ReplApp {...props} suspended />);
  await vi.waitFor(() => expect(view.lastFrame()).not.toMatch(/主控 claude|^> |Esc 中断/m));
  expect(view.lastFrame()).toContain('Dario · rise');
  key('\x1b');
  session.submit('历史任务');
  await session.whenIdle();
  await vi.waitFor(() => expect(view.frames.join('\n')).toContain('> 历史任务'));
  expect(view.lastFrame()).not.toMatch(/主控 claude|> 草稿|Esc 中断/);
  view.rerender(<ReplApp {...props} suspended={false} />);
  await contains('> 草稿');
  await contains('主控 claude');
  await contains('Esc 中断');
});

it('菜单过滤与补全，提交后输入清空并回显到历史', async () => {
  const { view, key, contains, absent } = await screen();
  key('/');
  await contains('直接交给指定角色');
  key('r');
  await absent('直接交给指定角色');
  await contains('查看角色表');
  key('\t');
  await contains('> /roles');
  key('\x15');
  key('文字');
  key('\r');
  await contains('上文 J0001');
  expect(view.frames.join('\n')).toContain('> 文字');
  expect(view.lastFrame()).toMatch(/\n>\s*\n/);
});

it('角色表只有主控、可写角色、审查时，状态栏与原来的文字完全相同', async () => {
  const { view, contains } = await screen(DEFAULT_ROWS.filter(r => ['lead', 'coder', 'review'].includes(r.id)));
  await contains('rise · ');
  expect(view.lastFrame()!.split('\n').filter(line => line.startsWith('rise · ')))
    .toEqual(['rise · 主控 claude · 实现 codex · 审查 claude']);
});

it('状态栏第一帧就同时显示已配置的型号和未配置型号的担当者名字', async () => {
  const { session } = await setup({}, DEFAULT_ROWS, [{ id: 'claude', model: 'claude-fable-5-2' }, { id: 'codex' }]);
  const view = render(<ReplApp session={session} color={false} symbols={pickSymbols({})} onExit={vi.fn()} onError={vi.fn()} />);
  expect(view.frames[0]).toContain('rise · 主控 claude-fable-5-2 · 实现 codex');
});

it('状态栏、步骤与活动随队列更新，批准计划时按键只交给确认框', async () => {
  const { key, session, engine, contains, emit, hold } = await screen();
  await contains('rise · 主控 claude · 实现 codex · 测试 codex · 审查 claude · 杂活 claude');
  const finish = hold();
  session.submit('一');
  session.submit('二');
  await contains('排队 1');
  emit({ jobId: 'J0001', kind: 'step_start', text: '', step });
  emit({ jobId: 'J0001', kind: 'activity', text: '读 a.ts' });
  await contains('执行   实现 · codex');
  await contains('读 a.ts');
  const decide = vi.spyOn(session, 'decidePlan');
  engine.advance.mockImplementationOnce(async (job, opts) => {
    await opts.confirm!({ ...job, plan });
    return job;
  });
  finish();
  await contains('执行吗？');
  key('y');
  await session.whenIdle();
  expect(decide).toHaveBeenCalledExactlyOnceWith(true);
  await contains('上文 J0002');
});

it('转义键优先清空文字或粘贴，空输入时中断当前任务', async () => {
  const { key, session, hold, contains, absent } = await screen();
  const finish = hold();
  session.submit('任务');
  const interrupt = vi.spyOn(session, 'interrupt');
  for (const [input, visible] of [['文字', '> 文字'], ['\x1b[200~甲\n乙\x1b[201~', '已粘贴 2 行']]) {
    key(input);
    await contains(visible);
    key('\x1b');
    await absent(visible);
  }
  expect(interrupt).not.toHaveBeenCalled();
  key('\x1b');
  await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
  finish();
  await session.whenIdle();
});

it('中断键清空草稿、显示和解除警告，连续两次才退出且回调只调用一次', async () => {
  const { key, contains, absent, props, view, session } = await screen();
  const exit = vi.spyOn(session, 'requestExit');
  key('草稿');
  await contains('> 草稿');
  key('\x03');
  await absent('> 草稿');
  const hint = '再按一次 Ctrl+C 退出';
  await absent(hint);
  key('\x03');
  await contains(hint);
  key('\t');
  await absent(hint);
  key('\x03');
  key('\x03');
  await vi.waitFor(() => expect(props.onExit).toHaveBeenCalledExactlyOnceWith('exit'));
  expect(exit).toHaveBeenCalledExactlyOnceWith('exit');
  const other = vi.fn();
  view.rerender(<ReplApp {...props} onExit={other} />);
  await setImmediate();
  expect(other).not.toHaveBeenCalled();
});

it('补全、排版、会话独立于渲染库，交互入口只按需加载', () => {
  const source = (path: string) => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
  for (const file of ['completion', 'markdown', 'session'])
    expect(source('ui/' + file + '.ts')).not.toMatch(/(?:from\s*|import\s*\(?\s*)['"](?:ink|react)(?:\/|['"])/);
  expect(source('cli/main.ts')).not.toMatch(/(?:from\s*|import\s*)['"]\.\.\/ui\/repl/);
});

it('确认界面出错时逐行询问，打印进度并依次跑完队列再降级', async () => {
  const { engine, session, emit } = await setup();
  session.dispose();
  const input = new PassThrough();
  const stdin = Object.assign(input, { isTTY: true, setRawMode: () => input, ref: () => input, unref: () => input });
  const frames: string[] = [];
  const stdout = Object.assign(new Writable({ write(chunk, _, cb) { frames.push(chunk.toString()); cb(); } }),
    { columns: 100, rows: 25, isTTY: true });
  const printLine = vi.fn();
  let ask!: () => void;
  const gate = new Promise<void>(resolve => { ask = resolve; });
  engine.advance.mockImplementationOnce(async (job, opts) => {
    await gate;
    expect(await opts.confirm!({ ...job, plan })).toBe(true);
    emit({ jobId: job.id, kind: 'activity', text: '动态' });
    emit({ jobId: job.id, kind: 'finished', text: '结束' });
    return job;
  });
  const ended = runReplUi({ engine: engine as unknown as Engine, stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream, printLine, env: { NO_COLOR: '1' } });
  await vi.waitFor(() => expect(frames.join('')).toContain('Dario · rise'));
  for (const line of ['一', '二']) {
    stdin.write(line);
    await vi.waitFor(() => expect(frames.join('')).toContain('> ' + line));
    stdin.write('\r');
    await vi.waitFor(() => expect(frames.join('')).toContain(line === '一' ? '主控安排 · 一' : '排队 1'));
  }
  emit({ jobId: 'J0001', kind: 'step_start', text: '', step });
  await vi.waitFor(() => expect(frames.join('')).toContain('执行   实现'));
  frames.length = 0;
  stdout.columns = 80;
  stdout.emit('resize');
  emit({ jobId: 'J0001', kind: 'activity', text: '读取配置' });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(frames.join('')).not.toMatch(/执行   实现|读取配置|主控 claude/);
  await vi.waitFor(() => expect(frames.join('')).toContain('读取配置'));
  expect(frames.join('')).toContain('执行   实现');
  engine.roles.label = () => { throw new Error('无法显示角色'); };
  ask();
  await vi.waitFor(() => expect(frames.join('')).toContain('执行吗？(y/N)'));
  stdin.write('y\n');
  expect(await ended).toBe('plain');
  expect(stdout.listenerCount('resize')).toBe(0);
  expect(printLine).toHaveBeenCalledWith('界面显示出错（无法显示角色），改用逐行交互。');
  expect(printLine).toHaveBeenCalledWith('[J0001] 结束');
  expect(printLine).not.toHaveBeenCalledWith('[J0001] 动态');
  expect(engine.advance).toHaveBeenCalledTimes(2);
  expect(engine.cancel).not.toHaveBeenCalled();
});

it('初次挂载无法使用原始输入时报告界面不可用', async () => {
  const { engine, session } = await setup();
  session.dispose();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { throw new Error('原始输入不可用'); } });
  const stdout = Object.assign(new Writable({ write(_chunk, _, cb) { cb(); } }), { isTTY: true, columns: 80, rows: 24 });
  await expect(runReplUi({ engine: engine as unknown as Engine, stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream, printLine: vi.fn(), env: {} })).rejects.toBeInstanceOf(UiUnavailableError);
});

import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import * as compose from '../src/compose.js';
import { runCli } from '../src/cli/main.js';
import { expect, it, vi } from 'vitest';
import type { Engine } from '../src/core/engine.js';
import type { Job, ProgressEvent } from '../src/core/types.js';
import { runLive, UiUnavailableError } from '../src/ui/run.js';

function terminal() {
  const frames: string[] = [];
  const stderr = Object.assign(new Writable({
    write(chunk, _encoding, callback) { frames.push(chunk.toString()); callback(); },
  }), { isTTY: true, columns: 80, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: false, setRawMode: vi.fn() });
  return { frames, streams: { stdin: stdin as unknown as NodeJS.ReadStream, stderr: stderr as unknown as NodeJS.WriteStream } };
}

function setup() {
  const { frames, streams } = terminal();
  const job = { id: 'J0012', task: '测试', mode: 'lead', plan: {
    summary: '', steps: [{ task: '写文件', role: 'coder', writes: true }],
  } } as Job;
  let emit: (event: ProgressEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const engine = {
    roles: { label: () => '实现' },
    onProgress(fn: typeof emit) { emit = fn; return unsubscribe; },
    advance: vi.fn<Engine['advance']>(),
    approve: vi.fn<Engine['approve']>(),
  };
  const opts = { ...streams, job, engine: engine as unknown as Engine, resume: false, autoApprove: false,
    env: { NO_COLOR: '1' }, notice: vi.fn(), printPlain: vi.fn(), askPlain: vi.fn(async () => 'yes') };
  return { opts, engine, frames, unsubscribe, send: (event: ProgressEvent) => emit(event) };
}

it('标准输入非终端时不询问，任务返回前写出最后一步', async () => {
  const { opts, engine, frames, unsubscribe, send } = setup();
  engine.advance.mockImplementation(async (job, options) => {
    expect(options.confirm).toBeUndefined();
    const step = { kind: 'review', index: 2, role: 'reviewer', roleLabel: '审查（reviewer）', outcome: 'ok', durationMs: 123 } as const;
    send({ jobId: '其他任务', kind: 'step_end', step: { ...step, roleLabel: '无关' }, text: '' });
    send({ jobId: job.id, kind: 'step_end', step, text: '' });
    return job;
  });
  expect(await runLive(opts)).toBe(opts.job);
  expect(frames.join('')).toContain('123ms');
  expect(frames.join('')).not.toContain('无关');
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('批准已有计划只推进一次', async () => {
  const { opts, engine } = setup();
  engine.approve.mockResolvedValue(opts.job);
  await runLive({ ...opts, resume: true });
  expect(engine.approve).toHaveBeenCalledExactlyOnceWith(opts.job.id);
  expect(engine.advance).not.toHaveBeenCalled();
});

it('挂载时无法切换原始输入模式，回退前尚未推进', async () => {
  const { opts, engine } = setup();
  opts.stdin.isTTY = true;
  opts.stdin.setRawMode = () => { throw new Error('不能切换输入模式'); };
  await expect(runLive(opts)).rejects.toThrow(UiUnavailableError);
  expect(engine.advance).not.toHaveBeenCalled();
});

it('确认界面出错后恢复纯文本提问与后续进度', async () => {
  const { opts, engine, send } = setup();
  opts.stdin.isTTY = true;
  engine.roles.label = () => { throw new Error('渲染失败'); };
  const event: ProgressEvent = { jobId: opts.job.id, kind: 'finished', text: '结束' };
  engine.advance.mockImplementation(async (job, options) => {
    expect(await options.confirm!(job)).toBe(true);
    send(event);
    return job;
  });
  expect(await runLive(opts)).toBe(opts.job);
  expect(opts.notice).toHaveBeenCalledExactlyOnceWith('界面显示出错（渲染失败），改用纯文本输出。');
  expect(opts.askPlain).toHaveBeenCalledExactlyOnceWith('这份计划会改动文件，执行吗？(y/N) ');
  expect(opts.printPlain).toHaveBeenCalledExactlyOnceWith(event);
  expect(engine.advance).toHaveBeenCalledOnce();
});

it('窗口变窄时停止输出当前步骤，稳定后恢复，任务结束时移除监听', async () => {
  const { opts, engine, send, frames } = setup();
  const before = opts.stderr.listeners('resize');
  engine.advance.mockImplementation(async job => {
    const step = { index: 1, kind: 'step', role: 'coder', roleLabel: '实现' } as const;
    send({ jobId: job.id, kind: 'step_start', step, text: '' });
    await vi.waitFor(() => expect(frames.join('')).toContain('执行   实现'));
    frames.length = 0;
    opts.stderr.columns = 60;
    opts.stderr.emit('resize');
    send({ jobId: job.id, kind: 'activity', text: '读文件' });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(frames.join('')).not.toMatch(/执行   实现|读文件/);
    await vi.waitFor(() => {
      expect(frames.join('')).toContain('执行   实现');
      expect(frames.join('')).toContain('读文件');
    });
    return job;
  });
  await runLive(opts);
  expect(opts.stderr.listeners('resize')).toEqual(before);
});

it.each([
  [true, '1'], [true, ''], [true, undefined], [false, ''], [undefined, ''],
] as const)('单次命令按标准输出终端状态和禁色开关排版结论 %j %j', async (isTTY, noColor) => {
  const { opts, engine, frames } = setup();
  const conclusion = '## 标题\n**结论**';
  const job: Job = { ...opts.job, status: 'done', result: { conclusion, changedFiles: [], warnings: [], fallbackHappened: false } };
  engine.advance.mockResolvedValue(job);
  const app = vi.spyOn(compose, 'createApp').mockResolvedValue({
    engine: { ...engine, create: () => job },
  } as unknown as compose.App);
  try {
    const stdout = vi.fn();
    const stream = Object.assign(new PassThrough(), { isTTY }) as unknown as NodeJS.WriteStream;
    const code = await runCli(['任务'], {
      stdout, stderr: vi.fn(), env: { NO_COLOR: noColor }, cwd: '.', isTTY: true, stderrIsTTY: true,
      readStdin: async () => '', streams: { stdin: opts.stdin, stderr: opts.stderr, stdout: isTTY === undefined ? undefined : stream },
    });
    expect(code).toBe(0);
    expect(frames.join('')).toContain(job.id);
    expect(stdout).toHaveBeenCalledOnce();
    const output = stdout.mock.calls[0]![0];
    expect(stripVTControlCharacters(output)).toBe(isTTY ? '标题\n结论' : conclusion);
    expect(output.includes('\x1b')).toBe(!!isTTY && !noColor);
  } finally {
    app.mockRestore();
  }
});

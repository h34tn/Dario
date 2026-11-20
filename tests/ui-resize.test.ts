import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { pollSize, watchResize } from '../src/ui/resize.js';

it('独立轮询按指定间隔刷新，主动停止或查询抛错后都不再刷新', () => {
  vi.useFakeTimers();
  const stream = { _refreshSize: vi.fn() };
  const stop = pollSize(stream, 25);
  vi.advanceTimersByTime(24);
  expect(stream._refreshSize).not.toHaveBeenCalled();
  vi.advanceTimersByTime(51);
  expect(stream._refreshSize).toHaveBeenCalledTimes(3);
  stop();
  vi.advanceTimersByTime(100);
  expect(stream._refreshSize).toHaveBeenCalledTimes(3);
  stream._refreshSize.mockImplementation(() => { throw new Error('流已关闭'); });
  pollSize(stream, 25);
  vi.advanceTimersByTime(100);
  expect(stream._refreshSize).toHaveBeenCalledTimes(4);
});

it('每百毫秒主动查询一次，取消、禁用或流关闭后停止查询', () => {
  vi.useFakeTimers();
  const handlers = { onStart: vi.fn(), onSettle: vi.fn() };
  const stream = Object.assign(new EventEmitter() as NodeJS.WriteStream, { _refreshSize: vi.fn() });
  const stop = watchResize(stream, handlers);
  vi.advanceTimersByTime(99);
  expect(stream._refreshSize).not.toHaveBeenCalled();
  vi.advanceTimersByTime(201);
  expect(stream._refreshSize).toHaveBeenCalledTimes(3);
  stop();
  const disabled = watchResize(stream, handlers, 300, 0);
  vi.advanceTimersByTime(500);
  expect(stream._refreshSize).toHaveBeenCalledTimes(3);
  disabled();
  stream._refreshSize.mockImplementation(() => { throw new Error('流已关闭'); });
  const failing = watchResize(stream, handlers);
  const missing = watchResize(new EventEmitter() as NodeJS.WriteStream, handlers);
  vi.advanceTimersByTime(500);
  expect(stream._refreshSize).toHaveBeenCalledTimes(4);
  expect(handlers.onStart).not.toHaveBeenCalled();
  expect(handlers.onSettle).not.toHaveBeenCalled();
  missing();
  failing();
});

afterEach(() => { vi.useRealTimers(); });

it('首先同步收起，连续变化重新计时，稳定后开始下一轮', () => {
  vi.useFakeTimers();
  const stream = new EventEmitter() as NodeJS.WriteStream;
  const calls: string[] = [];
  stream.on('resize', () => calls.push('重画'));
  const stop = watchResize(stream, {
    onStart: () => calls.push('开始'),
    onSettle: () => calls.push('稳定'),
  }, 100);
  stream.emit('resize');
  expect(calls).toEqual(['开始', '重画']);
  vi.advanceTimersByTime(80);
  stream.emit('resize');
  vi.advanceTimersByTime(99);
  expect(calls).toEqual(['开始', '重画', '重画']);
  vi.advanceTimersByTime(1);
  stream.emit('resize');
  expect(calls).toEqual(['开始', '重画', '重画', '稳定', '开始', '重画']);
  stop();
});

it('取消监听后不会触发待定的稳定回调或开始下一轮', () => {
  vi.useFakeTimers();
  const stream = new EventEmitter() as NodeJS.WriteStream;
  const handlers = { onStart: vi.fn(), onSettle: vi.fn() };
  const stop = watchResize(stream, handlers);
  stream.emit('resize');
  stop();
  stream.emit('resize');
  vi.runAllTimers();
  expect(handlers.onStart).toHaveBeenCalledOnce();
  expect(handlers.onSettle).not.toHaveBeenCalled();
  expect(stream.listenerCount('resize')).toBe(0);
});

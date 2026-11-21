import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createInputFilter, DISABLE_MOUSE, ENABLE_MOUSE, extractMouse } from '../src/ui/mouse.js';

afterEach(() => vi.useRealTimers());

it('键盘、方向键和粘贴标记立即放行，按顺序提取滚轮并过滤其余鼠标按钮', () => {
  const keys = '甲\x1b[A\x1b[200~粘贴\x1b[201~';
  expect(extractMouse(keys)).toEqual({ rest: keys, events: [], pending: '' });
  expect(extractMouse(keys + '\x1b[<65;1;2M乙\x1b[<0;2;3M\x1b[<64;2;3m\x1b[<32;3;4M\x1b[<64;5;6M丙'))
    .toEqual({ rest: keys + '乙丙', events: ['down', { type: 'press', col: 2, row: 3 }, { type: 'move', col: 3, row: 4 }, 'up'], pending: '' });
  expect(extractMouse('\x1b[<1;x')).toEqual({ rest: '\x1b[<1;x', pending: '', events: [] });
  expect(ENABLE_MOUSE).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  expect(DISABLE_MOUSE).toBe('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
});

it('在每一个可能的切分位置保留前缀，再拼成完整事件', () => {
  const event = '\x1b[<64;123;456M';
  for (let i = 1; i < event.length; i++) {
    const { pending } = extractMouse('甲' + event.slice(0, i));
    expect(pending).toBe(event.slice(0, i));
    expect(extractMouse(pending + event.slice(i))).toEqual({ rest: '', events: ['up'], pending: '' });
  }
});

it('可读流拼接三段输入，超时放行残段，转发终端操作并解除监听', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  const encoding = vi.spyOn(source, 'setEncoding');
  const wheel = vi.fn();
  const { stream, dispose } = createInputFilter(source as unknown as NodeJS.ReadStream, wheel);
  let text = '';
  stream.on('readable', () => {
    let chunk;
    while ((chunk = stream.read()) !== null) text += chunk;
  });
  stream.setEncoding('utf8');
  stream.setRawMode(true);
  stream.ref();
  stream.unref();
  expect(stream.isTTY).toBe(true);
  expect(encoding).toHaveBeenCalledWith('utf8');
  expect(source.setRawMode).toHaveBeenCalledWith(true);
  expect(source.ref).toHaveBeenCalledTimes(1);
  expect(source.unref).toHaveBeenCalledTimes(1);
  for (const part of ['甲\x1b', '[<64;', '5;6M\x1b[<65;1;2M乙\x1b']) {
    source.write(part);
    await setImmediate();
  }
  expect(wheel.mock.calls).toEqual([['up'], ['down']]);
  vi.advanceTimersByTime(49);
  expect(text).toBe('甲乙');
  vi.advanceTimersByTime(1);
  await setImmediate();
  expect(text).toBe('甲乙\x1b');
  source.write('\x1b[');
  await setImmediate();
  dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(source.listenerCount('readable') + source.listenerCount('end')).toBe(0);
  source.write('\x1b[<64;1;1M');
  await setImmediate();
  expect(wheel).toHaveBeenCalledTimes(2);
});

it('鼠标输入过滤独立于渲染库', () => {
  const source = readFileSync(new URL('../src/ui/mouse.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/(?:from\s*|import\s*\(?\s*)['"](?:ink|react)(?:\/|['"])/);
});

it('左键修饰与其他按钮被过滤，分段的释放事件保留坐标', () => {
  const ignored = [1, 6, 10, 18, 34, 4, 8, 16, 36, 40, 48].map(code => '\x1b[<' + code + ';4;5M').join('');
  const first = extractMouse('甲' + ignored + '\x1b[<0;12;');
  expect(first).toEqual({ rest: '甲', pending: '\x1b[<0;12;', events: [] });
  expect(extractMouse(first.pending + '34m乙')).toEqual({ rest: '乙', pending: '', events: [{ type: 'release', col: 12, row: 34 }] });
});

it('只上报无修饰键的右键按下，增强键盘应答完整穿过过滤流', async () => {
  const source = new PassThrough(), mouse = vi.fn();
  const { stream, dispose } = createInputFilter(source as unknown as NodeJS.ReadStream, mouse);
  try {
    source.write('\x1b[');
    await setImmediate();
    source.write('?1u\x1b[<2;12;9M\x1b[<2;12;9m');
    await setImmediate();
    expect(stream.read()).toBe('\x1b[?1u');
    expect(mouse).toHaveBeenCalledExactlyOnceWith({ type: 'rightPress', col: 12, row: 9 });
  } finally { dispose(); }
});

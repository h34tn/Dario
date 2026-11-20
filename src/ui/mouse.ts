import { Readable } from 'node:stream';

export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
export const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1000l';

type Direction = 'up' | 'down';

const event = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
// 从 Esc 到第三个数字字段，任意位置都可能是本次读取的末尾。
const partial = /\x1b(?:\[|\[<\d*|\[<\d+;\d*|\[<\d+;\d+;\d*)?(?![\s\S])/;

/** 完整的鼠标事件直接取走，只有末尾仍可能补全的前缀才暂存。 */
export function extractMouse(input: string) {
  const wheel: Direction[] = [];
  const pending = partial.exec(input)?.[0] ?? '';
  const rest = input.slice(0, input.length - pending.length).replace(event, (_, button, end) => {
    if (end === 'M' && button === '64') wheel.push('up');
    if (end === 'M' && button === '65') wheel.push('down');
    return '';
  });
  return { rest, wheel, pending };
}

export function createInputFilter(stdin: NodeJS.ReadStream, onWheel: (direction: Direction) => void) {
  stdin.setEncoding('utf8');
  const output = new Readable({ read() {} });
  output.setEncoding('utf8');
  let referenced = false;
  const stream = Object.assign(output, {
    isTTY: stdin.isTTY,
    setRawMode(mode: boolean) { stdin.setRawMode(mode); return this; },
    setEncoding(encoding: BufferEncoding) {
      stdin.setEncoding(encoding);
      return Readable.prototype.setEncoding.call(this, encoding);
    },
    ref() { stdin.ref(); referenced = true; return this; },
    unref() { stdin.unref(); referenced = false; return this; },
  });
  let pending = '';
  let timer: NodeJS.Timeout | undefined;
  function flush() {
    if (pending) output.push(pending);
    pending = '';
  }
  function read() {
    let chunk: string | null;
    while ((chunk = stdin.read()) !== null) {
      clearTimeout(timer);
      const result = extractMouse(pending + chunk);
      pending = result.pending;
      for (const direction of result.wheel) onWheel(direction);
      if (result.rest) output.push(result.rest);
      if (pending) timer = setTimeout(flush, 50).unref();
    }
  }
  function end() {
    clearTimeout(timer);
    flush();
    output.push(null);
  }
  stdin.on('readable', read).once('end', end);
  function dispose() {
    stdin.off('readable', read).off('end', end);
    clearTimeout(timer);
    stdin.pause();
    if (referenced) stream.unref();
    output.destroy();
  }
  return { stream: stream as unknown as NodeJS.ReadStream, dispose };
}

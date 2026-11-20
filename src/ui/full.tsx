import { writeSync } from 'node:fs';
import { render } from 'ink';
import { FullApp, type FullAppProps } from './FullApp.js';
import { createLineCache } from './lines.js';
import { createInputFilter, DISABLE_MOUSE, ENABLE_MOUSE } from './mouse.js';
import { finishInPlain, UiUnavailableError, type ReplOptions } from './repl.js';
import { pollSize } from './resize.js';
import { Session } from './session.js';
import { pickSymbols } from './theme.js';

export { UiUnavailableError };

export async function runFullUi(opts: ReplOptions): Promise<'exit' | 'plain'> {
  const { engine, stdin, stdout, env } = opts;
  const color = !!stdout.isTTY && !env.NO_COLOR;
  const symbols = pickSymbols(env);
  const session = new Session({ engine, color });
  let wheel: ((direction: 'up' | 'down') => void) | undefined;
  const onWheel: NonNullable<FullAppProps['onWheel']> = listener => {
    wheel = listener;
    return () => { wheel = undefined; };
  };
  // 退出事件里不能等待流排空，真实终端直接同步写文件描述符。
  function disableOnExit() {
    const { fd } = stdout as NodeJS.WriteStream & { fd?: number };
    if (typeof fd === 'number') writeSync(fd, DISABLE_MOUSE);
    else stdout.write(DISABLE_MOUSE);
  }
  let finish!: (result: 'exit' | 'plain' | Error) => void;
  const ended = new Promise<'exit' | 'plain' | Error>(resolve => { finish = resolve; });
  let mountError: Error | undefined;
  let mounted = false;
  function onError(error: Error) {
    if (!mounted) mountError = error;
    finish(error);
  }
  try {
    await session.start();
    let input: ReturnType<typeof createInputFilter> | undefined;
    let app: ReturnType<typeof render> | undefined;
    let stopPoll: (() => void) | undefined;
    let result: 'exit' | 'plain' | Error;
    try {
      try {
        input = createInputFilter(stdin, direction => wheel?.(direction));
        app = render(<FullApp session={session} symbols={symbols} color={color} onWheel={onWheel}
          onExit={finish} onError={onError} />, { stdout, stdin: input.stream, exitOnCtrlC: false,
          patchConsole: false, maxFps: 15, interactive: !!stdout.isTTY, alternateScreen: true, incrementalRendering: true });
        await app.waitUntilRenderFlush();
        if (mountError) throw mountError;
        mounted = true;
        process.on('exit', disableOnExit);
        stdout.write(ENABLE_MOUSE);
        stopPoll = pollSize(stdout);
      } catch (error) {
        throw new UiUnavailableError(error instanceof Error ? error.message : String(error));
      }
      void app.waitUntilExit().then(() => finish('exit'), error => finish(error as Error));
      result = await ended;
    } finally {
      try {
        stopPoll?.();
        if (mounted) stdout.write(DISABLE_MOUSE);
      } finally {
        try { app?.unmount(); } finally {
          input?.dispose();
          process.off('exit', disableOnExit);
        }
      }
    }
    const { history } = session.getSnapshot();
    // 只有开场行和输入的回显（比如进来就输入 /exit）时没有值得保留的内容。
    if (history.some(item => item.type !== 'banner' && item.type !== 'input')) {
      const lines = createLineCache().lines(history, (stdout.columns ?? 80) - 1, { symbols, color, wide: symbols.wide });
      stdout.write(lines.join('\n') + '\n');
    }
    if (!(result instanceof Error)) return result;
    await finishInPlain(session, opts, result);
    return 'plain';
  } finally {
    session.dispose();
  }
}

import readline from 'node:readline';
import { render } from 'ink';
import type { Engine } from '../core/engine.js';
import { formatFallbackQuestion } from '../core/report.js';
import { ReplApp } from './ReplApp.js';
import { UiUnavailableError } from './run.js';
import { watchResize } from './resize.js';
import { Session } from './session.js';
import { pickSymbols } from './theme.js';

export { UiUnavailableError };

export interface ReplOptions {
  engine: Engine;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  printLine: (line: string) => void;
  /** 启动时直接接上这个项目上一次的会话。 */
  continueLast?: boolean | string;
}

/** 卸载之后仍可能有排队的任务需要确认，用原终端逐行提问。 */
export async function finishInPlain(session: Session, opts: ReplOptions, error: Error) {
  opts.printLine(`界面显示出错（${error.message}），改用逐行交互。`);
  const { runningJobId, queued } = session.getSnapshot();
  if (!runningJobId && !queued) return session.whenIdle();
  const off = opts.engine.onProgress(event => {
    if (event.kind !== 'activity' && event.kind !== 'quota' && event.kind !== 'usage' && event.jobId === session.getSnapshot().runningJobId) opts.printLine(`[${event.jobId}] ${event.text}`);
  });
  let prompt: readline.Interface | undefined;
  function checkPlan() {
    const { plan } = session.getSnapshot();
    if (!plan || prompt) return;
    // 角色名的显示本身也可能是渲染出错的原因，降级时直接显示计划中的角色标识。
    opts.printLine(['这份计划会改动文件：', plan.summary, ...plan.steps.map((step, i) =>
      `${i + 1}. [${step.role}${step.role === opts.engine.roles.leadRole ? '自己做' : ''}，${step.writes ? '改文件' : '只读'}] ${step.task}`), plan.finish].filter(Boolean).join('\n'));
    const rl = readline.createInterface({ input: opts.stdin, output: opts.stdout });
    prompt = rl;
    rl.once('close', () => {
      prompt = undefined;
      session.decidePlan(false);
    });
    rl.question('执行吗？(y/N) ', answer => {
      session.decidePlan(['y', 'yes', '确认'].includes(answer.trim().toLowerCase()));
      rl.close();
    });
  }
  function checkAsk() {
    const { ask } = session.getSnapshot();
    if (!ask || prompt) return;
    const rl = readline.createInterface({ input: opts.stdin, output: opts.stdout });
    prompt = rl;
    rl.once('close', () => {
      prompt = undefined;
      session.decideFallback(false);
    });
    rl.question(formatFallbackQuestion(ask).join('') + '(y/N) ', answer => {
      session.decideFallback(['y', 'yes', '确认'].includes(answer.trim().toLowerCase()));
      rl.close();
    });
  }
  const stop = session.subscribe(() => { checkPlan(); checkAsk(); });
  try {
    checkPlan();
    checkAsk();
    await session.whenIdle();
  } finally {
    stop();
    off();
    prompt?.close();
  }
}

export async function runReplUi(opts: ReplOptions): Promise<'exit' | 'plain'> {
  const { engine, stdin, stdout, env } = opts;
  const color = !!stdout.isTTY && !env.NO_COLOR;
  const session = new Session({ engine, color, env, continueLast: opts.continueLast });
  let app: ReturnType<typeof render> | undefined;
  let finish!: (result: Error | 'exit' | 'plain') => void;
  const ended = new Promise<Error | 'exit' | 'plain'>(resolve => { finish = resolve; });
  let mountError: Error | undefined;
  let mounted = false;
  let stopResize: (() => void) | undefined;
  const symbols = pickSymbols(env);
  function screen(suspended: boolean) {
    return <ReplApp session={session} symbols={symbols} color={color} onExit={finish} onError={onError}
      suspended={suspended} />;
  }
  function unmount() {
    stopResize?.();
    stopResize = undefined;
    app?.unmount();
    app = undefined;
  }
  function onError(error: Error) {
    if (!mounted) mountError = error;
    finish(error);
  }
  try {
    await session.start();
    try {
      app = render(screen(false),
        { stdout, stdin, kittyKeyboard: { mode: 'auto' }, exitOnCtrlC: false, patchConsole: false, maxFps: 15 });
      await app.waitUntilRenderFlush();
      if (mountError) throw mountError;
      mounted = true;
      stopResize = watchResize(stdout, {
        onStart: () => app?.rerender(screen(true)),
        onSettle: () => app?.rerender(screen(false)),
      });
    } catch (error) {
      throw new UiUnavailableError(error instanceof Error ? error.message : String(error));
    }
    // 同时接住错误边界之外的终端错误，以及终端自行关闭。
    void app.waitUntilExit().then(() => finish('exit'), error => finish(error as Error));
    const result = await ended;
    unmount();
    if (!(result instanceof Error)) return result;
    await finishInPlain(session, opts, result);
    return 'plain';
  } finally {
    unmount();
    session.dispose();
  }
}

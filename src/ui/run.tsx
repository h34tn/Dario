import { render } from 'ink';
import type { Engine } from '../core/engine.js';
import { formatFallbackQuestion } from '../core/report.js';
import { STATUS_LABEL, type FallbackQuestion, type Job, type ProgressEvent } from '../core/types.js';
import { EMPTY_FEED, markStopping, reduceFeed, shortRole } from './feed.js';
import { colorEnabled } from './mode.js';
import { paint, pickSymbols } from './theme.js';
import type { FallbackPromptProps } from './FallbackPrompt.js';
import type { PlanPromptProps } from './PlanPrompt.js';
import { watchResize } from './resize.js';
import { RunApp } from './RunApp.js';

export interface LiveRunOptions {
  engine: Engine;
  job: Job;
  resume: boolean;
  autoApprove: boolean;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WriteStream;
  printPlain: (event: ProgressEvent) => void;
  askPlain?: (question: string) => Promise<string>;
  notice: (line: string) => void;
}

export class UiUnavailableError extends Error {}

export function formatLiveSummary(job: Job, color: boolean): string {
  const tone = job.status === 'done' ? 'done' : job.status === 'awaiting_approval' ? 'warn' : 'fail';
  const lines = ['', paint(tone, `[${job.id}] ${STATUS_LABEL[job.status]}`, color)];
  const result = job.result;
  if (result?.changedFiles.length) lines.push(`改动的文件（${result.changedFiles.length}）：${result.changedFiles.join('、')}`);
  if (result?.branch) lines.push(`产出所在分支：${result.branch}`);
  if (result?.warnings.length) {
    lines.push(paint('warn', '注意：', color), ...result.warnings.map(w => paint('warn', `  - ${w}`, color)));
  }
  return lines.join('\n');
}

export async function runLive(opts: LiveRunOptions): Promise<Job> {
  const { engine, job, stdin, stderr } = opts;
  const color = colorEnabled({ stderrIsTTY: !!stderr.isTTY, env: opts.env });
  const symbols = pickSymbols(opts.env);
  const roleLabel = (id: string) => engine.roles.label(id);
  let title: string;
  let feed = EMPTY_FEED;
  let prompt: PlanPromptProps | undefined;
  let ask: Omit<FallbackPromptProps, 'symbols'> | undefined;
  let asking: FallbackQuestion | undefined;
  let instance: ReturnType<typeof render> | undefined;
  let displayError: Error | undefined;
  let started = false;
  let suspended = false;

  const agreed = (answer: string | undefined) => ['y', 'yes', '确认'].includes(answer?.trim().toLowerCase() ?? '');
  async function askPlain() {
    return agreed(await opts.askPlain?.('这份计划会改动文件，执行吗？(y/N) '));
  }
  async function askFallbackPlain(question: FallbackQuestion) {
    return agreed(await opts.askPlain?.(`[${question.jobId}] ${formatFallbackQuestion(question).join('')}(y/N) `));
  }

  function onError(error: Error) {
    if (displayError) return;
    displayError = error;
    if (!started) return;
    // 错误边界在 React 提交期间回调，等它返回后再卸载。
    queueMicrotask(() => {
      instance?.unmount();
      opts.notice(`界面显示出错（${error.message}），改用纯文本输出。`);
      const pending = prompt;
      if (pending) void askPlain().then(pending.onDecide, () => pending.onDecide(false));
      const waiting = ask;
      if (waiting && asking) void askFallbackPlain(asking).then(waiting.onDecide, () => waiting.onDecide(false));
    });
  }

  function onInterrupt() {
    if (feed.stopping) process.exit(130);
    feed = markStopping(feed);
    update();
    try { engine.cancel(job.id); } catch { /* 任务已经结束 */ }
  }

  function screen() {
    return <RunApp jobId={job.id} title={title} feed={feed} symbols={symbols} color={color}
      prompt={prompt} ask={ask} suspended={suspended} inputEnabled={!!stdin.isTTY} onError={onError} onInterrupt={onInterrupt} />;
  }

  function update() {
    if (displayError) return;
    try { instance?.rerender(screen()); } catch (error) { onError(error as Error); }
  }

  async function confirm(record: Job): Promise<boolean> {
    if (displayError) return askPlain();
    const plan = record.plan;
    if (!plan) return false;
    return new Promise(resolve => {
      prompt = { plan, roleLabel: id => engine.roles.label(id, 'plan'), color, onDecide: approved => {
        prompt = undefined;
        update();
        resolve(approved);
      } };
      update();
    });
  }

  async function confirmFallback(question: FallbackQuestion): Promise<boolean> {
    if (displayError) return askFallbackPlain(question);
    return new Promise(resolve => {
      asking = question;
      ask = { question, color, onDecide: approved => {
        ask = undefined;
        asking = undefined;
        update();
        resolve(approved);
      } };
      update();
    });
  }

  try {
    const owner = job.role ? `交给 ${shortRole(roleLabel(job.role))}` : '主控安排';
    title = `${owner} · ${job.task.split(/\r?\n/, 1)[0]}`;
    instance = render(screen(), { stdout: stderr, stdin, exitOnCtrlC: false, patchConsole: false, maxFps: 10, interactive: true });
    await instance.waitUntilRenderFlush();
    if (displayError) throw displayError;
  } catch (error) {
    instance?.unmount();
    throw new UiUnavailableError(error instanceof Error ? error.message : String(error));
  }

  started = true;
  function setSuspended(value: boolean) {
    if (displayError) return;
    suspended = value;
    update();
  }
  const stopResize = watchResize(stderr, {
    onStart: () => setSuspended(true),
    onSettle: () => setSuspended(false),
  });
  const unsubscribe = engine.onProgress(event => {
    if (event.jobId !== job.id) return;
    if (displayError) return opts.printPlain(event);
    const next = reduceFeed(feed, event, Date.now());
    if (next === feed) return;
    feed = next;
    update();
  });
  try {
    // --yes 视为事先同意换人；标准输入没有连着终端时没法询问
    const fallback = opts.autoApprove ? async () => true : stdin.isTTY ? confirmFallback : undefined;
    const result = opts.resume ? await engine.approve(job.id, { confirmFallback: fallback }) : await engine.advance(job, {
      autoApprove: opts.autoApprove, confirm: stdin.isTTY ? confirm : undefined, confirmFallback: fallback,
    });
    if (!displayError) {
      try { await instance.waitUntilRenderFlush(); } catch (error) { onError(error as Error); }
    }
    return result;
  } finally {
    stopResize();
    unsubscribe();
    instance.unmount();
  }
}

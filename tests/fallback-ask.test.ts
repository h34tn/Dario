import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRepl } from '../src/cli/repl.js';
import { createApp } from '../src/compose.js';
import { formatFallbackQuestion } from '../src/core/report.js';
import { exitCodeForJob, type FallbackQuestion } from '../src/core/types.js';
import { plan, Sandbox, verdict } from './helpers.js';

const ASK_ROLES = `
roles:
  lead: { alias: [主控], candidates: [a1], access: read-only }
  coder: { alias: [实现], candidates: [a2, a3], access: write }
  reviewer: { alias: [审查], candidates: [a3, a2], access: read-only }
fallback: ask
`;
/** 额度用尽：进程失败，报错文字被判为"不可用"。 */
const LIMIT = { exit: 1, stderr: "You've hit your usage limit · resets 6pm" };
const origin = { channel: 'terminal', senderId: '测试' };

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox({ git: true, roles: ASK_ROLES, agentsExtra: { agents: { a2: { model: 'model-a2' }, a3: { model: 'model-a3' } } } });
});
afterEach(() => sb?.cleanup());

const engine = async () => (await createApp({ cwd: sb.project, env: sb.env() })).engine;
const names = (): string[] => sb.calls().map((c) => c.name);

describe('fallback: ask —— 换人之前先问', () => {
  it('问题里带着谁不可用、原因和备选的具体模型；同意后由备选继续', async () => {
    sb.setScenario({ a2: [LIMIT], a3: [{ text: 'a3 做完了' }] });
    const confirmFallback = vi.fn(async (_q: FallbackQuestion) => true);
    const job = await (await engine()).submit({ task: '任务', role: 'coder', origin, confirmFallback });
    expect(confirmFallback).toHaveBeenCalledExactlyOnceWith({
      jobId: job.id,
      role: 'coder',
      roleLabel: '实现（coder）',
      from: [{ agent: 'a2', model: 'model-a2', reason: "You've hit your usage limit · resets 6pm" }],
      to: { agent: 'a3', model: 'model-a3' },
    });
    expect(formatFallbackQuestion(confirmFallback.mock.calls[0]![0])).toEqual([
      "实现的担当者 a2（model-a2） 不可用（You've hit your usage limit · resets 6pm）。",
      '改用备选 a3（model-a3） 继续这个任务吗？',
    ]);
    expect(job.status).toBe('done');
    expect(job.result?.conclusion).toBe('a3 做完了');
    expect(job.result?.fallbackHappened).toBe(true);
    expect(job.fallbackApproved).toEqual(['a2>a3']);
    expect(names()).toEqual(['a2', 'a3']);
  });

  it('不同意：不启动备选，任务停止并说明原因，退出码 3', async () => {
    sb.setScenario({ a2: [LIMIT], a3: [{ text: '不该被调用' }] });
    const job = await (await engine()).submit({ task: '任务', role: 'coder', origin, confirmFallback: async () => false });
    expect(job.status).toBe('failed');
    expect(job.failureCode).toBe('all_unavailable');
    expect(exitCodeForJob(job)).toBe(3);
    expect(job.result?.conclusion).toContain('a2 不可用');
    expect(job.result?.conclusion).toContain('没有同意改用 a3');
    expect(names()).toEqual(['a2']);
  });

  it('等回答的时间不算进这一步的耗时', async () => {
    sb.setScenario({ a2: [LIMIT], a3: [{ text: 'ok' }] });
    const started = Date.now();
    const job = await (await engine()).submit({
      task: '任务', role: 'coder', origin,
      confirmFallback: () => new Promise((resolve) => setTimeout(() => resolve(true), 1500)),
    });
    expect(job.status).toBe('done');
    expect(job.steps[0]!.durationMs).toBeLessThanOrEqual(Date.now() - started - 1400);
  });

  it('首选还在冷却期里，新任务一上来就要用备选：同样先问，不再去试首选', async () => {
    sb.setScenario({ a2: [LIMIT], a3: [{ text: '第一个' }, { text: '第二个' }] });
    const e = await engine();
    await e.submit({ task: '任务一', role: 'coder', origin, confirmFallback: async () => true });
    const confirmFallback = vi.fn(async (_q: FallbackQuestion) => true);
    const second = await e.submit({ task: '任务二', role: 'coder', origin, confirmFallback });
    expect(confirmFallback).toHaveBeenCalledOnce();
    expect(confirmFallback.mock.calls[0]![0]).toMatchObject({
      from: [{ agent: 'a2', model: 'model-a2', reason: "You've hit your usage limit · resets 6pm" }],
      to: { agent: 'a3', model: 'model-a3' },
    });
    expect(second.status).toBe('done');
    expect(names()).toEqual(['a2', 'a3', 'a3']);
    // 冷却期里不同意，同样停下
    const third = await e.submit({ task: '任务三', role: 'coder', origin, confirmFallback: async () => false });
    expect(third.status).toBe('failed');
    expect(third.result?.conclusion).toContain('没有同意改用 a3');
    expect(names()).toHaveLength(3);
  });

  it('同一个任务里同一对换人只问一次', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '第一步', writes: true }, { role: 'coder', task: '第二步', writes: true }]) }, { text: '汇总' }],
      a2: [LIMIT],
      a3: [{ text: '一', files: [{ path: 'a.txt', content: '1' }] }, { text: '二', files: [{ path: 'b.txt', content: '2' }] }, { text: verdict(true) }],
    });
    const confirmFallback = vi.fn(async (_q: FallbackQuestion) => true);
    const job = await (await engine()).submit({ task: '任务', origin, autoApprove: true, confirmFallback });
    expect(job.status).toBe('done');
    // 第一步执行中发现 a2 不可用问了一次；第二步 a2 在冷却期里、审查的首选本来就是 a3，都不再问
    expect(confirmFallback).toHaveBeenCalledOnce();
    expect(job.steps.map((s) => `${s.kind}:${s.agent}`)).toEqual(['plan:a1', 'step:a3', 'step:a3', 'review:a3', 'summary:a1']);
  });

  it('没配置、已停用的候选被跳过不算换人，不询问', async () => {
    sb.writeRoles(ASK_ROLES.replace('candidates: [a2, a3], access: write', 'candidates: [ghost, a2], access: write'));
    sb.setScenario({ a2: [{ text: 'a2 做完了' }] });
    const confirmFallback = vi.fn(async () => true);
    const job = await (await engine()).submit({ task: '任务', role: 'coder', origin, confirmFallback });
    expect(job.status).toBe('done');
    expect(confirmFallback).not.toHaveBeenCalled();
  });

  it('没有办法询问时不换人，并说明怎么办；--yes 视为事先同意', async () => {
    sb.setScenario({ a2: [LIMIT], a3: [{ text: 'a3 做完了' }] });
    const stopped = await sb.runJson(['-p', '--to', 'coder', '任务']);
    expect(stopped.code).toBe(3);
    expect(stopped.json.conclusion).toContain('a2 不可用');
    expect(stopped.json.conclusion).toContain('没法询问');
    expect(stopped.json.conclusion).toContain('--yes');
    expect(names()).toEqual(['a2']);

    // 上一次已经把 a2 标为暂时不可用，这次一上来就要用备选
    const agreed = await sb.runJson(['-p', '--yes', '--to', 'coder', '任务']);
    expect(agreed.code).toBe(0);
    expect(agreed.json.conclusion).toBe('a3 做完了');
    expect(agreed.json.fallback_happened).toBe(true);
    expect(names()).toEqual(['a2', 'a3']);
  });

  it('角色表里写明换人方式；审计日志记下每次询问和回答', async () => {
    expect((await sb.cli(['roles'])).out).toContain('不可用时：先询问，同意后换下一家');
    sb.setScenario({ a2: [LIMIT], a3: [{ text: 'ok' }] });
    const app = await createApp({ cwd: sb.project, env: sb.env() });
    const job = await app.engine.submit({ task: '任务', role: 'coder', origin, confirmFallback: async () => true });
    const asked = (await import('node:fs')).readFileSync(`${sb.home}/state/audit.log`, 'utf8')
      .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'fallback_ask');
    expect(asked).toMatchObject([{ job: job.id, role: 'coder', from: ['a2'], to: 'a3', approved: true }]);
  });
});

describe('fallback: ask —— 逐行交互', () => {
  async function session(lines: string[]): Promise<string> {
    const app = await createApp({ cwd: sb.project, env: sb.env() });
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const out: string[] = [];
    const done = runRepl(app.engine, (line) => out.push(line), { input, output });
    input.end(`${lines.join('\n')}\n`);
    expect(await done).toBe(0);
    return out.join('\n');
  }

  it('当场问一句，回答 y 才换人', async () => {
    sb.setScenario({ a2: [LIMIT], a3: [{ text: 'a3 做完了' }] });
    const declined = await session(['/to 实现 做点事', 'n']);
    expect(declined).toContain('实现的担当者 a2（model-a2） 不可用');
    expect(declined).toContain('没有同意改用 a3');
    expect(names()).toEqual(['a2']);

    sb.setScenario({ a3: [{ text: 'a3 做完了' }] });
    const accepted = await session(['/to 实现 做点事', 'y']);
    expect(accepted).toContain('a3 做完了');
    expect(names()).toEqual(['a3']);
  });
});

describe('其他换人方式不受影响', () => {
  it('fallback: auto 照旧直接换人，不询问', async () => {
    sb.writeRoles(ASK_ROLES.replace('fallback: ask', 'fallback: auto'));
    sb.setScenario({ a2: [LIMIT], a3: [{ text: 'a3 做完了' }] });
    const confirmFallback = vi.fn(async () => false);
    const job = await (await engine()).submit({ task: '任务', role: 'coder', origin, confirmFallback });
    expect(job.status).toBe('done');
    expect(confirmFallback).not.toHaveBeenCalled();
    expect((await sb.runJson(['-p', '--to', 'coder', '任务'])).code).toBe(0);
  });
});

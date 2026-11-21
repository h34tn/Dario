import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/compose.js';
import { parsePlan, proseBeforeJson } from '../src/core/plan.js';
import { plan, Sandbox, verdict } from './helpers.js';

const origin = { channel: 'terminal', senderId: '测试' };
const fence = '```';
const block = (o: unknown): string => `${fence}json\n${JSON.stringify(o)}\n${fence}`;

describe('提问类任务：答案只写一遍', () => {
  it('取 JSON 之前的正文作为答案', () => {
    const text = `## 结论\n\n| 项 | 值 |\n|---|---|\n| 甲 | 1 |\n\n${block({ summary: '概括', answer: null, steps: [] })}`;
    expect(proseBeforeJson(text)).toBe('## 结论\n\n| 项 | 值 |\n|---|---|\n| 甲 | 1 |');
    // 正文里另有代码块时，只去掉最后那个 JSON 计划
    const withCode = `先看这段：\n${fence}ts\nconst a = 1;\n${fence}\n结论是甲。\n\n${block({ summary: '', steps: [] })}`;
    expect(proseBeforeJson(withCode)).toContain('const a = 1;');
    expect(proseBeforeJson(withCode)).not.toContain('"steps"');
    // JSON 没有放进代码块
    expect(proseBeforeJson('答案是 42。\n{"summary":"","answer":null,"steps":[]}')).toBe('答案是 42。');
  });

  it('没有步骤的计划：答案来自正文；JSON 里另写了 answer 的旧写法仍以它为准', async () => {
    const sb = new Sandbox({ git: false });
    try {
      // 借沙箱里的角色表做校验
      const { engine, project } = await createApp({ cwd: sb.project, env: sb.env() });
      const ctx = { roles: engine.roles, ...project.settings };
      const fromProse = parsePlan(`答案在这里。\n\n${block({ summary: '概括', answer: null, steps: [] })}`, ctx);
      expect(fromProse).toMatchObject({ plan: { answer: '答案在这里。', steps: [] } });
      const legacy = parsePlan(`思路。\n\n${block({ summary: '概括', answer: '旧写法的答案', steps: [] })}`, ctx);
      expect(legacy).toMatchObject({ plan: { answer: '旧写法的答案' } });
      // 有步骤时正文是思路，不当作答案
      const withSteps = parsePlan(plan([{ role: 'coder', task: '做事', writes: true }]), ctx);
      expect(withSteps).toMatchObject({ plan: { answer: null } });
    } finally {
      sb.cleanup();
    }
  });

  it('主控的说明要求答案写在正文里，不在 JSON 里重复；结论取自正文', async () => {
    const sb = new Sandbox({ git: true, resumable: true });
    try {
      sb.setScenario({ a1: [{ text: `雾用的是 Lit 材质，开销在光照和阴影。\n\n${block({ summary: '直接回答', answer: null, steps: [] })}` }] });
      const r = await sb.runJson(['-p', '雾为什么贵']);
      expect(r.code).toBe(0);
      expect(r.json.conclusion).toBe('雾用的是 Lit 材质，开销在光照和阴影。');
      expect(sb.calls()[0]!.prompt).toContain('答案只写这一遍');
    } finally {
      sb.cleanup();
    }
  });
});

describe('上文：带过来的会话已经知道的不再重发', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = new Sandbox({ git: true, resumable: true });
  });
  afterEach(() => sb?.cleanup());
  const engine = async () => (await createApp({ cwd: sb.project, env: sb.env() })).engine;
  const answer = (text: string): string => `${text}\n\n${block({ summary: '', answer: null, steps: [] })}`;
  const CTX = '同一次会话里上一个任务的结论：结论正文 QWERTY';

  it('会话记下最近在哪个任务里干过活', async () => {
    sb.setScenario({ a1: [{ text: answer('答一') }] });
    const first = await (await engine()).submit({ task: '问题一', origin });
    expect(first.sessions!.lead!.job).toBe(first.id);
  });

  it('主控连续回答：上一个任务的结论就是它自己写的，第二个任务不再附上文', async () => {
    sb.setScenario({ a1: [{ text: answer('答一') }, { text: answer('答二') }] });
    const e = await engine();
    const first = await e.submit({ task: '问题一', origin });
    const second = await e.submit({ task: '问题二', origin, sessions: first.sessions, context: CTX, contextJob: first.id });
    expect(second.steps[0]!.resumed).toBe(true);
    const prompt = sb.calls()[1]!.prompt;
    expect(prompt).toContain('问题二');
    expect(prompt).not.toContain('QWERTY');
    expect(prompt).not.toContain('# 上文');
  });

  it('上文来自这个会话没参加过的任务：照常附上', async () => {
    sb.setScenario({ a1: [{ text: answer('答一') }, { text: answer('答三') }], a2: [{ text: '执行者单独做完了' }] });
    const e = await engine();
    const first = await e.submit({ task: '问题一', origin });
    // 第二个任务直接交给执行者，主控没有参加
    const second = await e.submit({ task: '直派的活', role: 'coder', origin, sessions: first.sessions, context: CTX, contextJob: first.id });
    // 执行者是新开的会话，它不知道上一个任务，收到上文
    expect(sb.calls()[1]!.prompt).toContain('QWERTY');
    // 第三个任务回到主控：上文是第二个任务的结论，主控不知道，要给
    const third = await e.submit({ task: '问题三', origin, sessions: second.sessions, context: '第二个任务的结论 ZXCVB', contextJob: second.id });
    expect(third.steps[0]!.resumed).toBe(true);
    expect(sb.calls()[2]!.prompt).toContain('ZXCVB');
  });

  it('换了人新开的会话：照常收到上文', async () => {
    sb.setScenario({ a1: [{ text: answer('答一') }], a2: [{ text: answer('答二') }] });
    const e = await engine();
    const first = await e.submit({ task: '问题一', origin });
    e.setRole('lead', 'a2', false);
    await e.submit({ task: '问题二', origin, sessions: first.sessions, context: CTX, contextJob: first.id });
    expect(sb.calls()[1]!.prompt).toContain('QWERTY');
  });

  it('主控分派的任务：参加过上一个任务的执行者和审查者都不再收到那个任务的结论', async () => {
    const onePlan = (task: string): string => plan([{ role: 'coder', task, writes: true }]);
    sb.setScenario({
      a1: [{ text: onePlan('实现甲') }, { text: '汇总甲' }, { text: onePlan('实现乙') }, { text: '汇总乙' }],
      a2: [{ text: '甲写好了', files: [{ path: 'a.txt', content: '1' }] }, { text: '乙写好了', files: [{ path: 'b.txt', content: '2' }] }],
      a3: [{ text: verdict(true) }, { text: verdict(true) }],
    });
    const e = await engine();
    const first = await e.submit({ task: '任务甲', origin, autoApprove: true });
    const second = await e.submit({ task: '任务乙', origin, autoApprove: true, sessions: first.sessions, context: CTX, contextJob: first.id });
    expect(second.status).toBe('done');
    const [plan2, step2, review2] = sb.calls().slice(4).map((c) => c.prompt);
    for (const p of [plan2!, step2!, review2!]) expect(p).not.toContain('QWERTY');
    expect(step2).toContain('实现乙');
  });
});

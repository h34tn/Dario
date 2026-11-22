import { afterEach, describe, expect, it } from 'vitest';
import type { SuperviseSettings } from '../src/core/config.js';
import { parseLeadDecision } from '../src/core/plan.js';
import { StepWatch } from '../src/core/watch.js';
import { parseStreamJsonResult } from '../src/plugin.js';
import { Sandbox } from './helpers.js';

/** 主控的判断：正文加一个 JSON 代码块。 */
function decision(action: 'continue' | 'correct' | 'stop', message = '', extra: Record<string, unknown> = {}): string {
  return `看了一下现场。\n\n\`\`\`json\n${JSON.stringify({ action, message, ...extra })}\n\`\`\``;
}

describe('主控的判断', () => {
  it('解析：三种判断，默认静默 10 分钟；纠偏必须写说明；格式不对时没有判断', () => {
    expect(parseLeadDecision(decision('continue'))).toEqual({ action: 'continue', message: '', snoozeMinutes: 10 });
    expect(parseLeadDecision(decision('continue', '测试本来就慢', { snooze_minutes: 5 }))).toEqual({ action: 'continue', message: '测试本来就慢', snoozeMinutes: 5 });
    expect(parseLeadDecision(decision('correct', '  改用增量构建 '))).toEqual({ action: 'correct', message: '改用增量构建', snoozeMinutes: 10 });
    expect(parseLeadDecision(decision('correct', '  '))).toBeUndefined();
    expect(parseLeadDecision(decision('stop', '方向错了'))?.action).toBe('stop');
    expect(parseLeadDecision('我觉得还行')).toBeUndefined();
    expect(parseLeadDecision('```json\n{"action":"retry"}\n```')).toBeUndefined();
  });

  it('Claude Code 风格的输出被中断、没有 result 记录时，会话号取自开头的 init 记录', () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"s-123"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"sleep 100"}}]}}',
    ].join('\n');
    expect(parseStreamJsonResult(stdout)).toMatchObject({ isError: true, sessionId: 's-123' });
    expect(parseStreamJsonResult('启动失败')).not.toHaveProperty('sessionId');
  });

  it('静默：主控判断继续之后，这条规则在静默期内不再报，过了静默期照常', () => {
    let t = 0;
    const rules = {
      idle: { minutes: 1, commandMinutes: 1, action: 'ask_lead' },
      outOfRoots: { action: 'off' }, forbiddenCommands: { patterns: [], action: 'off' }, offPlan: { action: 'off' },
      loop: { action: 'ask_lead', repeatCommand: 2, repeatRead: 5, requestsWithoutEdit: 20 },
      usage: { action: 'off', factor: 3, minSamples: 5 },
      maxInterventions: 2, consultTimeoutMinutes: 3,
    } as SuperviseSettings;
    const w = new StepWatch({ rules, writeRoots: [], streams: true, now: () => t });
    w.line();
    w.snooze('idle', 5 * 60000);
    t = 4 * 60000;
    expect(w.tick()).toEqual([]);
    t = 5 * 60000;
    expect(w.tick()).toMatchObject([{ rule: 'idle', action: 'ask_lead' }]);
    // 别的规则不受影响
    w.activity({ kind: 'run', target: 'npm test' });
    expect(w.activity({ kind: 'run', target: 'npm test' })).toMatchObject([{ rule: 'loop' }]);
    expect(w.snapshot()).toMatchObject({ recent: [{ kind: 'run' }, { kind: 'run' }], edited: [] });
  });
});

describe('干活监控：交给主控判断', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  /** 0.005 分钟是 300 毫秒。 */
  const yaml = (extra = ''): string => `supervise:\n  idle: { minutes: 0.005, action: ask_lead }\n${extra}`;

  it('纠偏：中断干活的一方，接着它的会话发去主控的提醒，这一步照常做完', async () => {
    sb = new Sandbox({ activity: true, resumable: true, projectYaml: yaml() });
    sb.setScenario({
      a1: [{ text: decision('correct', '别再等了，直接写结论') }],
      a2: [{ stream: [{ line: '开始' }], hang: true }, { text: '按提醒做完了' }],
    });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    const step = r.json.steps[0];
    expect(step.outcome).toBe('ok');
    expect(step.alerts).toMatchObject([{ rule: 'idle', action: 'ask_lead', decision: { action: 'correct', message: '别再等了，直接写结论' } }]);
    expect(step.consults).toMatchObject([{ rule: 'idle', agent: 'a1', outcome: 'ok', decision: { action: 'correct' } }]);
    expect(r.json.phases.find((p: any) => p.kind === 'supervise')).toMatchObject({ steps: 1 });

    const calls = sb.calls();
    const lead = calls.find((c) => c.name === 'a1')!;
    expect(lead.access).toBe('read-only');
    expect(lead.prompt).toContain('监控发现的情况');
    const fix = calls.filter((c) => c.name === 'a2')[1]!;
    expect(fix.argv).toEqual(expect.arrayContaining(['--resume', 'a2-s0']));
    expect(fix.prompt).toContain('# 主控提醒');
    expect(fix.prompt).toContain('别再等了，直接写结论');
    expect(r.json.warnings.some((w: string) => w.includes('主控要求纠偏：别再等了，直接写结论'))).toBe(true);
  });

  it('中止：这一步算未完成，任务停下', async () => {
    sb = new Sandbox({ activity: true, resumable: true, projectYaml: yaml() });
    sb.setScenario({ a1: [{ text: decision('stop', '方向错了') }], a2: [{ stream: [{ line: '开始' }], hang: true }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(1);
    expect(r.json.steps[0]).toMatchObject({ outcome: 'task_failed', reason: '主控中止：方向错了' });
    expect(sb.calls().filter((c) => c.name === 'a2')).toHaveLength(1);
  });

  it('继续：不打断，这条规则进入静默期，之后的静默不再报', async () => {
    sb = new Sandbox({ activity: true, resumable: true, projectYaml: yaml() });
    sb.setScenario({
      a1: [{ text: decision('continue', '测试本来就慢') }],
      a2: [{ stream: [{ line: '开始' }, { line: '中间', delayMs: 4000 }, { line: '结束', delayMs: 900 }], text: '做完了' }],
    });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    const step = r.json.steps[0];
    expect(step.alerts).toHaveLength(1);
    expect(step.alerts[0].decision).toEqual({ action: 'continue', message: '测试本来就慢' });
    expect(sb.calls().filter((c) => c.name === 'a2')).toHaveLength(1);
  });

  it('主控的回复里没有可用的判断：只提示，不打断', async () => {
    sb = new Sandbox({ activity: true, resumable: true, projectYaml: yaml() });
    sb.setScenario({
      a1: [{ text: '我觉得还行' }],
      a2: [{ stream: [{ line: '开始' }, { line: '结束', delayMs: 4000 }], text: '做完了' }],
    });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    const step = r.json.steps[0];
    expect(step.alerts[0]).toMatchObject({ action: 'ask_lead', decision: null });
    expect(step.consults).toMatchObject([{ outcome: 'unparsed' }]);
  });

  it('纠偏次数到了上限，再要纠偏就中止', async () => {
    sb = new Sandbox({ activity: true, resumable: true, projectYaml: yaml('  max_interventions: 1\n') });
    sb.setScenario({ a1: [{ text: decision('correct', '换个办法') }], a2: [{ stream: [{ line: '开始' }], hang: true }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(1);
    expect(r.json.steps[0].outcome).toBe('task_failed');
    expect(r.json.steps[0].reason).toContain('达到上限');
    expect(r.json.steps[0].consults).toHaveLength(2);
    expect(sb.calls().filter((c) => c.name === 'a2')).toHaveLength(2);
  });

  it('干活的一方不能续接会话时，纠偏改为新开会话，带上完整的任务说明', async () => {
    sb = new Sandbox({ activity: true, projectYaml: yaml() });
    sb.setScenario({
      a1: [{ text: decision('correct', '先写测试') }],
      a2: [{ stream: [{ line: '开始' }], hang: true }, { text: '重做完了' }],
    });
    const r = await sb.runJson(['--to', 'coder', '原来的任务']);
    expect(r.code).toBe(0);
    const fix = sb.calls().filter((c) => c.name === 'a2')[1]!;
    expect(fix.argv).not.toContain('--resume');
    expect(fix.prompt).toContain('原来的任务');
    expect(fix.prompt).toContain('先写测试');
  });

  it('主控自己的步骤不请主控判断，只提示', async () => {
    sb = new Sandbox({ activity: true, resumable: true, projectYaml: yaml() });
    sb.setScenario({ a1: [{ stream: [{ line: '开始' }, { line: '结束', delayMs: 900 }], text: '看完了' }] });
    const r = await sb.runJson(['--to', 'lead', '看一下']);
    expect(r.code).toBe(0);
    const step = r.json.steps[0];
    expect(step.alerts[0].action).toBe('notify');
    expect(step.alerts[0].detail).toMatch(/（这一步由主控自己做，只提示）$/);
    expect(step.consults).toEqual([]);
  });

  it('禁用命令和偏离计划不能设为 ask_lead', async () => {
    for (const bad of ['  forbidden_commands: { patterns: ["x"], action: ask_lead }\n', '  off_plan: { action: ask_lead }\n']) {
      sb = new Sandbox({ projectYaml: `supervise:\n${bad}` });
      const r = await sb.cli(['check']);
      expect(r.code).toBe(2);
      sb.cleanup();
    }
  });
});

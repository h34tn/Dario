import { afterEach, describe, expect, it } from 'vitest';
import { usageBaseline } from '../src/core/baseline.js';
import type { SuperviseSettings } from '../src/core/config.js';
import { globToRegExp, inScope, normalizeScopePath, reworkScope } from '../src/core/scope.js';
import type { Job, StepRecord } from '../src/core/types.js';
import { StepWatch } from '../src/core/watch.js';
import { plan, Sandbox, verdict } from './helpers.js';

const OFF: SuperviseSettings = {
  idle: { minutes: 10, commandMinutes: 30, action: 'off' },
  outOfRoots: { action: 'off' },
  forbiddenCommands: { patterns: [], action: 'off' },
  offPlan: { action: 'off' },
  loop: { action: 'off', repeatCommand: 3, repeatRead: 5, requestsWithoutEdit: 20 },
  usage: { action: 'off', factor: 3, minSamples: 5 },
};

describe('计划的预计范围', () => {
  it('路径规范化：去掉空白、./ 和结尾的 /，反斜杠改成正斜杠', () => {
    expect(normalizeScopePath(' ./src\\core/ ')).toBe('src/core');
    expect(normalizeScopePath('././a.ts')).toBe('a.ts');
  });

  it('匹配：文件、目录、*、**、?', () => {
    expect(inScope('src/a.ts', ['src/a.ts'])).toBe(true);
    expect(inScope('src/core/a.ts', ['src'])).toBe(true);
    expect(inScope('srcx/a.ts', ['src'])).toBe(false);
    expect(inScope('src/a.ts', ['src/*.ts'])).toBe(true);
    expect(inScope('src/core/a.ts', ['src/*.ts'])).toBe(false);
    expect(inScope('src/core/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(inScope('src/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(inScope('docs/x/y.md', ['docs/**'])).toBe(true);
    expect(inScope('a1.ts', ['a?.ts'])).toBe(true);
    expect(inScope('a/1.ts', ['a?.ts'])).toBe(false);
    expect(inScope('a.ts', [])).toBe(false);
    expect(globToRegExp('a.b+(c)').test('a.b+(c)')).toBe(true);
  });

  it.runIf(process.platform === 'win32')('Windows 上不区分大小写', () => {
    expect(inScope('SRC/A.ts', ['src'])).toBe(true);
  });

  it('返工的范围是各改文件步骤范围之并；有一步没写范围就不检查', () => {
    const p = (steps: Array<{ writes: boolean; files?: string[] }>) => ({ summary: '', steps: steps.map((s) => ({ role: 'r', task: 't', ...s })) });
    expect(reworkScope(p([{ writes: true, files: ['src'] }, { writes: false }, { writes: true, files: ['tests', 'src'] }]))).toEqual(['src', 'tests']);
    expect(reworkScope(p([{ writes: true, files: ['src'] }, { writes: true }]))).toBeUndefined();
    expect(reworkScope(p([{ writes: false }]))).toBeUndefined();
    expect(reworkScope(undefined)).toBeUndefined();
  });
});

describe('用量基准', () => {
  const step = (kind: StepRecord['kind'], agent: string, input: number, cached: number, extra: Partial<StepRecord> = {}): StepRecord => ({
    index: 0, kind, role: 'r', access: 'write', agent, outcome: 'ok', attempts: [], durationMs: 1, text: '', changedFiles: [],
    tokens: { input, cachedInput: cached, output: 1 }, ...extra,
  });
  const job = (id: string, steps: StepRecord[], projectRoot = '/p'): Job => ({ id, projectRoot, steps } as unknown as Job);

  it('按项目、种类、AI 取做成了的步骤，新输入和请求次数各取中位数，正在进行的任务不算', () => {
    const jobs = [
      job('J1', [step('step', 'a', 100, 0, { tokens: { input: 100, cachedInput: 0, output: 1, requests: 4 } }), step('review', 'a', 9999, 0)]),
      job('J2', [step('step', 'a', 500, 200), step('step', 'b', 9999, 0)]),
      job('J3', [step('step', 'a', 700, 100, { outcome: 'task_failed' }), step('step', 'a', 400, 0, { tokens: { input: 400, cachedInput: 0, output: 1, requests: 8 } })]),
      job('J4', [step('step', 'a', 9999, 0)], '/other'),
      job('J5', [step('step', 'a', 9999, 0)]),
    ];
    expect(usageBaseline(jobs, { projectRoot: '/p', kind: 'step', agent: 'a', excludeJob: 'J5' })).toEqual({
      freshInput: { median: 300, samples: 3 },
      requests: { median: 6, samples: 2 },
    });
    expect(usageBaseline(jobs, { projectRoot: '/p', kind: 'summary', agent: 'a' })).toEqual({});
  });
});

describe('干活监控：偏离计划、原地打转、用量异常', () => {
  it('偏离计划：只检查有范围的步骤，同一个文件只报一次', () => {
    const rules = { ...OFF, offPlan: { action: 'notify' as const } };
    const w = new StepWatch({ rules, writeRoots: [], streams: true, scope: ['src', 'tests/**/*.test.ts'] });
    expect(w.activity({ kind: 'edit', target: 'src/a.ts' })).toEqual([]);
    expect(w.activity({ kind: 'edit', target: 'tests/x/a.test.ts' })).toEqual([]);
    expect(w.activity({ kind: 'edit', target: 'README.md' })).toMatchObject([{ rule: 'off_plan', action: 'notify', target: 'README.md', detail: '改动了计划范围之外的文件：README.md' }]);
    expect(w.activity({ kind: 'edit', target: 'README.md' })).toEqual([]);
    const noScope = new StepWatch({ rules, writeRoots: [], streams: true });
    expect(noScope.activity({ kind: 'edit', target: 'README.md' })).toEqual([]);
  });

  it('原地打转：同一条命令、同一个文件到阈值各报一次，改动之后重新计数', () => {
    const rules = { ...OFF, loop: { action: 'notify' as const, repeatCommand: 3, repeatRead: 2, requestsWithoutEdit: 20 } };
    const w = new StepWatch({ rules, writeRoots: [], streams: true });
    expect(w.activity({ kind: 'run', target: 'npm test' })).toEqual([]);
    expect(w.activity({ kind: 'run', target: 'npm  test ' })).toEqual([]);
    expect(w.activity({ kind: 'run', target: 'npm test' })).toMatchObject([{ rule: 'loop', detail: '同一条命令执行了 3 次：npm test，期间没有改动' }]);
    expect(w.activity({ kind: 'run', target: 'npm test' })).toEqual([]);
    expect(w.activity({ kind: 'read', target: 'a.ts' })).toEqual([]);
    expect(w.activity({ kind: 'read', target: './a.ts' })).toMatchObject([{ rule: 'loop', detail: '同一个文件读了 2 次：a.ts，期间没有改动' }]);
    // 改一下、再跑测试是正常的循环
    w.activity({ kind: 'edit', target: 'a.ts' });
    expect(w.activity({ kind: 'run', target: 'npm test' })).toEqual([]);
    expect(w.activity({ kind: 'run', target: 'npm test' })).toEqual([]);
    expect(w.activity({ kind: 'run', target: 'npm test' })).toHaveLength(1);
  });

  it('原地打转：可写步骤连续多次请求没有改动；只读步骤不查；工具不报请求次数时不查', () => {
    const rules = { ...OFF, loop: { ...OFF.loop, action: 'stop' as const, requestsWithoutEdit: 5 } };
    const tokens = (requests?: number) => ({ input: 1, cachedInput: 0, output: 1, ...(requests !== undefined && { requests }) });
    const w = new StepWatch({ rules, writeRoots: [], streams: true, access: 'write' });
    expect(w.usage(tokens(3))).toEqual([]);
    w.activity({ kind: 'edit', target: 'a.ts' });
    expect(w.usage(tokens(7))).toEqual([]);
    expect(w.usage(tokens(8))).toMatchObject([{ rule: 'loop', action: 'stop', detail: '连续 5 次请求没有新的改动' }]);
    expect(w.usage(tokens(9))).toEqual([]);
    const readOnly = new StepWatch({ rules, writeRoots: [], streams: true, access: 'read-only' });
    expect(readOnly.usage(tokens(100))).toEqual([]);
    expect(w.usage(tokens())).toEqual([]);
  });

  it('用量异常：超过中位数的倍数报一次；样本不足、中位数为 0、没有基准时不查', () => {
    const rules = { ...OFF, usage: { action: 'notify' as const, factor: 3, minSamples: 5 } };
    const baseline = { freshInput: { median: 1000, samples: 5 }, requests: { median: 4, samples: 4 } };
    const w = new StepWatch({ rules, writeRoots: [], streams: true, baseline });
    expect(w.usage({ input: 3500, cachedInput: 500, output: 1, requests: 100 })).toEqual([]);
    const [alert] = w.usage({ input: 4500, cachedInput: 500, output: 1, requests: 100 });
    expect(alert).toMatchObject({ rule: 'usage', detail: '新输入 4.0k，超过本项目同类步骤中位数 1.0k 的 3 倍（5 个样本）' });
    expect(w.usage({ input: 9000, cachedInput: 0, output: 1 })).toEqual([]);
    const zero = new StepWatch({ rules, writeRoots: [], streams: true, baseline: { freshInput: { median: 0, samples: 9 } } });
    expect(zero.usage({ input: 100, cachedInput: 0, output: 1 })).toEqual([]);
    expect(new StepWatch({ rules, writeRoots: [], streams: true }).usage({ input: 1e9, cachedInput: 0, output: 1 })).toEqual([]);
  });
});

describe('干活监控：二期运行中', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('计划带范围：交给执行方的说明里写明范围；运行中和结束后各补报范围外的改动；JSON 带出范围', async () => {
    sb = new Sandbox({ git: true, activity: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现功能', writes: true, files: ['./src/', 'tests/**'] }]) }, { text: '汇总' }],
      a2: [{
        files: [{ path: 'src/a.ts', content: 'a' }, { path: 'docs/x.md', content: 'x' }, { path: 'notes.txt', content: 'n' }],
        stream: [{ line: 'EDIT:src/a.ts' }, { line: 'EDIT:docs/x.md' }],
        text: '做完了',
      }],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.plan.steps[0].files).toEqual(['src', 'tests/**']);
    const step = r.json.steps.find((s: any) => s.kind === 'step');
    expect(step.alerts.map((a: any) => a.detail)).toEqual([
      '改动了计划范围之外的文件：docs/x.md',
      '改动了计划范围之外的文件：notes.txt（这一步结束后检查发现）',
    ]);
    expect(r.json.status).toBe('done');
    const prompt = sb.calls().find((c) => c.name === 'a2')!.prompt;
    expect(prompt).toContain('预计改动的范围（出计划时的估计）：src、tests/**。');
  });

  it('返工按各步范围之并检查；直派没有计划，不检查', async () => {
    sb = new Sandbox({ git: true, activity: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现功能', writes: true, files: ['src'] }]) }, { text: '汇总' }],
      a2: [
        { files: [{ path: 'src/a.ts', content: 'a' }], stream: [{ line: 'EDIT:src/a.ts' }], text: '第一版' },
        { files: [{ path: 'lib/b.ts', content: 'b' }], stream: [{ line: 'EDIT:lib/b.ts' }], text: '改好了' },
      ],
      a3: [{ text: verdict(false, ['还缺一处']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    const rework = r.json.steps.find((s: any) => s.kind === 'rework');
    expect(rework.alerts.map((a: any) => a.rule)).toEqual(['off_plan']);

    sb.setScenario({ a2: [{ files: [{ path: 'anywhere.txt', content: 'x' }], stream: [{ line: 'EDIT:anywhere.txt' }], text: '好了' }] });
    const direct = await sb.runJson(['--to', 'coder', '任务']);
    expect(direct.json.steps[0].alerts).toEqual([]);
  });

  it('原地打转设为 stop：同一条命令跑到阈值就中断这一步', async () => {
    sb = new Sandbox({ activity: true, projectYaml: 'supervise:\n  loop: { action: stop, repeat_command: 2 }\n' });
    sb.setScenario({ a2: [{ stream: [{ line: 'RUN:npm test' }, { line: 'RUN:npm test' }], hang: true }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(1);
    expect(r.json.steps[0].outcome).toBe('task_failed');
    expect(r.json.steps[0].alerts).toMatchObject([{ rule: 'loop', action: 'stop' }]);
  });

  it('用量异常：拿本项目同类步骤的历史比较，历史够了才检查', async () => {
    sb = new Sandbox({ resumable: true, projectYaml: 'supervise:\n  usage: { action: notify, factor: 2, min_samples: 2 }\n' });
    for (const input of [1000, 1200]) {
      sb.setScenario({ a2: [{ text: '好了', usage: [input, 0, 10] }] });
      const r = await sb.runJson(['--to', 'coder', '任务']);
      // 历史不够时不检查
      expect(r.json.steps[0].alerts).toEqual([]);
    }
    sb.setScenario({ a2: [{ text: '好了', usage: [5000, 0, 10] }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.json.steps[0].alerts.map((a: any) => a.detail)).toEqual(['新输入 5.0k，超过本项目同类步骤中位数 1.1k 的 2 倍（2 个样本）']);
  });

  it('偏离计划不能设为 stop', async () => {
    sb = new Sandbox({ projectYaml: 'supervise:\n  off_plan: { action: stop }\n' });
    const r = await sb.cli(['check']);
    expect(r.code).toBe(2);
    expect(r.err + r.out).toContain('off_plan');
  });
});

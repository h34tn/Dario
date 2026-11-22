import { afterEach, describe, expect, it } from 'vitest';
import type { SuperviseSettings } from '../src/core/config.js';
import { commandSegments, matchesCommand, StepWatch } from '../src/core/watch.js';
import { streamJsonActivities } from '../src/plugin.js';
import { Sandbox } from './helpers.js';

const RULES: SuperviseSettings = {
  idle: { minutes: 10, commandMinutes: 30, action: 'notify' },
  outOfRoots: { action: 'notify' },
  forbiddenCommands: { patterns: [], action: 'notify' },
  offPlan: { action: 'notify' },
  loop: { action: 'off', repeatCommand: 3, repeatRead: 5, requestsWithoutEdit: 20 },
  usage: { action: 'off', factor: 3, minSamples: 5 },
  maxInterventions: 2,
  consultTimeoutMinutes: 3,
};

function rules(patch: Partial<SuperviseSettings> = {}): SuperviseSettings {
  return { ...RULES, ...patch };
}

/** 手动推进的时钟，单位分钟。 */
function clock(): { now: () => number; advance: (minutes: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (minutes) => { t += minutes * 60000; } };
}

describe('干活监控：判断规则', () => {
  it('没动静：从第一行输出开始计时，超过阈值才报，同一段静默只报一次，有了新输出后可以再报', () => {
    const c = clock();
    const w = new StepWatch({ rules: rules(), writeRoots: [], streams: true, now: c.now });
    // 启动阶段没有输出归启动超时管
    c.advance(100);
    expect(w.tick()).toEqual([]);
    w.line();
    c.advance(9.9);
    expect(w.tick()).toEqual([]);
    c.advance(0.1);
    const [alert] = w.tick();
    expect(alert).toMatchObject({ rule: 'idle', action: 'notify', atMs: 6600000 });
    expect(alert!.detail).toBe('10分0秒没有任何输出');
    c.advance(5);
    expect(w.tick()).toEqual([]);
    w.line();
    c.advance(10);
    expect(w.tick()).toHaveLength(1);
  });

  it('没动静：执行命令之后用命令的阈值；命令发出后、结束前的收尾行和进度行只重新计时，不算命令结束', () => {
    const c = clock();
    const w = new StepWatch({ rules: rules(), writeRoots: [], streams: true, now: c.now });
    w.line();
    w.activity({ kind: 'run', target: 'npm test' });
    // 工具发出命令之后又输出几行（消息结束、进度），命令还在跑
    w.line();
    w.line();
    c.advance(29);
    expect(w.tick()).toEqual([]);
    c.advance(1);
    expect(w.tick()[0]!.detail).toBe('命令执行中，30分0秒没有任何输出');
    w.line();
    c.advance(29);
    expect(w.tick()).toEqual([]);
  });

  it('没动静：按 Claude Code 真实的输出顺序回放，命令运行期间一直用命令的阈值', () => {
    // 顺序取自一次真实运行：发出命令的 assistant 记录后面还跟着消息结束的几行，命令运行中有进度行
    const lines = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npx vitest run"}}]},"parent_tool_use_id":null}',
      '{"type":"stream_event","event":{"type":"content_block_stop"}}',
      '{"type":"stream_event","event":{"type":"message_delta"}}',
      '{"type":"stream_event","event":{"type":"message_stop"}}',
      '{"type":"system","subtype":"task_started"}',
      '{"type":"tool_progress"}',
    ];
    const c = clock();
    const w = new StepWatch({ rules: rules(), writeRoots: [], streams: true, now: c.now });
    for (const line of lines) {
      w.line();
      for (const a of streamJsonActivities(line)) w.activity(a);
    }
    c.advance(29);
    expect(w.tick()).toEqual([]);
    c.advance(1);
    expect(w.tick()[0]!.detail).toMatch(/^命令执行中，/);
  });

  it('没动静：命令之后有了别的活动（说话、思考、读文件等）就恢复普通阈值', () => {
    for (const next of [{ kind: 'think' }, { kind: 'say', text: '测试通过了' }, { kind: 'read', target: 'a.ts' }] as const) {
      const c = clock();
      const w = new StepWatch({ rules: rules(), writeRoots: [], streams: true, now: c.now });
      w.line();
      w.activity({ kind: 'say', text: '跑一下测试' });
      w.activity({ kind: 'run', target: 'npm test' });
      w.line();
      w.activity(next);
      c.advance(10);
      expect(w.tick()[0]!.detail).toBe('10分0秒没有任何输出');
    }
  });

  it('没动静：idle_factor 放宽阈值；工具不逐行输出或 action 为 off 时不检查', () => {
    const c = clock();
    const relaxed = new StepWatch({ rules: rules(), writeRoots: [], streams: true, idleFactor: 2, now: c.now });
    const batch = new StepWatch({ rules: rules(), writeRoots: [], streams: false, now: c.now });
    const off = new StepWatch({ rules: rules({ idle: { ...RULES.idle, action: 'off' } }), writeRoots: [], streams: true, now: c.now });
    for (const w of [relaxed, batch, off]) w.line();
    c.advance(19);
    expect(relaxed.tick()).toEqual([]);
    c.advance(1);
    expect(relaxed.tick()).toHaveLength(1);
    c.advance(100);
    expect(batch.tick()).toEqual([]);
    expect(off.tick()).toEqual([]);
  });

  it('路径越界：按 write_roots 判断，反斜杠、./ 开头照常识别，绝对路径和 .. 开头的算越界，同一个文件只报一次', () => {
    const w = new StepWatch({ rules: rules({ outOfRoots: { action: 'stop' } }), writeRoots: ['src', 'docs/'], streams: true });
    expect(w.activity({ kind: 'edit', target: 'src\\a.ts' })).toEqual([]);
    expect(w.activity({ kind: 'edit', target: './docs/b.md' })).toEqual([]);
    expect(w.activity({ kind: 'edit', target: 'package.json' })).toMatchObject([{ rule: 'out_of_roots', action: 'stop', detail: '改动了允许范围之外的文件：package.json' }]);
    expect(w.activity({ kind: 'edit', target: 'package.json' })).toEqual([]);
    expect(w.activity({ kind: 'edit', target: '../other/x.ts' })).toHaveLength(1);
    expect(w.activity({ kind: 'edit', target: '/etc/hosts' })).toHaveLength(1);
    expect(w.activity({ kind: 'edit', target: 'srcx/a.ts' })).toHaveLength(1);
  });

  it('路径越界：write_roots 为空时不检查', () => {
    const w = new StepWatch({ rules: rules(), writeRoots: [], streams: true });
    expect(w.activity({ kind: 'edit', target: 'anything.txt' })).toEqual([]);
  });

  it('禁用命令：拆开组合命令后按词前缀匹配，不区分大小写；清单为空或 action 为 off 时不检查', () => {
    expect(commandSegments('cd src && git push origin main | tee log; echo ok || true')).toEqual(['cd src', 'git push origin main', 'tee log', 'echo ok', 'true']);
    expect(matchesCommand('cd src && Git  Push origin main', 'git push')).toBe(true);
    expect(matchesCommand('git pushd', 'git push')).toBe(false);
    expect(matchesCommand('echo git push', 'git push')).toBe(false);
    expect(matchesCommand('git push', '  ')).toBe(false);

    const w = new StepWatch({ rules: rules({ forbiddenCommands: { patterns: ['git push', 'rm -rf'], action: 'notify' } }), writeRoots: [], streams: true });
    expect(w.activity({ kind: 'run', target: 'git status' })).toEqual([]);
    expect(w.activity({ kind: 'run', target: 'git add . && git push' })).toMatchObject([
      { rule: 'forbidden_command', detail: '执行了禁用的命令：git add . && git push（命中 "git push"）' },
    ]);
    expect(w.activity({ kind: 'run', target: 'git add . && git push' })).toEqual([]);
    expect(new StepWatch({ rules: rules(), writeRoots: [], streams: true }).activity({ kind: 'run', target: 'git push' })).toEqual([]);
    const off = new StepWatch({ rules: rules({ forbiddenCommands: { patterns: ['git push'], action: 'off' } }), writeRoots: [], streams: true });
    expect(off.activity({ kind: 'run', target: 'git push' })).toEqual([]);
  });
});

describe('干活监控：运行中', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  /** 阈值以分钟计，0.005 分钟是 300 毫秒。 */
  const project = (supervise: string, extra = ''): string => `${extra}supervise:\n${supervise}\n`;

  it('notify：记下告警、写进注意事项和 JSON，不打断，任务照常完成', async () => {
    sb = new Sandbox({
      activity: true,
      projectYaml: project(
        '  idle: { minutes: 0.005, command_minutes: 0.005, action: notify }\n' +
        '  out_of_roots: { action: notify }\n' +
        '  forbidden_commands: { patterns: ["git push"], action: notify }',
        'write_roots: [src]\n',
      ),
    });
    sb.setScenario({
      a2: [{
        stream: [
          { line: 'RUN:npm test' },
          { line: '测试通过', delayMs: 900 },
          { line: 'EDIT:outside/a.txt' },
          { line: 'RUN:git push origin main' },
        ],
        text: '做完了',
      }],
    });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    const step = r.json.steps[0];
    expect(step.outcome).toBe('ok');
    expect(step.alerts.map((a: any) => [a.rule, a.action])).toEqual([
      ['idle', 'notify'],
      ['out_of_roots', 'notify'],
      ['forbidden_command', 'notify'],
    ]);
    expect(step.alerts[0].detail).toMatch(/^命令执行中，/);
    expect(step.alerts[1].detail).toBe('改动了允许范围之外的文件：outside/a.txt');
    expect(r.json.warnings.some((w: string) => w.includes('执行了禁用的命令：git push origin main'))).toBe(true);
    // 文字报告的各步明细下面列出告警
    const detail = (await sb.cli(['job', r.json.job_id])).out;
    expect(detail).toMatch(/ {5}! .*：改动了允许范围之外的文件：outside\/a\.txt/);
  });

  it('stop：中断这一步，算未完成，不换人，任务停下', async () => {
    sb = new Sandbox({ activity: true, projectYaml: project('  idle: { minutes: 0.005, action: stop }') });
    sb.setScenario({ a2: [{ hang: true }], a3: [{ text: '不该轮到我' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(1);
    const step = r.json.steps[0];
    expect(step.outcome).toBe('task_failed');
    expect(step.reason).toMatch(/^监控发现问题，已中断：.*没有任何输出$/);
    expect(step.attempts.map((a: any) => a.agent)).toEqual(['a2']);
    expect(step.alerts).toMatchObject([{ rule: 'idle', action: 'stop' }]);
    expect(sb.calls().map((c) => c.name)).toEqual(['a2']);
  });

  it('文字方式运行时，告警随进度打到标准错误', async () => {
    sb = new Sandbox({ activity: true, projectYaml: project('  forbidden_commands: { patterns: ["git push"] }') });
    sb.setScenario({ a2: [{ stream: [{ line: 'RUN:git push' }], text: '好了' }] });
    const r = await sb.cli(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('执行了禁用的命令：git push（命中 "git push"）');
  });

  it('不逐行输出的工具不检查没动静', async () => {
    sb = new Sandbox({ projectYaml: project('  idle: { minutes: 0.005, action: stop }') });
    sb.setScenario({ a2: [{ delayMs: 900, text: '慢慢做完了' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps[0].alerts).toEqual([]);
  });

  it('本机的 idle_factor 对这家 AI 放宽阈值', async () => {
    sb = new Sandbox({
      activity: true,
      projectYaml: project('  idle: { minutes: 0.005, action: stop }'),
      agentsExtra: { agents: { a2: { idle_factor: 100 } } },
    });
    sb.setScenario({ a2: [{ stream: [{ line: '开始' }, { line: '结束', delayMs: 900 }], text: '好了' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps[0].alerts).toEqual([]);
  });
});

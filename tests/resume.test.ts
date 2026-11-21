import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudePlugin, codebuddyPlugin, codexPlugin } from '../src/agents/builtin.js';
import { createApp } from '../src/compose.js';
import { looksSessionLost, type InvokeRequest, type RawResult } from '../src/plugin.js';
import { plan, Sandbox, verdict, type FakeCall } from './helpers.js';

const req = (over: Partial<InvokeRequest> = {}): InvokeRequest => ({
  access: 'read-only',
  cwd: 'D:/work',
  prompt: '任务说明',
  allowedTools: ['Read'],
  resultFile: 'D:/jobs/out.txt',
  options: {},
  ...over,
});

const raw = (over: Partial<RawResult> = {}): RawResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, startupTimedOut: false, ...over });

describe('内置插件：续接会话', () => {
  it('三个内置插件都声明支持续接', () => {
    expect([claudePlugin.resumes, codebuddyPlugin.resumes, codexPlugin.resumes]).toEqual([true, true, true]);
  });

  it('Claude Code 与 CodeBuddy：带 --resume，权限和工具清单仍按这一次的给', () => {
    const args = claudePlugin.build(req({ resume: 'sess-1' })).args;
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'sess-1']);
    expect(args).toContain('dontAsk');
    expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect(claudePlugin.build(req()).args).not.toContain('--resume');
    expect(codebuddyPlugin.build(req({ resume: 'sess-1' })).args).toEqual(args);
  });

  it('Codex：沙箱方式写在 resume 之前，其余参数在后', () => {
    const args = codexPlugin.build(req({ resume: 'thread-1', model: 'gpt-x' })).args;
    expect(args).toEqual([
      'exec', '-C', 'D:/work', '-s', 'read-only', '--skip-git-repo-check', '--color', 'never',
      'resume', 'thread-1', '--json', '-o', 'D:/jobs/out.txt', '-m', 'gpt-x', '-',
    ]);
    expect(codexPlugin.build(req({ resume: 'thread-1', access: 'write' })).args.slice(3, 5)).toEqual(['-s', 'workspace-write']);
  });

  it('从输出里取出会话号', () => {
    const claude = '{"type":"system","subtype":"init","session_id":"s1"}\n{"type":"result","subtype":"success","is_error":false,"result":"好","session_id":"s1"}';
    expect(claudePlugin.parse(raw({ stdout: claude })).sessionId).toBe('s1');
    const codex = '{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"好"}}';
    expect(codexPlugin.parse(raw({ stdout: codex })).sessionId).toBe('t1');
    expect(claudePlugin.parse(raw({ stdout: '{"type":"result","subtype":"success","is_error":false,"result":"好"}' })).sessionId).toBeUndefined();
  });

  it('认得三家工具"会话找不到"的报错，不把普通报错当成会话失效', () => {
    // 取自本机实测：Claude Code 2.1.330、CodeBuddy 2.184.0、Codex 0.171.0
    for (const text of [
      'No conversation found with session ID: 11111111-2222-4333-8444-555555555555',
      '{"type":"error","error":"No conversation found with session ID: 11111111-2222-4333-8444-555555555555"}',
      'Error: thread/resume: thread/resume failed: no rollout found for thread id 11111111-2222-4333-8444-555555555555 (code -32600)',
    ]) {
      expect(looksSessionLost(text), text).toBe(true);
    }
    for (const text of ['SyntaxError: unexpected token', '测试失败：期望 3 实际 4', 'Error: 429 Too Many Requests', 'file not found: src/session.ts']) {
      expect(looksSessionLost(text), text).toBe(false);
    }
  });
});

describe('同一任务里续接角色的会话', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = new Sandbox({ git: true, resumable: true });
  });
  afterEach(() => sb?.cleanup());

  const resumeOf = (c: FakeCall): string | undefined => (c.argv.includes('--resume') ? c.argv[c.argv.indexOf('--resume') + 1] : undefined);
  const trace = (): string[] => sb.calls().map((c) => `${c.name}:${resumeOf(c) ?? '新开'}`);
  const writePlan = plan([{ role: 'coder', task: '实现功能 ABC', writes: true }]);

  it('返工、再审、汇总都续接各自角色的会话，只收到增量说明', async () => {
    sb.setScenario({
      a1: [{ text: writePlan }, { text: '汇总：完成' }],
      a2: [
        { text: '第一版写好了', files: [{ path: 'f.txt', content: 'v1' }] },
        { text: '改好了', files: [{ path: 'f.txt', content: 'v2' }] },
      ],
      a3: [{ text: verdict(false, ['f.txt 里缺少校验']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '原始任务 XYZ']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => `${s.kind}:${s.agent}:${s.resumed}`)).toEqual([
      'plan:a1:false', 'step:a2:false', 'review:a3:false', 'rework:a2:true', 'review:a3:true', 'summary:a1:true',
    ]);
    // 三个角色各一个会话，后面几步都接在自己角色的第一个会话上
    expect(trace()).toEqual(['a1:新开', 'a2:新开', 'a3:新开', 'a2:a2-s0', 'a3:a3-s0', 'a1:a1-s0']);

    const [, , , rework, review2, summary] = sb.calls().map((c) => c.prompt);
    // 返工：问题清单是新的，原任务已经在会话里
    expect(rework).toContain('f.txt 里缺少校验');
    expect(rework).not.toContain('实现功能 ABC');
    // 工作规则这个会话第一步已经收到过，不再重发，只提一句
    expect(rework).not.toContain('不要执行 git commit');
    expect(rework).toContain('工作规则与项目约定同之前');
    // 再审：只给上次审查之后的工作和改动，规则不重发，输出格式只留一行提醒
    expect(review2).toContain('改好了');
    expect(review2).not.toContain('第一版写好了');
    expect(review2).not.toContain('原始任务 XYZ');
    expect(review2).toContain('- f.txt');
    expect(review2).toContain('"verdict"');
    expect(review2).not.toContain('不要创建、修改或删除任何文件');
    expect(review2).not.toContain('只因为会导致错误结果');
    // 汇总：各步结果是新的，原始任务不再重复
    expect(summary).toContain('第一版写好了');
    expect(summary).not.toContain('原始任务 XYZ');
    expect(r.err).toContain('（续接会话）');
  });

  it('计划重出时续接，只发问题和重出的要求', async () => {
    sb.setScenario({
      a1: [{ text: '没有 JSON' }, { text: plan([{ role: 'reviewer', task: '看看' }]) }, { text: '汇总' }],
      a3: [{ text: '看完了' }],
    });
    const r = await sb.runJson(['任务']);
    expect(r.code).toBe(0);
    expect(trace()).toEqual(['a1:新开', 'a1:a1-s0', 'a3:新开', 'a1:a1-s0']);
    const retry = sb.calls()[1]!.prompt;
    expect(retry).toContain('没有找到 JSON 计划');
    expect(retry).not.toContain('可用角色');
  });

  it('同一角色在计划里的后一步续接前一步，补上其间别人的结果和改过的文件', async () => {
    sb.writeRoles(`
roles:
  lead: { candidates: [a1], access: read-only }
  coder: { candidates: [a2], access: write }
  tester: { candidates: [a3], access: write }
`);
    sb.setScenario({
      a1: [
        {
          text: plan([
            { role: 'coder', task: '任务甲', writes: true },
            { role: 'tester', task: '任务乙', writes: true },
            { role: 'coder', task: '任务丙', writes: true },
          ]),
        },
        { text: '汇总' },
      ],
      a2: [{ text: '甲的结果', files: [{ path: 'a.txt', content: '1' }] }, { text: '丙的结果' }],
      a3: [{ text: '乙的结果', files: [{ path: 'a.txt', content: '2' }, { path: 't.txt', content: 't' }] }],
    });
    const r = await sb.runJson(['-p', '--yes', '三步任务']);
    expect(r.code).toBe(0);
    expect(trace()).toEqual(['a1:新开', 'a2:新开', 'a3:新开', 'a2:a2-s0', 'a1:a1-s0']);
    const third = sb.calls()[3]!.prompt;
    expect(third).toContain('任务丙');
    expect(third).toContain('乙的结果');
    expect(third).not.toContain('甲的结果');
    expect(third).toContain('- a.txt');
    expect(third).toContain('- t.txt');
    expect(third).toContain('重新读取');
    // 测试角色第一次上场，拿到的是完整说明
    expect(sb.calls()[2]!.prompt).toContain('甲的结果');
  });

  it('担当者换了人就不续接，新的一家拿到完整的任务说明', async () => {
    sb.setScenario({
      a1: [{ text: writePlan }, { text: '汇总' }],
      a2: [{ text: 'a2 第一版', files: [{ path: 'f.txt', content: 'v1' }] }, { exit: 1, stderr: 'overloaded_error' }],
      a3: [
        { text: verdict(false, ['缺少校验']) },
        { text: 'a3 返工完成', files: [{ path: 'f.txt', content: 'v2' }] },
        { text: verdict(true) },
      ],
    });
    const r = await sb.runJson(['-p', '--yes', '实现']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => `${s.kind}:${s.agent}:${s.resumed}`)).toEqual([
      'plan:a1:false', 'step:a2:false', 'review:a3:false', 'rework:a3:false', 'review:a3:true', 'summary:a1:true',
    ]);
    // a2 续接时不可用，换成 a3：a3 在"实现"这个角色下没有会话，新开；它在"审查"角色下的会话不受影响
    expect(trace()).toEqual(['a1:新开', 'a2:新开', 'a3:新开', 'a2:a2-s0', 'a3:新开', 'a3:a3-s0', 'a1:a1-s0']);
    const rework = sb.calls()[4]!.prompt;
    expect(rework).toContain('实现功能 ABC');
    expect(rework).toContain('缺少校验');
  });

  it('会话已失效时新开会话重跑这一步，不算换人，也不标记这家不可用', async () => {
    sb.setScenario({
      a1: [{ text: '没有 JSON' }, { sessionLost: true }, { text: plan([{ role: 'reviewer', task: '看看' }]) }, { text: '汇总' }],
      a3: [{ text: '看完了' }],
    });
    const r = await sb.runJson(['任务']);
    expect(r.code).toBe(0);
    expect(trace()).toEqual(['a1:新开', 'a1:a1-s0', 'a1:新开', 'a3:新开', 'a1:a1-s2']);
    // 重跑用的是完整说明
    expect(sb.calls()[2]!.prompt).toContain('可用角色');
    expect(r.json.fallback_happened).toBe(false);
    expect(r.json.steps[1].attempts).toHaveLength(1);
    expect((await sb.cli(['roles'])).out).not.toContain('暂时不可用');
    const audit = fs.readFileSync(path.join(sb.home, 'state', 'audit.log'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const runs = audit.filter((e) => e.event === 'agent_run' && e.agent === 'a1');
    expect(runs.map((e) => [e.resumed === true, e.session_lost === true])).toEqual([[false, false], [true, true], [false, false], [true, false]]);
  });

  it('approve 在另一次命令里也能续接计划阶段的会话', async () => {
    sb.setScenario({
      a1: [{ text: writePlan }, { text: '汇总' }],
      a2: [{ text: '写好了', files: [{ path: 'f.txt', content: 'v1' }] }],
      a3: [{ text: verdict(true) }],
    });
    const first = await sb.runJson(['-p', '实现']);
    expect(first.code).toBe(4);
    const second = await sb.runJson(['approve', first.json.job_id]);
    expect(second.code).toBe(0);
    expect(trace()).toEqual(['a1:新开', 'a2:新开', 'a3:新开', 'a1:a1-s0']);
  });
});

describe('跨任务续接：上一个任务留下的会话接着用', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = new Sandbox({ git: true, resumable: true });
  });
  afterEach(() => sb?.cleanup());

  const resumeOf = (c: FakeCall): string | undefined => (c.argv.includes('--resume') ? c.argv[c.argv.indexOf('--resume') + 1] : undefined);
  const trace = (): string[] => sb.calls().map((c) => `${c.name}:${resumeOf(c) ?? '新开'}`);
  const origin = { channel: 'terminal', senderId: '测试' };
  const engine = async () => (await createApp({ cwd: sb.project, env: sb.env() })).engine;

  it('直派：同一角色的下一个任务续接会话，只交代新任务，规则不重发', async () => {
    sb.setScenario({ a2: [{ text: '第一个任务做完了' }, { text: '第二个任务做完了' }, { text: '第三个任务做完了' }] });
    const e = await engine();
    const first = await e.submit({ task: '第一个任务', role: 'coder', origin });
    expect(first.sessions).toMatchObject({ coder: { agent: 'a2', sessionId: 'a2-s0', step: 0 } });
    // 会话上记着它收到过的固定说明的指纹
    expect(first.sessions!.coder!.brief).toMatch(/^[0-9a-f]{12}$/);
    const second = await e.submit({ task: '第二个任务', role: 'coder', origin, sessions: first.sessions });
    expect(second.status).toBe('done');
    expect(second.steps[0]!.resumed).toBe(true);
    expect(trace()).toEqual(['a2:新开', 'a2:a2-s0']);
    const prompt = sb.calls()[1]!.prompt;
    expect(prompt).toContain('这是同一次会话里的新任务');
    expect(prompt).toContain('请重新读取');
    // 新任务它没见过，任务照给；角色用一句话重申，规则和项目约定第一次已经给过，不再重发
    expect(prompt).toContain('第二个任务');
    expect(prompt).toContain('你继续担任「实现」（coder）这个角色，权限：可以修改文件');
    expect(prompt).not.toContain('不要执行 git commit');
    expect(prompt).not.toContain('# 工作规则');
    expect(second.sessions!.coder!.brief).toBe(first.sessions!.coder!.brief);
    // 不带会话时照旧新开
    await e.submit({ task: '第三个任务', role: 'coder', origin });
    expect(trace()[2]).toBe('a2:新开');
  });

  it('主控分派：各角色接着上一个任务的会话，任务内的后续步骤仍只发增量', async () => {
    const onePlan = (task: string): string => plan([{ role: 'coder', task, writes: true }]);
    sb.setScenario({
      a1: [{ text: onePlan('实现甲') }, { text: '汇总甲' }, { text: onePlan('实现乙') }, { text: '汇总乙' }],
      a2: [{ text: '甲写好了', files: [{ path: 'a.txt', content: '1' }] }, { text: '乙写好了', files: [{ path: 'b.txt', content: '2' }] }],
      a3: [{ text: verdict(true) }, { text: verdict(true) }],
    });
    const e = await engine();
    const first = await e.submit({ task: '任务甲', origin, autoApprove: true });
    expect(first.status).toBe('done');
    const second = await e.submit({ task: '任务乙', origin, autoApprove: true, sessions: first.sessions });
    expect(second.status).toBe('done');
    expect(second.steps.map((s) => `${s.kind}:${s.resumed === true}`)).toEqual(['plan:true', 'step:true', 'review:true', 'summary:true']);
    // 三个角色、两个任务，一共只有三个会话
    expect(trace()).toEqual(['a1:新开', 'a2:新开', 'a3:新开', 'a1:a1-s0', 'a1:a1-s0', 'a2:a2-s0', 'a3:a3-s0', 'a1:a1-s0']);
    const [plan2, step2, review2, summary2] = sb.calls().slice(4).map((c) => c.prompt);
    // 带过来的会话第一次上场：交代是新任务；角色表、分派规则、工作规则、输出格式的正文上一个任务已经给过，不再重发
    for (const p of [plan2!, step2!, review2!]) expect(p).toContain('这是同一次会话里的新任务');
    expect(plan2).not.toContain('# 可用角色');
    expect(plan2).not.toContain('# 分派规则');
    expect(plan2).toContain('输出同样字段的 JSON 代码块');
    expect(plan2).toContain('任务乙');
    expect(step2).toContain('实现乙');
    expect(step2).not.toContain('# 工作规则');
    expect(review2).toContain('"verdict"');
    expect(review2).not.toContain('# 工作规则');
    expect(review2).toContain('乙写好了');
    // 同一任务里再次上场（汇总）：只发增量
    expect(summary2).not.toContain('这是同一次会话里的新任务');
    expect(summary2).not.toContain('任务乙');
    expect(summary2).toContain('乙写好了');
  });

  it('两个任务之间担当者换了人，带过来的会话作废', async () => {
    sb.setScenario({ a2: [{ text: 'a2 做完了' }], a3: [{ text: 'a3 做完了' }, { text: 'a3 又做完了' }] });
    const e = await engine();
    const first = await e.submit({ task: '第一个任务', role: 'coder', origin });
    e.setRole('coder', 'a3', false);
    const second = await e.submit({ task: '第二个任务', role: 'coder', origin, sessions: first.sessions });
    expect(second.steps[0]).toMatchObject({ agent: 'a3' });
    expect(second.steps[0]!.resumed).toBeUndefined();
    expect(second.sessions).toMatchObject({ coder: { agent: 'a3', sessionId: 'a3-s0', step: 0 } });
    expect(sb.calls()[1]!.prompt).not.toContain('这是同一次会话里的新任务');
    // 换了人是新开的会话，规则要完整给一遍
    expect(sb.calls()[1]!.prompt).toContain('不要执行 git commit');
    const third = await e.submit({ task: '第三个任务', role: 'coder', origin, sessions: second.sessions });
    expect(third.steps[0]!.resumed).toBe(true);
    expect(trace()).toEqual(['a2:新开', 'a3:新开', 'a3:a3-s0']);
  });

  it('项目约定改了之后，带过来的会话重新收到一次完整说明', async () => {
    sb.setScenario({ a2: [{ text: '第一个任务做完了' }, { text: '第二个任务做完了' }, { text: '第三个任务做完了' }] });
    const first = await (await engine()).submit({ task: '第一个任务', role: 'coder', origin });
    // 改项目的固定前言，重新加载配置
    fs.writeFileSync(path.join(sb.project, '.dario', 'project.yaml'), 'preamble: "- 新增的项目约定 QWE"\n', 'utf8');
    const e = await engine();
    const second = await e.submit({ task: '第二个任务', role: 'coder', origin, sessions: first.sessions });
    expect(second.steps[0]!.resumed).toBe(true);
    const prompt = sb.calls()[1]!.prompt;
    expect(prompt).toContain('这是同一次会话里的新任务');
    expect(prompt).toContain('新增的项目约定 QWE');
    expect(prompt).toContain('不要执行 git commit');
    expect(second.sessions!.coder!.brief).not.toBe(first.sessions!.coder!.brief);
    // 之后配置没再变，又回到精简的写法
    await e.submit({ task: '第三个任务', role: 'coder', origin, sessions: second.sessions });
    expect(sb.calls()[2]!.prompt).not.toContain('新增的项目约定 QWE');
  });

  it('失败的任务里没做成的那个角色不再续接，其他角色的会话照样带下去', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现', writes: true }]) }, { text: plan([{ role: 'coder', task: '再实现', writes: true }]) }, { text: '汇总' }],
      a2: [{ exit: 1, stderr: 'SyntaxError: boom' }, { text: '这次做完了' }],
    });
    const e = await engine();
    const first = await e.submit({ task: '任务甲', origin, autoApprove: true });
    expect(first.status).toBe('failed');
    expect(Object.keys(first.sessions ?? {})).toEqual(['lead']);
    await e.submit({ task: '任务乙', origin, autoApprove: true, sessions: first.sessions });
    expect(trace()).toEqual(['a1:新开', 'a2:新开', 'a1:a1-s0', 'a2:新开', 'a1:a1-s0']);
  });
});

describe('不支持续接的 AI', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('每一步照旧新开会话，拿到完整的任务说明', async () => {
    sb = new Sandbox({ git: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现功能 ABC', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: '第一版', files: [{ path: 'f.txt', content: 'v1' }] }, { text: '改好了', files: [{ path: 'f.txt', content: 'v2' }] }],
      a3: [{ text: verdict(false, ['缺少校验']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '原始任务 XYZ']);
    expect(r.code).toBe(0);
    expect(r.json.steps.every((s: any) => s.resumed === false)).toBe(true);
    expect(sb.calls().every((c) => !c.argv.includes('--resume'))).toBe(true);
    expect(sb.calls()[3]!.prompt).toContain('实现功能 ABC');
    expect(sb.calls()[5]!.prompt).toContain('原始任务 XYZ');
    expect(r.err).not.toContain('续接会话');
  });
});

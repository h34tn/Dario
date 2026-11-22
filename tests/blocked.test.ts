import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/compose.js';
import { parseBlocked } from '../src/core/prompts.js';
import { plan, Sandbox, verdict } from './helpers.js';

describe('受阻标记的解析', () => {
  it('取单独一行的标记，中英文冒号、列表符号和反引号都认', () => {
    expect(parseBlocked('做到一半。\nDARIO_BLOCKED: Unity MCP 连不上，重试 5 次都被拒绝')).toBe('Unity MCP 连不上，重试 5 次都被拒绝');
    expect(parseBlocked('说明\n- `DARIO_BLOCKED：服务没有启动`\n')).toBe('服务没有启动');
    // 句末标点由 Dario 拼句子时自己加，避免出现"。。"
    expect(parseBlocked('DARIO_BLOCKED: 构建无法完成。')).toBe('构建无法完成');
    expect(parseBlocked('DARIO_BLOCKED: 服务连不上！`')).toBe('服务连不上');
    expect(parseBlocked('第一次\nDARIO_BLOCKED: 甲\n后来\nDARIO_BLOCKED: 乙')).toBe('乙');
    expect(parseBlocked('DARIO_BLOCKED:')).toBe('没有写明原因');
  });

  it('没有标记，或只是在句子里提到它，不算受阻', () => {
    expect(parseBlocked('全部完成，没有问题。')).toBeUndefined();
    expect(parseBlocked('如果连不上我会写 DARIO_BLOCKED: 原因，但这次不需要。')).toBeUndefined();
  });
});

describe('必需的工具或服务用不了：任务停下并告知', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = new Sandbox({ git: true, resumable: true });
  });
  afterEach(() => sb?.cleanup());

  it('各角色的工作规则里写明了先重试、再停下、怎么标记', async () => {
    sb.setScenario({ a2: [{ text: '做完了' }] });
    await sb.runJson(['-p', '--to', 'coder', '任务']);
    const prompt = sb.calls()[0]!.prompt;
    expect(prompt).toContain('先多试几次');
    expect(prompt).toContain('DARIO_BLOCKED: <一句话原因>');
  });

  it('执行的一步受阻：这一步记为没完成，后面的步骤和审查不再执行，结论写明原因', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '在编辑器里改材质', writes: true }, { role: 'coder', task: '第二步', writes: true }]) }],
      a2: [{ text: '重试了 5 次，隔 10 秒一次，都连不上。\nDARIO_BLOCKED: Unity MCP 连不上（ECONNREFUSED）' }],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '把薄雾换成无光照材质']);
    expect(r.code).toBe(1);
    expect(r.json.status).toBe('failed');
    expect(r.json.steps.map((s: any) => `${s.kind}:${s.outcome}`)).toEqual(['plan:ok', 'step:task_failed']);
    expect(r.json.steps[1].reason).toContain('Unity MCP 连不上（ECONNREFUSED）');
    expect(r.json.conclusion).toContain('必需的工具或服务用不了，已停下');
    expect(r.json.conclusion).toContain('重试了 5 次');
    // 只调用了主控和执行者各一次
    expect(sb.calls().map((c) => c.name)).toEqual(['a1', 'a2']);
    expect(r.err).toContain('受阻，任务停下');
  });

  it('受阻之后会话还在：恢复后的下一个任务接着原来的会话做', async () => {
    sb.setScenario({ a2: [{ text: 'DARIO_BLOCKED: Unity MCP 连不上' }, { text: '这次连上了，做完了' }] });
    const engine = (await createApp({ cwd: sb.project, env: sb.env() })).engine;
    const origin = { channel: 'terminal', senderId: '测试' };
    const first = await engine.submit({ task: '改材质', role: 'coder', origin });
    expect(first.status).toBe('failed');
    expect(first.sessions?.coder?.sessionId).toBe('a2-s0');
    const second = await engine.submit({ task: 'Unity MCP 已恢复，继续', role: 'coder', origin, sessions: first.sessions });
    expect(second.status).toBe('done');
    expect(second.steps[0]!.resumed).toBe(true);
  });

  it('正常完成的回复不受影响', async () => {
    sb.setScenario({ a2: [{ text: '做完了。多出来的 teamcity 服务连不上，但任务用不到它。' }] });
    const r = await sb.runJson(['-p', '--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.status).toBe('done');
  });
});

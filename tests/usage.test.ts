import { afterEach, describe, expect, it } from 'vitest';
import { claudePlugin, codebuddyPlugin, codexPlugin } from '../src/agents/builtin.js';
import type { TokenUsage } from '../src/plugin.js';
import { plan, Sandbox, verdict } from './helpers.js';

/** 逐行喂给统计函数，记下每次返回的累计值。 */
function feed(meter: (line: string) => TokenUsage | undefined, lines: string[]): Array<TokenUsage | undefined> {
  return lines.map((line) => meter(line));
}

const event = (type: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'stream_event', event: { type, ...body }, parent_tool_use_id: null, ...extra });
const usage = (input: number, creation: number, read: number, output: number) => ({
  input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: output,
});

describe('内置插件：统计 token 用量', () => {
  it('Claude Code：按消息累加，输入含写入和命中缓存的部分，输出以每条消息结束时的数为准', () => {
    // 数字取自本机实测（Claude Code 2.1.330，--include-partial-messages），两次请求、中间一次工具调用
    const out = feed(claudePlugin.meter!(), [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      event('message_start', { message: { id: 'm1', usage: usage(2, 13233, 17421, 16) } }),
      event('content_block_delta', { delta: { type: 'text_delta', text: '带 "usage" 字样的正文不算' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use' }], usage: usage(2, 13233, 17421, 16) }, parent_tool_use_id: null }),
      event('message_delta', { usage: usage(2, 13233, 17421, 129) }, { api_message_id: 'm1' }),
      event('message_start', { message: { id: 'm2', usage: usage(2, 4509, 30654, 1) } }),
      event('message_delta', { usage: usage(2, 4509, 30654, 24) }, { api_message_id: 'm2' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '好', usage: usage(4, 17742, 48075, 153) }),
    ]);
    expect(out).toEqual([
      undefined,
      { input: 30656, cachedInput: 17421, output: 16, requests: 1, firstInput: 30656 },
      undefined,
      undefined,
      { input: 30656, cachedInput: 17421, output: 129, requests: 1, firstInput: 30656 },
      { input: 65821, cachedInput: 48075, output: 130, requests: 2, firstInput: 30656 },
      { input: 65821, cachedInput: 48075, output: 153, requests: 2, firstInput: 30656 },
      // 与最后的 result 记录一致，没有变化就不再报
      undefined,
    ]);
  });

  it('Claude Code：不计子代理的消息；没有分段输出时按消息去重，最后由 result 记录纠正输出', () => {
    const assistant = (id: string, u: object, parent: string | null = null): string =>
      JSON.stringify({ type: 'assistant', message: { id, content: [], usage: u }, parent_tool_use_id: parent });
    const out = feed(claudePlugin.meter!(), [
      assistant('m1', usage(2, 100, 900, 7)),
      // 同一条消息拆成两行输出，用量相同，只算一次
      assistant('m1', usage(2, 100, 900, 7)),
      assistant('sub', usage(5000, 0, 0, 800), 'toolu_1'),
      assistant('m2', usage(3, 50, 1000, 3)),
      JSON.stringify({ type: 'result', subtype: 'success', result: '好', usage: usage(5, 150, 1900, 640) }),
    ]);
    expect(out).toEqual([
      { input: 1002, cachedInput: 900, output: 7, requests: 1, firstInput: 1002 },
      undefined,
      undefined,
      { input: 2055, cachedInput: 1900, output: 10, requests: 2, firstInput: 1002 },
      { input: 2055, cachedInput: 1900, output: 640, requests: 2, firstInput: 1002 },
    ]);
  });

  it('Claude Code：一次运行里有多条 result 时各段相加，后一段的消息接着前一段累计', () => {
    // 后台命令结束的通知引出新一轮回答：每条 result 只统计上一条之后的那一段
    const out = feed(claudePlugin.meter!(), [
      event('message_start', { message: { id: 'm1', usage: usage(2, 100, 900, 1) } }),
      event('message_delta', { usage: usage(2, 100, 900, 20) }, { api_message_id: 'm1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '等通知', usage: usage(2, 100, 900, 25) }),
      event('message_start', { message: { id: 'm2', usage: usage(1, 10, 1000, 1) } }),
      event('message_delta', { usage: usage(1, 10, 1000, 7) }, { api_message_id: 'm2' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '做完了', usage: usage(1, 10, 1000, 8) }),
    ]);
    expect(out).toEqual([
      { input: 1002, cachedInput: 900, output: 1, requests: 1, firstInput: 1002 },
      { input: 1002, cachedInput: 900, output: 20, requests: 1, firstInput: 1002 },
      { input: 1002, cachedInput: 900, output: 25, requests: 1, firstInput: 1002 },
      { input: 2013, cachedInput: 1900, output: 26, requests: 2, firstInput: 1002 },
      { input: 2013, cachedInput: 1900, output: 32, requests: 2, firstInput: 1002 },
      { input: 2013, cachedInput: 1900, output: 33, requests: 2, firstInput: 1002 },
    ]);
  });

  it('CodeBuddy：input_tokens 已含命中缓存的部分；开头报的 0 不显示，重复的结束事件只算一次', () => {
    // 数字取自本机实测（CodeBuddy 2.184.0）
    const zero = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    const out = feed(codebuddyPlugin.meter!(), [
      event('message_start', { message: { id: 'm1', usage: zero } }),
      event('message_delta', { usage: usage(25226, 0, 1024, 127) }),
      event('message_delta', { usage: usage(25226, 0, 1024, 127) }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: null } }, parent_tool_use_id: null }),
      event('message_start', { message: { id: 'm2', usage: zero } }),
      event('message_delta', { usage: usage(25398, 0, 25088, 27) }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '好', usage: usage(50624, 0, 26112, 154) }),
    ]);
    expect(out).toEqual([
      undefined,
      { input: 25226, cachedInput: 1024, output: 127, requests: 1, firstInput: 25226 },
      undefined,
      undefined,
      undefined,
      { input: 50624, cachedInput: 26112, output: 154, requests: 2, firstInput: 25226 },
      undefined,
    ]);
  });

  it('Codex：只在一轮结束时报一次，报的是整个会话的累计值', () => {
    const out = feed(codexPlugin.meter!(), [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"提到 turn.completed 的正文"}}',
      '{"type":"turn.completed","usage":{"input_tokens":200860,"cached_input_tokens":189952,"cache_write_input_tokens":0,"output_tokens":795,"reasoning_output_tokens":0}}',
    ]);
    expect(out).toEqual([undefined, undefined, { input: 200860, cachedInput: 189952, output: 795, sessionTotal: true }]);
  });

  it('损坏的行和不相干的行不影响统计', () => {
    const meter = claudePlugin.meter!();
    expect(feed(meter, ['{"usage" 坏掉的行', '不是 JSON 但带 "usage"', '{"type":"user","message":{"usage":{"input_tokens":9}}}'])).toEqual([undefined, undefined, undefined]);
    expect(meter(event('message_start', { message: { id: 'm1', usage: usage(1, 2, 3, 4) } }))).toEqual({ input: 6, cachedInput: 3, output: 4, requests: 1, firstInput: 6 });
  });
});

describe('每一步记下自己的 token 用量', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('工具只报会话累计值时，续接的步骤减去上一轮的累计值；新开的会话不减', async () => {
    sb = new Sandbox({ git: true, resumable: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现', writes: true }]), usage: [300, 0, 30] }, { text: '汇总', usage: [500, 100, 45] }],
      a2: [
        { text: '第一版', files: [{ path: 'f.txt', content: 'v1' }], usage: [1000, 200, 50] },
        { text: '改好了', files: [{ path: 'f.txt', content: 'v2' }], usage: [2500, 900, 120] },
      ],
      // 审查这家不报用量
      a3: [{ text: verdict(false, ['缺少校验']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => [s.kind, s.resumed, s.tokens])).toEqual([
      ['plan', false, { input: 300, cached_input: 0, output: 30, requests: null, first_input: null }],
      ['step', false, { input: 1000, cached_input: 200, output: 50, requests: null, first_input: null }],
      ['review', false, null],
      ['rework', true, { input: 1500, cached_input: 700, output: 70, requests: null, first_input: null }],
      ['review', true, null],
      ['summary', true, { input: 200, cached_input: 100, output: 15, requests: null, first_input: null }],
    ]);
    // dario job 的各步列表里也带上用量，新发送的输入和命中缓存的部分分开写
    const detail = (await sb.cli(['job', r.json.job_id])).out;
    expect(detail).toContain('输入 800（另有缓存命中 700）输出 70 token');
    expect(detail).toContain('输入 300（另有缓存命中 0）输出 30 token');
    // 按阶段汇总：按流程先后排列，返工单列，审查这家不报用量就不写 token
    expect(r.json.phases.map((p: any) => [p.kind, p.steps, p.input, p.cached_input, p.output])).toEqual([
      ['plan', 1, 300, 0, 30],
      ['step', 1, 1000, 200, 50],
      ['rework', 1, 1500, 700, 70],
      ['review', 2, null, null, null],
      ['summary', 1, 200, 100, 15],
    ]);
    const phases = detail.slice(detail.indexOf('按阶段：')).split('\n').slice(1, 7);
    expect(phases[0]).toMatch(/^  计划  1 步 · .* · 新输入 300 · 缓存 0 · 输出 30 token$/);
    expect(phases[3]).toMatch(/^  审查  2 步 · [^·]*$/);
    expect(phases[5]).toMatch(/^  合计  6 步 · .* · 新输入 2\.0k · 缓存 1\.0k · 输出 165 token$/);
  });

  it('不报用量的工具：记录为空，文字输出里不出现用量', async () => {
    sb = new Sandbox({ git: true });
    sb.setScenario({ a2: [{ text: '做完了' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.json.steps[0].tokens).toBeNull();
    const text = await sb.cli(['--to', 'coder', '任务']);
    expect(text.err).not.toContain('token');
    expect((await sb.cli(['job', r.json.job_id])).out).not.toContain('token');
  });
});

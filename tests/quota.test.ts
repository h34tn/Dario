import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claudePlugin, codebuddyPlugin, codexPlugin } from '../src/agents/builtin.js';
import { AgentHandle } from '../src/agents/handle.js';
import { createApp } from '../src/compose.js';
import { formatQuota, quotaPercent } from '../src/core/report.js';
import { StateStore } from '../src/core/state.js';
import type { ProgressEvent } from '../src/core/types.js';
import type { QuotaWindow } from '../src/plugin.js';
import { Sandbox } from './helpers.js';

let box: Sandbox;
afterEach(() => box?.cleanup());

const claudeLine = (info: object) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
const fiveHour = { id: 'five_hour', usedPercent: 67, windowMinutes: 300, primary: true } as const;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

it('Claude 读取全部窗口、主窗口和秒级重置时刻，保留超额比例', () => {
  const read = claudePlugin.quota!().onLine!;
  expect(read(claudeLine({ rateLimitType: 'five_hour', unifiedWindows: {
    five_hour: { utilization: 0.67, resetsAt: 1795257000 },
    seven_day: { utilization: 0.37, resetsAt: 1795406400 },
    seven_day_overage_included: { utilization: 0.71, resetsAt: 1795406400 },
  } }))).toEqual([
    { ...fiveHour, resetsAt: iso(1795257000) },
    { id: 'seven_day', usedPercent: 37, windowMinutes: 10080, resetsAt: iso(1795406400) },
    { id: 'seven_day_overage_included', usedPercent: 71, windowMinutes: 10080, resetsAt: iso(1795406400) },
  ]);
  expect(read(claudeLine({ rateLimitType: 'other', utilization: 1.01 }))).toEqual([{ id: 'other', usedPercent: 101, primary: true }]);
  expect(read(claudeLine({ rateLimitType: 'five_hour', status: 'rejected' }))).toBeUndefined();
  expect(read('{"type":"result"}')).toBeUndefined();
  expect(read('{"type":"rate_limit_event"')).toBeUndefined();
  expect(codebuddyPlugin.quota).toBeUndefined();
});

it('Codex 跨日期按会话号找文件，取最后一次报告的窗口', async () => {
  box = new Sandbox();
  const after = codexPlugin.quota!().afterRun!;
  const env = { CODEX_HOME: box.dir };
  const dir = path.join(box.dir, 'sessions', '2026', '11', '20');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-11-20-s1.jsonl');
  const line = (primary: object, secondary: object | null) =>
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary, secondary } } });
  fs.writeFileSync(file, [
    line({ used_percent: 2 }, null),
    line({ used_percent: 7, window_minutes: 10080, resets_at: 1795748999 }, { used_percent: 0, window_minutes: 300 }),
    '{"type":"event_msg","payload":{}}', '{',
  ].join('\n'));
  expect(await after({ sessionId: 's1', env })).toEqual([
    { id: 'primary', usedPercent: 7, windowMinutes: 10080, resetsAt: iso(1795748999), primary: true },
    { id: 'secondary', usedPercent: 0, windowMinutes: 300 },
  ]);
  expect(await after({ sessionId: 's2', env })).toBeUndefined();
  expect(await after({ env })).toBeUndefined();
  fs.writeFileSync(file, '{}\n');
  expect(await after({ sessionId: 's1', env })).toBeUndefined();
});

it('句柄逐行采集，结束时可补报；读取器出错仍保留已取得的额度，免费时不创建读取器', async () => {
  box = new Sandbox();
  const line = claudeLine({ rateLimitType: 'five_hour', utilization: 0.67 });
  box.setScenario({ a1: [{ stream: [{ line }], text: '完成' }] });
  const { plugins } = await createApp({ cwd: box.project, env: box.env() });
  const fake = plugins.find(p => p.id === 'a1')!;
  const afterRun = vi.fn(async (): Promise<QuotaWindow[]> => [{ ...fiveHour, usedPercent: 70 }]);
  const quota = vi.fn(() => ({ ...claudePlugin.quota!(), afterRun }));
  const onQuota = vi.fn();
  const run = (free: boolean) => new AgentHandle('a1', { ...fake, quota }, { free }, {
    env: box.env(), envPass: [], startupTimeoutSeconds: 2,
  }).run({ access: 'read-only', cwd: box.project, workDir: box.dir, label: '测试', prompt: '测试', timeoutMs: 5000, onQuota });
  expect(await run(false)).toMatchObject({ outcome: 'ok', quota: [{ ...fiveHour, usedPercent: 70 }] });
  expect(onQuota.mock.calls.map(([windows]) => windows)).toEqual([[fiveHour], [{ ...fiveHour, usedPercent: 70 }]]);
  box.setScenario({ a1: [{ stream: [{ line }], text: '完成' }] });
  afterRun.mockRejectedValueOnce(new Error('读不了'));
  expect(await run(false)).toMatchObject({ outcome: 'ok', quota: [fiveHour] });
  box.setScenario({ a1: [{ stream: [{ line }], text: '完成' }] });
  onQuota.mockClear();
  expect(await run(true)).not.toHaveProperty('quota');
  expect(quota).toHaveBeenCalledTimes(2);
  expect(afterRun).toHaveBeenCalledTimes(2);
  expect(onQuota).not.toHaveBeenCalled();
});

it('跨运行去重并保留观测时间；视图给出全部窗口和免费标记', async () => {
  const disabled = { enabled: false };
  box = new Sandbox({ agentsExtra: { agents: {
    claude: disabled, codex: disabled, codebuddy: disabled, deepseek: disabled, a2: { free: true },
  } } });
  const { engine, plugins, state } = await createApp({ cwd: box.project, env: box.env() });
  plugins.find(p => p.id === 'a1')!.quota = claudePlugin.quota;
  const line = claudeLine({ rateLimitType: 'five_hour', utilization: 0.67 });
  const response = { stream: [{ line }, { line }], text: '完成' };
  box.setScenario({ a1: [response, response] });
  const events: ProgressEvent[] = [];
  engine.onProgress(e => { if (e.kind === 'quota') events.push(e); });
  const submit = () => engine.submit({ role: 'lead', task: '测试', origin: { channel: 'terminal', senderId: 'tester' } });
  expect((await submit()).status).toBe('done');
  const saved = new StateStore(box.home).getQuotas().a1!;
  expect(saved.windows).toEqual([fiveHour]);
  expect(Date.parse(saved.observedAt)).toBeGreaterThan(0);
  expect((await submit()).status).toBe('done');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ text: '', quota: { agent: 'a1', windows: [fiveHour] } });
  expect(state.getQuotas().a1).toEqual(saved);
  const expired = { id: 'old', usedPercent: 99, resetsAt: iso(1) };
  state.saveQuota('a1', [expired, fiveHour]);
  expect(state.saveQuota('a1', [fiveHour, expired])).toBe(false);
  state.saveQuota('a2', [fiveHour]);
  const views = await engine.agentsView();
  const quota = views.find(v => v.id === 'a1')?.quota;
  const now = new Date(2000);
  expect(quota).toEqual({ free: false, windows: [expired, fiveHour], observedAt: state.getQuotas().a1!.observedAt });
  expect(quotaPercent(quota, now)).toBe(67);
  expect(formatQuota(quota, now)).toBe('额度 5 小时 67%');
  expect(views.find(v => v.id === 'a2')?.quota).toEqual({ free: true, windows: [] });
  expect(views.find(v => v.id === 'a3')).not.toHaveProperty('quota');
  const reset = { ...fiveHour, resetsAt: iso(1) };
  expect(state.saveQuota('a1', [expired, reset])).toBe(true);
  const allExpired = (await engine.agentsView()).find(v => v.id === 'a1')?.quota;
  expect(allExpired?.windows).toEqual([expired, reset]);
  expect(quotaPercent(allExpired, now)).toBeUndefined();
  expect(formatQuota(allExpired, now)).toBe('额度未知');
});

it('状态栏额度取主窗口或最大值，四舍五入并保留超额', () => {
  const now = new Date(2000);
  const high = { id: 'week', usedPercent: 105.5 };
  expect(quotaPercent(undefined, now)).toBeUndefined();
  expect(quotaPercent({ free: false, windows: [] }, now)).toBeUndefined();
  expect(quotaPercent({ free: true, windows: [] }, now)).toBe(0);
  expect(quotaPercent({ free: false, windows: [high, fiveHour] }, now)).toBe(67);
  expect(quotaPercent({ free: false, windows: [high, { ...fiveHour, primary: undefined }] }, now)).toBe(106);
});

it('没有主窗口时取未过期窗口中的最大值', () => {
  const now = new Date(2000);
  const windows = [
    { id: '已重置', usedPercent: 99, resetsAt: now.toISOString() },
    { id: '周', usedPercent: 75, resetsAt: iso(3) },
    { id: '月', usedPercent: 39 },
  ];
  expect(quotaPercent({ free: false, windows }, now)).toBe(75);
});

it('额度明细列出未过期窗口，主窗口在前，按本地日期显示重置时刻', () => {
  const now = new Date(2026, 10, 21, 12);
  const week = { id: 'week', windowMinutes: 10080, usedPercent: 37, resetsAt: new Date(2026, 10, 23, 12).toISOString() };
  const today = { ...fiveHour, resetsAt: new Date(2026, 10, 21, 18, 30).toISOString() };
  const windows = [week, today];
  expect(formatQuota({ free: false, windows }, now)).toBe('额度 5 小时 67%（18:30 重置）、7 天 37%（11-23 12:00 重置）');
  const reset = new Date(today.resetsAt);
  expect(quotaPercent({ free: false, windows }, reset)).toBeUndefined();
  expect(formatQuota({ free: false, windows }, reset)).toBe('额度 7 天 37%（11-23 12:00 重置）');
  expect(windows).toEqual([week, today]);
  // 长度相同的两个窗口（Claude 实际会报两个 7 天窗口）要能分清：补上窗口标识；长度不重复的不受影响
  const twoWeeks = [today, { id: 'seven_day', windowMinutes: 10080, usedPercent: 39 }, { id: 'seven_day_overage_included', windowMinutes: 10080, usedPercent: 75 }];
  expect(formatQuota({ free: false, windows: twoWeeks }, now))
    .toBe('额度 5 小时 67%（18:30 重置）、7 天（seven_day）39%、7 天（seven_day_overage_included）75%');
  expect(formatQuota({ free: false, windows: [{ id: '额外', usedPercent: 9 }] }, now)).toBe('额度 额外 9%');
  expect(formatQuota({ free: false, windows: [{ ...fiveHour, windowMinutes: 45 }] }, now)).toBe('额度 45 分钟 67%');
  expect(formatQuota({ free: true, windows: [] }, now)).toBe('额度 0%（免费）');
  expect(formatQuota(undefined, now)).toBe('额度未知');
});

it('健康检查保存假 AI 报告的额度，命令行列出已知、免费和未知额度', async () => {
  const disabled = { enabled: false };
  box = new Sandbox({ agentsExtra: { agents: {
    claude: disabled, codex: disabled, codebuddy: disabled, deepseek: disabled, a2: { free: true },
  } } });
  const { engine, plugins } = await createApp({ cwd: box.project, env: box.env() });
  plugins.find(p => p.id === 'a1')!.quota = claudePlugin.quota;
  box.setScenario({ a1: [{ stream: [{ line: claudeLine({ rateLimitType: 'five_hour', utilization: 0.67 }) }], text: '可用' }] });
  expect(await engine.health('a1')).toMatchObject([{ agent: 'a1', ok: true }]);
  expect(new StateStore(box.home).getQuotas().a1?.windows).toEqual([fiveHour]);
  const result = await box.cli(['agents']);
  expect(result.code).toBe(0);
  expect(result.out).toMatch(/^a1（.* · 额度 5 小时 67%$/m);
  expect(result.out).toMatch(/^a2（.* · 额度 0%（免费）$/m);
  expect(result.out).toMatch(/^a3（.* · 额度未知$/m);
});

import { expect, it } from 'vitest';
import type { ProgressEvent, ProgressStepInfo } from '../src/core/types.js';
import { EMPTY_FEED, markStopping, reduceFeed, type FeedState } from '../src/ui/feed.js';

const step: ProgressStepInfo = { index: 1, kind: 'review', role: 'reviewer', roleLabel: '审查（reviewer）', agent: 'a' };

function freeze(value: object) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  Object.freeze(value);
}

function apply(state: FeedState, kind: ProgressEvent['kind'], data: Partial<ProgressEvent> = {}) {
  const event = { jobId: 'J1', text: '', kind, ...data };
  freeze(state);
  freeze(event);
  return reduceFeed(state, event, 100);
}

it.each([['ok', 'done'], ['timeout', 'timeout'], ['all_unavailable', 'failed']] as const)('步骤开始并按结果定稿 %s', (outcome, state) => {
  const running = apply(EMPTY_FEED, 'step_start', { step });
  expect(running.current).toMatchObject({ role: '审查', startedAt: 100, state: 'running' });
  const end = apply(apply(running, 'activity', { text: '读文件' }), 'step_end', { step: { ...step, durationMs: 99, outcome } });
  expect(end.lines).toMatchObject([{ type: 'step', step: { state, durationMs: 99, agent: 'a' } }]);
  expect(end.current).toBeUndefined();
  expect(end.activities).toEqual([]);
});

it('换人记录提示，新担当者接手时重新计时并清空活动', () => {
  const running = apply(EMPTY_FEED, 'step_start', { step });
  const notice = apply(apply(running, 'activity', { text: '思考中' }), 'fallback', { fallback: { from: 'a', to: 'b', reason: '额度用尽' } });
  expect(notice.lines).toMatchObject([{ type: 'notice', text: 'a 不可用（额度用尽），改用 b' }]);
  const next = reduceFeed(notice, { jobId: 'J1', kind: 'fallback', text: '', step: { ...step, agent: 'b' } }, 200);
  expect(next.current).toMatchObject({ agent: 'b', startedAt: 200 });
  expect(next.activities).toEqual([]);
  expect(next.lines).toBe(notice.lines);
});

it('活动按发生顺序保留，连续相同时复用原状态', () => {
  let state = apply(EMPTY_FEED, 'step_start', { step });
  for (const text of ['一', '二', '三', '思考中']) state = apply(state, 'activity', { text });
  expect(state.activities).toEqual(['一', '二', '三', '思考中']);
  expect(apply(state, 'activity', { text: '思考中' })).toBe(state);
  expect(markStopping(state).stopping).toBe(true);
  expect(state.stopping).toBe(false);
});

it('超过五百条时丢最旧的活动，新步骤从空开始', () => {
  let state = apply(EMPTY_FEED, 'step_start', { step });
  const activities = Array.from({ length: 507 }, (_, i) => `活动 ${i}`);
  for (const text of activities) state = apply(state, 'activity', { text });
  expect(state.activities).toEqual(activities.slice(7));
  expect(apply(state, 'step_start', { step }).activities).toEqual([]);
});

it('token 用量随事件更新当前步骤，步骤结束时带进结果行，活动不受影响', () => {
  const tokens = { input: 1000, cachedInput: 200, output: 30 };
  let state = apply(apply(EMPTY_FEED, 'step_start', { step }), 'activity', { text: '读文件' });
  const first = apply(state, 'usage', { step: { ...step, tokens } });
  expect(first.current).toMatchObject({ tokens, startedAt: 100 });
  expect(first.activities).toEqual(['读文件']);
  // 数没变、不是当前步骤、没有当前步骤时都复用原状态
  expect(apply(first, 'usage', { step: { ...step, tokens: { ...tokens } } })).toBe(first);
  expect(apply(first, 'usage', { step: { ...step, index: 9, tokens: { ...tokens, input: 5 } } })).toBe(first);
  expect(apply(EMPTY_FEED, 'usage', { step: { ...step, tokens } })).toBe(EMPTY_FEED);
  state = apply(first, 'usage', { step: { ...step, tokens: { ...tokens, output: 99 } } });
  expect(state.current?.tokens?.output).toBe(99);
  // 结束事件带了最终值就用它，没带时保留运行中最后看到的数
  const final = { input: 1200, cachedInput: 300, output: 150 };
  expect(apply(state, 'step_end', { step: { ...step, outcome: 'ok', durationMs: 5, tokens: final } }).lines).toMatchObject([{ step: { tokens: final } }]);
  expect(apply(state, 'step_end', { step: { ...step, outcome: 'ok', durationMs: 5 } }).lines).toMatchObject([{ step: { tokens: { output: 99 } } }]);
  // 新的一步从没有用量开始
  expect(apply(state, 'step_start', { step }).current?.tokens).toBeUndefined();
});

it('没有当前步骤时忽略活动，计划也不更新界面', () => {
  expect(apply(EMPTY_FEED, 'activity')).toBe(EMPTY_FEED);
  expect(apply(EMPTY_FEED, 'plan')).toBe(EMPTY_FEED);
});

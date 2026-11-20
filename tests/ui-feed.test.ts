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

it('活动保留最近三条，连续相同时复用原状态', () => {
  let state = apply(EMPTY_FEED, 'step_start', { step });
  for (const text of ['一', '二', '三', '思考中']) state = apply(state, 'activity', { text });
  expect(state.activities).toEqual(['二', '三', '思考中']);
  expect(apply(state, 'activity', { text: '思考中' })).toBe(state);
  expect(markStopping(state).stopping).toBe(true);
  expect(state.stopping).toBe(false);
});

it('没有当前步骤时忽略活动，计划也不更新界面', () => {
  expect(apply(EMPTY_FEED, 'activity')).toBe(EMPTY_FEED);
  expect(apply(EMPTY_FEED, 'plan')).toBe(EMPTY_FEED);
});

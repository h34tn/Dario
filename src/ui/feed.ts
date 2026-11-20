import type { ProgressEvent, StepKind } from '../core/types.js';

export interface StepView {
  index: number;
  kind: StepKind;
  role: string;
  agent?: string;
  state: 'running' | 'done' | 'failed' | 'timeout';
  startedAt: number;
  durationMs?: number;
}

export type FeedLine =
  | { type: 'step'; key: string; step: StepView }
  | { type: 'notice'; key: string; text: string };

export interface FeedState {
  lines: FeedLine[];
  current?: StepView;
  activities: string[];
  stopping: boolean;
}

export const EMPTY_FEED: FeedState = { lines: [], activities: [], stopping: false };
const MAX_ACTIVITIES = 500;

export function shortRole(label: string): string {
  return label.replace(/（[^（）]*）$/, '');
}

export function reduceFeed(state: FeedState, event: ProgressEvent, now: number): FeedState {
  const { kind, step, fallback } = event;
  if (kind === 'activity') {
    if (!state.current || state.activities.at(-1) === event.text) return state;
    return { ...state, activities: [...state.activities.slice(1 - MAX_ACTIVITIES), event.text] };
  }
  if (kind === 'fallback' && fallback) {
    const text = `${fallback.from} 不可用（${fallback.reason}），改用 ${fallback.to}`;
    return { ...state, lines: [...state.lines, { type: 'notice', key: `notice-${state.lines.length}`, text }] };
  }
  if (!step || (kind !== 'step_start' && kind !== 'step_end' && kind !== 'fallback')) return state;
  const view: StepView = {
    index: step.index, kind: step.kind, role: shortRole(step.roleLabel), agent: step.agent,
    state: 'running', startedAt: now,
  };
  if (kind !== 'step_end') return { ...state, current: view, activities: [] };
  view.state = step.outcome === 'ok' ? 'done' : step.outcome === 'timeout' ? 'timeout' : 'failed';
  view.durationMs = step.durationMs;
  view.startedAt = state.current?.startedAt ?? now - (step.durationMs ?? 0);
  const line: FeedLine = { type: 'step', key: `step-${state.lines.length}`, step: view };
  return { ...state, lines: [...state.lines, line], current: undefined, activities: [] };
}

export function markStopping(state: FeedState): FeedState {
  return { ...state, stopping: true };
}

/**
 * 用量基准：本项目以往同类步骤的用量中位数，供干活监控判断"用量异常"。
 */

import type { Job, StepKind } from './types.js';

export interface Median {
  median: number;
  /** 参与计算的步骤数。 */
  samples: number;
}

export interface UsageBaseline {
  /** 新输入（输入减去命中缓存的部分）。 */
  freshInput?: Median;
  /** 请求次数。只统计报了请求次数的步骤。 */
  requests?: Median;
}

function median(values: number[]): Median | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { median: value, samples: sorted.length };
}

/**
 * 从任务记录里算基准：同一项目、同一种步骤、同一家 AI、做成了、报了用量的步骤。
 * excludeJob 是正在进行的任务，不算在内。
 */
export function usageBaseline(jobs: Job[], key: { projectRoot: string; kind: StepKind; agent: string; excludeJob?: string }): UsageBaseline {
  const fresh: number[] = [];
  const requests: number[] = [];
  for (const job of jobs) {
    if (job.id === key.excludeJob || job.projectRoot !== key.projectRoot) continue;
    for (const s of job.steps ?? []) {
      if (s.kind !== key.kind || s.agent !== key.agent || s.outcome !== 'ok' || !s.tokens) continue;
      fresh.push(Math.max(0, s.tokens.input - s.tokens.cachedInput));
      if (s.tokens.requests !== undefined) requests.push(s.tokens.requests);
    }
  }
  const out: UsageBaseline = {};
  const f = median(fresh);
  const r = median(requests);
  if (f) out.freshInput = f;
  if (r) out.requests = r;
  return out;
}

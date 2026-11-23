import { parseVerdict, verdictPasses } from './plan.js';
import type { RoleBook } from './roles.js';
import { ACTIVE_STATUSES, STATUS_LABEL, type Job, type StepRecord } from './types.js';

/**
 * 续接从哪里接着做。failed 是停下的那一步的记录：没有记录（Dario 中断时那一轮没来得及记下）时为空。
 * - direct：直派的任务，重跑那一步。
 * - step：计划里 cursor 指的那一步。
 * - review：从 cursor 接着走正常流程（计划里的审查步骤，或计划走完后的自动审查）。
 * - rework：拿最近一次审查的问题直接返工，不先重审。extraRound 表示审查已经返工到上限，续接时多给一轮。
 */
export type ResumePoint =
  | { kind: 'direct'; role: string; failed?: StepRecord }
  | { kind: 'step'; role: string; failed?: StepRecord }
  | { kind: 'review'; role: string; failed?: StepRecord }
  | { kind: 'rework'; role: string; issues: string[]; reviewText: string; extraRound: boolean; failed?: StepRecord };

export type ResumeCheck = { ok: true; point: ResumePoint; where: string } | { ok: false; reason: string };

interface Roles {
  leadRole: string;
  reviewRole: string;
  /** 角色的显示名。 */
  label: (roleId: string) => string;
}

/** 审查不通过、要求返工的问题；通过或没有明确结论时为 undefined。规则与审查循环一致（verdictPasses）。 */
function rejection(rec: StepRecord): { issues: string[]; reviewText: string } | undefined {
  const verdict = parseVerdict(rec.text);
  if (!verdict || verdictPasses(verdict)) return undefined;
  return { issues: verdict.issues, reviewText: rec.text };
}

/** 按角色表判断：说明里的角色用它的第一个别名，没有别名用 id。 */
export function checkResume(job: Job, book: RoleBook, settings: { leadRole: string; reviewRole: string }): ResumeCheck {
  const label = (id: string): string => (book.has(id) ? book.get(id).alias[0] : undefined) ?? id;
  return resumeCheck(job, { ...settings, label });
}

/** 判断任务能否续接，能的话给出从哪里接。 */
export function resumeCheck(job: Job, roles: Roles): ResumeCheck {
  const no = (reason: string): ResumeCheck => ({ ok: false, reason });
  if (ACTIVE_STATUSES.includes(job.status)) return no(`还在进行（${STATUS_LABEL[job.status]}），结束后才能续接`);
  if (job.status === 'awaiting_approval') return no('计划在等待确认，用 approve 批准后执行');
  if (job.status === 'done') return no('已经完成');
  if (job.status === 'out_of_scope') return no('改动越界，处理越界改动之后请重新下达任务');
  if (job.strategy === 'isolated') return no('来自远程渠道，暂不支持续接');
  if (job.failureCode === 'plan_invalid') return no('没有出成合格的计划，请重新下达任务');

  const failedRec = (rec: StepRecord | undefined): StepRecord | undefined => (rec && rec.outcome !== 'ok' ? rec : undefined);
  const last = job.steps.at(-1);
  if (job.mode === 'direct') {
    return { ok: true, point: { kind: 'direct', role: job.role!, failed: failedRec(last) }, where: `这一步（${roles.label(job.role!)}）` };
  }
  const plan = job.plan;
  if (!plan) return no('停在出计划的阶段，还没有计划，请重新下达任务');
  if (job.dirtyAtStart === undefined) return no('计划还没有开始执行（没有批准，或者批准之前就停下了），请重新下达任务');

  const step = plan.steps[job.cursor];
  const leadStep = step !== undefined && step.role === roles.leadRole && step.writes;
  // 停在版本控制步骤之前的那次审查或返工：按审查、返工处理，不能直接去提交
  const beforeGit = step?.git === true && (last?.kind === 'review' || last?.kind === 'rework');
  if (step && !beforeGit && (leadStep || step.role !== roles.reviewRole)) {
    const failed = last?.kind === 'step' ? failedRec(last) : undefined;
    return { ok: true, point: { kind: 'step', role: step.role, failed }, where: `计划第 ${job.cursor + 1} 步（${roles.label(step.role)}）` };
  }

  // 停在审查或返工：计划里的审查步骤，或者计划走完后自动追加的审查
  const planned = step !== undefined && !beforeGit;
  const reviewWhere = planned ? `计划第 ${job.cursor + 1} 步（${roles.label(roles.reviewRole)}）` : '审查';
  const writer = job.lastWriter;
  const reworkAt = (review: StepRecord | undefined, failed: StepRecord | undefined, extraRound: boolean): ResumeCheck | undefined => {
    const got = review && rejection(review);
    if (!got || !writer) return undefined;
    return {
      ok: true,
      point: { kind: 'rework', role: writer.role, ...got, extraRound, failed },
      where: `返工（${roles.label(writer.role)}，按最近一次审查的问题）`,
    };
  };
  if (last?.kind === 'rework' && last.outcome !== 'ok') {
    const review = [...job.steps].reverse().find((s) => s.kind === 'review' && s.outcome === 'ok');
    const at = reworkAt(review, last, false);
    if (at) return at;
  }
  if (last?.kind === 'review' && last.outcome === 'ok') {
    if (job.failureCode === 'review_rejected' && !writer) return no('审查没有通过，而且没有可以返工的执行者');
    const at = reworkAt(last, undefined, job.failureCode === 'review_rejected');
    if (at) return at;
  }
  const failed = last?.kind === 'review' ? failedRec(last) : undefined;
  // 改动都审查过了，剩下的只有汇总
  const toReview = planned || !job.reviewedSinceChange;
  return {
    ok: true,
    point: { kind: 'review', role: toReview ? roles.reviewRole : roles.leadRole, failed },
    where: toReview ? reviewWhere : '最后的汇总',
  };
}

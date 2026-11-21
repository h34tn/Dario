import type { ProjectConfig } from './config.js';
import { parsePlan, parseVerdict } from './plan.js';
import {
  carriedPrompt,
  planFollowUp,
  planPrompt,
  priorSteps,
  reviewFollowUp,
  reviewPrompt,
  reworkFollowUp,
  reworkPrompt,
  stepFollowUp,
  stepPrompt,
  summaryFollowUp,
  summaryPrompt,
} from './prompts.js';
import type { RoleBook } from './roles.js';
import type { StepRunner } from './runner.js';
import type { StateStore } from './state.js';
import type { Access, FallbackQuestion, Job, JobStatus, Plan, ProgressEvent, StepKind, StepRecord } from './types.js';
import { DarioError, ellipsis, truncate } from './util.js';
import { outOfScope, type Workspace } from './workspace.js';

export interface OrchestratorDeps {
  state: StateStore;
  roles: RoleBook;
  runner: StepRunner;
  project: ProjectConfig;
  emit: (event: ProgressEvent) => void;
}

export interface RunOptions {
  /** 含改文件步骤的计划是否免确认。 */
  autoApprove: boolean;
  /** 当场询问是否执行计划（终端交互方式）。不提供时任务停在"等待确认"。 */
  confirm?: (job: Job) => Promise<boolean>;
  /**
   * 角色表的 fallback 为 ask 时，换人之前当场询问。不提供表示没有办法询问，此时不换人、这一步停止。
   * 加了 --yes 的调用方传一个直接返回 true 的函数。
   */
  confirmFallback?: (question: FallbackQuestion) => Promise<boolean>;
}

class Cancelled extends Error {}

/** 一步失败后任务的去向。 */
function statusForOutcome(outcome: StepRecord['outcome']): JobStatus {
  return outcome === 'timeout' ? 'timeout' : 'failed';
}

export function describePlan(plan: Plan, roles: RoleBook): string {
  if (plan.steps.length === 0) return plan.summary || '（无步骤）';
  const lines = plan.steps.map(
    (s, i) => `${i + 1}. [${roles.label(s.role)}${s.writes ? '，改文件' : '，只读'}] ${ellipsis(s.task, 160)}`,
  );
  return `${plan.summary ? `${plan.summary}\n` : ''}${lines.join('\n')}`;
}

/** 推进一个任务：直派，或"计划、确认、执行、审查、返工、汇总"。 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * 推进任务直到结束或停在"等待确认"。
   * 传入"排队"状态的任务从头开始；传入"等待确认"状态的任务表示已获批准，从执行阶段继续。
   */
  async run(job: Job, ws: Workspace, opts: RunOptions): Promise<Job> {
    const { state } = this.deps;
    let conclusion = '';
    try {
      if (job.status === 'queued') {
        if (job.mode === 'direct') {
          conclusion = await this.runDirect(job, ws, opts);
        } else {
          const proceed = await this.planPhase(job, ws, opts);
          if (!proceed) {
            // planPhase 会改写 job.status，这里按完整的状态类型重新读取
            const after = job.status as JobStatus;
            if (after !== 'awaiting_approval') await this.finish(job, ws, job.result?.conclusion ?? '');
            else job.ownerPid = undefined;
            return this.save(job);
          }
          conclusion = await this.execPhase(job, ws, opts);
        }
      } else if (job.status === 'awaiting_approval') {
        conclusion = await this.execPhase(job, ws, opts);
      } else {
        throw new DarioError(`任务 ${job.id} 处于"${job.status}"状态，不能继续推进。`);
      }
    } catch (e) {
      if (e instanceof Cancelled) {
        job.status = 'cancelled';
        conclusion = '任务已取消。';
      } else if (e instanceof DarioError) {
        job.status = 'failed';
        job.failureCode = 'workspace';
        conclusion = e.message;
      } else {
        throw e;
      }
    }
    await this.finish(job, ws, conclusion);
    state.audit('job_end', { job: job.id, status: job.status, failure: job.failureCode });
    return this.save(job);
  }

  private save(job: Job): Job {
    this.deps.state.saveJob(job);
    return job;
  }

  private setStatus(job: Job, status: JobStatus): void {
    job.status = status;
    this.save(job);
  }

  /** 取消可能来自另一个进程，从磁盘上的记录确认。 */
  private checkCancel(job: Job): void {
    if (this.deps.state.isCancelRequested(job.id)) {
      job.cancelRequested = true;
      throw new Cancelled();
    }
  }

  private avoidFor(job: Job, roleId: string): string | undefined {
    const other = this.deps.roles.get(roleId).mustDifferFrom;
    if (!other) return undefined;
    for (let i = job.steps.length - 1; i >= 0; i--) {
      const s = job.steps[i]!;
      if (s.role === other && s.agent && s.outcome === 'ok') return s.agent;
    }
    return undefined;
  }

  private async execStep(
    job: Job,
    ws: Workspace,
    opts: RunOptions,
    req: { kind: StepKind; roleId: string; prompt: string; followUp?: string; task?: string; access?: Access; prefer?: string },
  ): Promise<StepRecord> {
    this.checkCancel(job);
    const before = await ws.stamp();
    const avoid = this.avoidFor(job, req.roleId);
    const rec = await this.deps.runner.run({ job, cwd: ws.cwd, avoid, confirmFallback: opts.confirmFallback, ...req });
    rec.changedFiles = await ws.changedSince(before);
    job.steps.push(rec);
    job.activePid = undefined;

    const writable = rec.access === 'write';
    if (rec.changedFiles.length > 0) {
      job.changedFiles = [...new Set([...job.changedFiles, ...rec.changedFiles])].sort();
      job.reviewedSinceChange = false;
      if (!writable) {
        job.readOnlyViolation = true;
        job.warnings.push(`只读角色 ${req.roleId}（${rec.agent ?? '?'}）改动了文件：${rec.changedFiles.join('、')}`);
      }
    } else if (before === null && writable && rec.outcome === 'ok' && (req.kind === 'step' || req.kind === 'rework')) {
      job.unknownChanges = true;
      job.reviewedSinceChange = false;
    }
    if (writable && rec.outcome === 'ok' && rec.agent && (req.kind === 'step' || req.kind === 'rework')) {
      job.lastWriter = { role: req.roleId, agent: rec.agent, task: req.kind === 'rework' ? (job.lastWriter?.task ?? req.task ?? '') : (req.task ?? '') };
    }
    if (avoid && rec.agent === avoid) {
      job.warnings.push(`${this.deps.roles.label(req.roleId)}与${this.deps.roles.get(req.roleId).mustDifferFrom}由同一家 AI（${avoid}）担当：没有其他可用的候选。`);
    }
    this.save(job);
    this.checkCancel(job);
    return rec;
  }

  /**
   * 这个角色有会话可以续接时，给出续接用的说明，否则 undefined。
   * 会话在本任务里上过场：只发增量，delta 收到的是它最近一次工作的步骤下标。
   * 会话是上一个任务带过来的：它不知道这个新任务，发完整说明，前面交代一句。
   * 有会话不等于一定续接：担当者换了人时执行器会改用完整的任务说明新开会话。
   */
  private followUp(job: Job, roleId: string, full: string, delta: (after: number) => string | undefined): string | undefined {
    const session = job.sessions?.[roleId];
    if (!session) return undefined;
    return session.step < 0 ? carriedPrompt(full) : delta(session.step);
  }

  /** 把一步的失败记到任务上，返回给发起人看的说明。 */
  private failFromStep(job: Job, rec: StepRecord): string {
    job.status = statusForOutcome(rec.outcome);
    job.failureCode = rec.outcome === 'all_unavailable' ? 'all_unavailable' : 'task_failed';
    const who = rec.agent ? `${rec.agent} ` : '';
    const what =
      // "没能执行"涵盖几种情况：候选都不可用、fallback 为 manual、没有同意换人。具体是哪种由后面的原因说明
      rec.outcome === 'timeout' ? '超时' : rec.outcome === 'all_unavailable' ? '没能执行' : '没有完成';
    return `第 ${rec.index + 1} 步（${this.deps.roles.label(rec.role)}）${who}${what}。${rec.reason ?? ''}${rec.text ? `\n${truncate(rec.text, 2000)}` : ''}`;
  }

  private async runDirect(job: Job, ws: Workspace, opts: RunOptions): Promise<string> {
    const { roles, project } = this.deps;
    const roleId = job.role!;
    const role = roles.get(roleId);
    job.branch = (await ws.enterExec(job.id)).branch;
    this.setStatus(job, 'running');
    const prompt = stepPrompt(project, role, role.access, job.task, job.context);
    const rec = await this.execStep(job, ws, opts, {
      kind: 'step',
      roleId,
      task: job.task,
      prompt,
      // 直派只有一步，能续接的只有上一个任务带过来的会话
      followUp: this.followUp(job, roleId, prompt, () => undefined),
    });
    if (rec.outcome !== 'ok') return this.failFromStep(job, rec);
    job.status = 'done';
    return rec.text;
  }

  /** 返回 true 表示可以进入执行阶段。 */
  private async planPhase(job: Job, ws: Workspace, opts: RunOptions): Promise<boolean> {
    const { roles, project, emit } = this.deps;
    const lead = project.settings.leadRole;
    await ws.enterPlan();
    this.setStatus(job, 'planning');

    let feedback: string | undefined;
    let plan: Plan | undefined;
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const prompt = planPrompt(project, roles, job.task, job.context, feedback);
      const problem = feedback;
      const rec = await this.execStep(job, ws, opts, {
        kind: 'plan',
        roleId: lead,
        access: 'read-only',
        task: job.task,
        prompt,
        followUp: this.followUp(job, lead, prompt, () => (problem !== undefined ? planFollowUp(problem) : undefined)),
      });
      if (rec.outcome !== 'ok') {
        job.result = { conclusion: this.failFromStep(job, rec), changedFiles: [], fallbackHappened: false, warnings: [] };
        return false;
      }
      const parsed = parsePlan(rec.text, { roles, leadRole: lead, maxSteps: project.settings.maxPlanSteps });
      if ('plan' in parsed) plan = parsed.plan;
      else feedback = parsed.error;
    }
    if (!plan) {
      job.status = 'failed';
      job.failureCode = 'plan_invalid';
      job.result = { conclusion: `主控两次都没有给出合格的计划，任务没有执行。${feedback ?? ''}`, changedFiles: [], fallbackHappened: false, warnings: [] };
      return false;
    }
    job.plan = plan;
    job.cursor = 0;
    this.save(job);

    if (plan.steps.length === 0) {
      job.status = 'done';
      job.result = { conclusion: plan.answer || plan.summary, changedFiles: [], fallbackHappened: false, warnings: [] };
      return false;
    }
    emit({ jobId: job.id, kind: 'plan', text: describePlan(plan, roles) });

    const needsApproval = plan.steps.some((s) => s.writes);
    if (needsApproval && !opts.autoApprove) {
      if (!opts.confirm) {
        this.setStatus(job, 'awaiting_approval');
        return false;
      }
      this.setStatus(job, 'awaiting_approval');
      const approved = await opts.confirm(job);
      if (!approved) {
        job.status = 'cancelled';
        job.result = { conclusion: '计划没有被批准，任务已取消。', changedFiles: [], fallbackHappened: false, warnings: [] };
        return false;
      }
    }
    return true;
  }

  private async execPhase(job: Job, ws: Workspace, opts: RunOptions): Promise<string> {
    const { roles, project } = this.deps;
    const plan = job.plan;
    if (!plan) throw new DarioError(`任务 ${job.id} 没有计划，无法执行。`);
    const reviewRole = project.settings.reviewRole;
    job.branch = (await ws.enterExec(job.id)).branch;
    this.setStatus(job, 'running');

    for (; job.cursor < plan.steps.length; job.cursor++) {
      const step = plan.steps[job.cursor]!;
      if (step.role === reviewRole) {
        const failure = await this.reviewLoop(job, ws, opts, step.task);
        if (failure !== undefined) return failure;
        this.setStatus(job, 'running');
        continue;
      }
      const role = roles.get(step.role);
      const prompt = stepPrompt(project, role, role.access, step.task, priorSteps(job) || job.context, step.acceptance);
      const rec = await this.execStep(job, ws, opts, {
        kind: 'step',
        roleId: step.role,
        task: step.task,
        prompt,
        followUp: this.followUp(job, step.role, prompt, (after) => stepFollowUp(project, role, role.access, step.task, job, after, step.acceptance)),
      });
      if (rec.outcome !== 'ok') return this.failFromStep(job, rec);
    }

    const changed = job.changedFiles.length > 0 || job.unknownChanges === true;
    if (changed && !job.reviewedSinceChange && roles.has(reviewRole)) {
      const failure = await this.reviewLoop(job, ws, opts, undefined);
      if (failure !== undefined) return failure;
    }

    this.setStatus(job, 'running');
    const summaryText = summaryPrompt(job, job.steps);
    const summary = await this.execStep(job, ws, opts, {
      kind: 'summary',
      roleId: project.settings.leadRole,
      access: 'read-only',
      prompt: summaryText,
      followUp: this.followUp(job, project.settings.leadRole, summaryText, () => summaryFollowUp(job, job.steps)),
    });
    job.status = 'done';
    if (summary.outcome === 'ok' && summary.text.trim()) return summary.text;
    job.warnings.push('主控没能给出汇总，下面是各步结果的拼接。');
    return job.steps
      .filter((s) => s.kind === 'step' || s.kind === 'rework' || s.kind === 'review')
      .map((s) => `第 ${s.index + 1} 步（${s.role}，${s.agent ?? '-'}）：${truncate(s.text, 1500)}`)
      .join('\n\n');
  }

  /** 审查并在不通过时返工。通过返回 undefined；失败时返回说明，任务状态已设置。 */
  private async reviewLoop(job: Job, ws: Workspace, opts: RunOptions, extraTask: string | undefined): Promise<string | undefined> {
    const { roles, project } = this.deps;
    const reviewRole = project.settings.reviewRole;
    for (;;) {
      this.setStatus(job, 'reviewing');
      const reviewText = reviewPrompt(project, roles.get(reviewRole), job, extraTask);
      const rec = await this.execStep(job, ws, opts, {
        kind: 'review',
        roleId: reviewRole,
        access: 'read-only',
        task: extraTask,
        prompt: reviewText,
        followUp: this.followUp(job, reviewRole, reviewText, (after) => reviewFollowUp(project, roles.get(reviewRole), job, after, extraTask)),
      });
      if (rec.outcome !== 'ok') return this.failFromStep(job, rec);
      job.reviewedSinceChange = true;
      const verdict = parseVerdict(rec.text);
      if (!verdict) {
        job.warnings.push('审查没有给出明确的"通过 / 不通过"结论，未触发返工。');
        return undefined;
      }
      if (verdict.verdict === 'pass') return undefined;

      const issues = verdict.issues.length ? verdict.issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : truncate(rec.text, 2000);
      if (!job.lastWriter) {
        job.status = 'failed';
        job.failureCode = 'review_rejected';
        return `审查没有通过，且没有可以返工的执行者。\n${issues}`;
      }
      if (job.reworkRounds >= project.settings.maxReworkRounds) {
        job.status = 'failed';
        job.failureCode = 'review_rejected';
        return `审查没有通过，已返工 ${job.reworkRounds} 轮，达到上限。仍存在的问题：\n${issues}`;
      }
      job.reworkRounds++;
      this.setStatus(job, 'running');
      const writer = job.lastWriter;
      const reworkText = reworkPrompt(project, roles.get(writer.role), writer.task, verdict.issues, rec.text);
      const rework = await this.execStep(job, ws, opts, {
        kind: 'rework',
        roleId: writer.role,
        prefer: writer.agent,
        task: writer.task,
        prompt: reworkText,
        followUp: this.followUp(job, writer.role, reworkText, (after) => reworkFollowUp(project, roles.get(writer.role), job, after, verdict.issues, rec.text)),
      });
      if (rework.outcome !== 'ok') return this.failFromStep(job, rework);
    }
  }

  /** 收尾：范围检查、工作区处理、组装结果。 */
  private async finish(job: Job, ws: Workspace, conclusion: string): Promise<void> {
    const { project } = this.deps;
    job.activePid = undefined;
    job.ownerPid = undefined;
    const outside = outOfScope(job.changedFiles, project.settings.writeRoots);
    const violation = outside.length > 0 || job.readOnlyViolation === true;
    if (outside.length > 0) job.warnings.push(`改动了允许范围之外的文件：${outside.join('、')}`);

    let branch = job.branch;
    try {
      const fin = await ws.finalize(job.id, { changed: job.changedFiles, violation });
      branch = fin.branch;
      job.warnings.push(...fin.warnings);
    } catch (e) {
      job.warnings.push(`收尾时出错：${(e as Error).message}`);
    }
    job.branch = branch;

    if (violation && ws.strategy === 'isolated' && job.status !== 'cancelled') {
      job.status = 'out_of_scope';
      job.failureCode = 'out_of_scope';
    }
    const failed = job.status !== 'done' && job.status !== 'awaiting_approval';
    job.result = {
      conclusion: conclusion || job.result?.conclusion || '',
      changedFiles: job.changedFiles,
      // 实际执行者之前有候选因不可用被跳过或试过失败，即发生了换人
      fallbackHappened: job.steps.some((s) => s.agent !== undefined && s.attempts.some((a) => a.agent !== s.agent && a.outcome !== 'ok')),
      warnings: [...new Set(job.warnings)],
      branch,
      unfinished: failed ? conclusion || job.result?.conclusion : undefined,
    };
  }
}

import type { ProjectConfig } from './config.js';
import { diffText, readRefs } from './handoff.js';
import { parsePlan, parseVerdict } from './plan.js';
import {
  carriedPrompt,
  filesChangedAfter,
  leadStepFollowUp,
  parseBlocked,
  planBrief,
  planCarried,
  planFollowUp,
  planPrompt,
  priorSteps,
  reviewBrief,
  reviewCarried,
  reviewFollowUp,
  reviewPrompt,
  type ChangeDiff,
  reworkFollowUp,
  reworkPrompt,
  stepBrief,
  stepCarried,
  stepFollowUp,
  stepPrompt,
  withChanges,
  withRefs,
  withScope,
  summaryFollowUp,
  summaryPrompt,
} from './prompts.js';
import type { RoleBook } from './roles.js';
import type { StepRunner } from './runner.js';
import { inScope, normalizeScopePath, reworkScope } from './scope.js';
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
    (s, i) => `${i + 1}. [${roles.label(s.role, 'plan')}${s.writes ? '，改文件' : '，只读'}] ${ellipsis(s.task, 160)}${s.files?.length ? `\n   范围：${s.files.join('、')}` : ''}${s.refs?.length ? `\n   参考：${s.refs.join('、')}` : ''}`,
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
        await this.syncPhase(job, ws);
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

  /** 开工前与远端同步（项目设置了才做）。同步不了又不能继续时由工作区抛出，任务按"没有开始"结束。 */
  private async syncPhase(job: Job, ws: Workspace): Promise<void> {
    if (!ws.syncRemote) return;
    const report = await ws.syncRemote();
    // 记在任务上：各角色第一次上场时据此得知哪些文件刚被更新，等待确认后换进程继续时也还在
    if (report.pulled) {
      job.pulled = report.pulled;
      this.save(job);
    }
    for (const text of report.notes) this.deps.emit({ jobId: job.id, kind: 'phase', text });
    for (const text of report.warnings) {
      job.warnings.push(text);
      this.deps.emit({ jobId: job.id, kind: 'phase', text });
    }
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

  private avoidFor(job: Job, roleId: string, kind: StepKind): { role: string; agent: string } | undefined {
    const other = this.deps.roles.get(roleId).mustDifferFrom;
    if (!other) return undefined;
    if (kind === 'review' && this.deps.project.settings.leadImplements && job.lastWriter) return job.lastWriter;
    for (let i = job.steps.length - 1; i >= 0; i--) {
      const s = job.steps[i]!;
      if (s.role === other && s.agent && s.outcome === 'ok') return { role: other, agent: s.agent };
    }
    return undefined;
  }

  private async execStep(
    job: Job,
    ws: Workspace,
    opts: RunOptions,
    req: { kind: StepKind; roleId: string; prompt: string; followUp?: string; brief?: string; task?: string; access?: Access; prefer?: string; scope?: string[] },
  ): Promise<StepRecord> {
    this.checkCancel(job);
    const before = await ws.stamp();
    const avoid = this.avoidFor(job, req.roleId, req.kind);
    const rec = await this.deps.runner.run({ job, cwd: ws.cwd, avoid: avoid?.agent, confirmFallback: opts.confirmFallback, ...req });
    rec.changedFiles = await ws.changedSince(before);
    if (req.scope) this.checkOffPlan(job, rec, req.scope);
    // 角色报告必需的工具或服务用不了：这一步算没做成，任务就此停下并告知发起人。
    // 会话仍然留着，问题解决后再下达任务可以接着做。
    const blocked = rec.outcome === 'ok' ? parseBlocked(rec.text) : undefined;
    if (blocked) {
      rec.outcome = 'task_failed';
      rec.reason = `必需的工具或服务用不了，已停下：${blocked}。恢复之后再下达一次任务（或让它继续），各角色会接着原来的会话做。`;
      this.deps.emit({ jobId: job.id, kind: 'phase', text: `第 ${rec.index + 1} 步受阻，任务停下：${blocked}` });
    }
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
    if (avoid && rec.agent === avoid.agent) {
      job.warnings.push(`${this.deps.roles.label(req.roleId)}与${avoid.role}由同一家 AI（${avoid.agent}）担当：没有其他可用的候选。`);
    }
    this.save(job);
    this.checkCancel(job);
    return rec;
  }

  /**
   * 偏离计划的复核：这一步实际改动的文件里，有不在计划范围内、运行中又没报过的（例如用命令改的），补报。
   * 这一步已经结束，只能提示。
   */
  private checkOffPlan(job: Job, rec: StepRecord, scope: string[]): void {
    const action = this.deps.project.settings.supervise.offPlan.action;
    if (action === 'off' || rec.access !== 'write') return;
    const seen = new Set((rec.alerts ?? []).filter((a) => a.rule === 'off_plan' && a.target).map((a) => normalizeScopePath(a.target!)));
    const roleLabel = this.deps.roles.label(rec.role);
    for (const file of rec.changedFiles) {
      if (seen.has(normalizeScopePath(file)) || inScope(file, scope)) continue;
      const alert = { rule: 'off_plan' as const, action, atMs: rec.durationMs, detail: `改动了计划范围之外的文件：${file}（这一步结束后检查发现）`, target: file };
      (rec.alerts ??= []).push(alert);
      job.warnings.push(`第 ${rec.index + 1} 步（${roleLabel}，${rec.agent ?? '-'}）：${alert.detail}`);
      this.deps.state.audit('watch_alert', { job: job.id, step: rec.index, role: rec.role, agent: rec.agent, rule: alert.rule, action, detail: alert.detail });
      this.deps.emit({
        jobId: job.id,
        kind: 'watch',
        step: { index: rec.index, kind: rec.kind, role: rec.role, roleLabel, agent: rec.agent },
        alert,
        text: `第 ${rec.index + 1} 步（${roleLabel}）：${alert.detail}`,
      });
    }
  }

  /**
   * 这个角色有会话可以续接时，给出续接用的说明，否则 undefined。
   * 会话在本任务里上过场：只发增量，delta 收到的是它最近一次工作的步骤下标。
   * 会话是上一个任务带过来的：它不知道这个新任务，交代新任务。
   * 固定说明（角色、规则、项目约定、输出格式）只发一次：brief 是这类说明固定部分的指纹，
   * 会话上记的指纹与它相同（briefed）时用精简的写法，否则照常带上固定说明。
   * 有会话不等于一定续接：担当者换了人时执行器会改用完整的任务说明新开会话。
   */
  private followUp(
    job: Job,
    roleId: string,
    brief: string | undefined,
    how: { full: string; carried?: () => string; delta: (after: number, briefed: boolean) => string | undefined },
  ): string | undefined {
    const session = job.sessions?.[roleId];
    if (!session) return undefined;
    const briefed = brief !== undefined && session.brief === brief;
    if (session.step < 0) return briefed && how.carried ? how.carried() : carriedPrompt(how.full);
    return how.delta(session.step, briefed);
  }

  /**
   * 给带过来的会话看的上文。上文是上一个任务的结论；这个会话最近一次干活就在那个任务里的话，
   * 经过和结论它都已经知道，不再重发。新开的会话不走这里，照常收到上文。
   */
  private carriedContext(job: Job, roleId: string): string | undefined {
    const session = job.sessions?.[roleId];
    const known = session !== undefined && job.contextJob !== undefined && session.job === job.contextJob;
    return known ? undefined : job.context;
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
    const prompt = stepPrompt(project, role, role.access, job.task, job.context, undefined, job.pulled);
    const brief = stepBrief(project, role, role.access);
    const rec = await this.execStep(job, ws, opts, {
      kind: 'step',
      roleId,
      task: job.task,
      prompt,
      brief,
      // 直派只有一步，能续接的只有上一个任务带过来的会话
      followUp: this.followUp(job, roleId, brief, {
        full: stepPrompt(project, role, role.access, job.task, this.carriedContext(job, roleId), undefined, job.pulled),
        carried: () => stepCarried(role, role.access, job.task, this.carriedContext(job, roleId), undefined, job.pulled),
        delta: () => undefined,
      }),
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
      const prompt = planPrompt(project, roles, job.task, job.context, feedback, job.pulled);
      const problem = feedback;
      const brief = planBrief(project, roles);
      const rec = await this.execStep(job, ws, opts, {
        kind: 'plan',
        roleId: lead,
        access: 'read-only',
        task: job.task,
        prompt,
        brief,
        followUp: this.followUp(job, lead, brief, {
          full: planPrompt(project, roles, job.task, this.carriedContext(job, lead), feedback, job.pulled),
          carried: () => planCarried(project.settings.leadImplements, job.task, this.carriedContext(job, lead), job.pulled),
          delta: () => (problem !== undefined ? planFollowUp(problem) : undefined),
        }),
      });
      if (rec.outcome !== 'ok') {
        job.result = { conclusion: this.failFromStep(job, rec), changedFiles: [], fallbackHappened: false, warnings: [] };
        return false;
      }
      const parsed = parsePlan(rec.text, { roles, ...project.settings });
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
    if (!project.settings.leadImplements && plan.steps.some(step => step.role === project.settings.leadRole)) {
      job.status = 'failed';
      job.failureCode = 'plan_invalid';
      return '项目已关闭 lead_implements，这份计划包含主控自己的步骤，请重新出计划。';
    }
    const reviewRole = project.settings.reviewRole;
    job.branch = (await ws.enterExec(job.id)).branch;
    if (job.dirtyAtStart === undefined) {
      const stamp = await ws.stamp();
      job.dirtyAtStart = stamp ? [...stamp.keys()].sort() : [];
    }
    this.setStatus(job, 'running');

    for (; job.cursor < plan.steps.length; job.cursor++) {
      const step = plan.steps[job.cursor]!;
      const leadStep = step.role === project.settings.leadRole && step.writes;
      if (!leadStep && step.role === reviewRole) {
        const failure = await this.reviewLoop(job, ws, opts, step.task);
        if (failure !== undefined) return failure;
        this.setStatus(job, 'running');
        continue;
      }
      const role = roles.get(step.role);
      const context = priorSteps(job) || job.context;
      const access = leadStep ? 'write' : role.access;
      const scoped = withScope(step.task, step.writes ? step.files : undefined);
      // 主控自己的步骤续接时它刚读过这些代码，不再附；新开会话和其他角色都附上
      const withCode = withRefs(scoped, step.refs?.length ? readRefs(ws.cwd, step.refs, project.settings.handoffMaxChars, job.changedFiles) : undefined);
      // 前面步骤的改动附上 diff；续接的会话只附它上次工作之后别人改过的文件
      const task = withChanges(withCode, await this.changeDiff(job, ws, job.changedFiles));
      const lastStep = job.sessions?.[step.role]?.step ?? -1;
      const sinceDiff = lastStep >= 0 ? await this.changeDiff(job, ws, filesChangedAfter(job, lastStep)) : undefined;
      const prompt = stepPrompt(project, role, access, task, context, step.acceptance, job.pulled);
      const brief = leadStep ? undefined : stepBrief(project, role, access);
      const rec = await this.execStep(job, ws, opts, {
        kind: 'step',
        roleId: step.role,
        access,
        task: step.task,
        ...(step.writes && step.files?.length && { scope: step.files }),
        prompt,
        brief,
        followUp: this.followUp(job, step.role, brief, {
          full: stepPrompt(project, role, access, task, priorSteps(job) || this.carriedContext(job, step.role), step.acceptance, job.pulled),
          carried: () => stepCarried(role, access, task, priorSteps(job) || this.carriedContext(job, step.role), step.acceptance, job.pulled),
          delta: (after, briefed) => {
            const since = after === lastStep ? sinceDiff : undefined;
            return leadStep
              ? leadStepFollowUp(project, role, withChanges(scoped, since), job, after, step.acceptance)
              : stepFollowUp(project, role, access, withChanges(withCode, since), job, after, step.acceptance, briefed);
          },
        }),
      });
      if (rec.outcome !== 'ok') return this.failFromStep(job, rec);
    }

    const changed = job.changedFiles.length > 0 || job.unknownChanges === true;
    if (changed && !job.reviewedSinceChange && roles.has(reviewRole) && !(await this.smallEnoughToSkipReview(job, ws))) {
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
      // 汇总没有固定说明，不带指纹：会话上已有的指纹原样保留
      followUp: this.followUp(job, project.settings.leadRole, undefined, { full: summaryText, delta: () => summaryFollowUp(job, job.steps) }),
    });
    job.status = 'done';
    if (summary.outcome === 'ok' && summary.text.trim()) return summary.text;
    job.warnings.push('主控没能给出汇总，下面是各步结果的拼接。');
    return job.steps
      .filter((s) => s.kind === 'step' || s.kind === 'rework' || s.kind === 'review')
      .map((s) => `第 ${s.index + 1} 步（${s.role}，${s.agent ?? '-'}）：${truncate(s.text, 1500)}`)
      .join('\n\n');
  }

  /**
   * 改动足够小时跳过自动追加的审查（review_skip_max_lines）。统计不出行数、有检测不到的改动、
   * 改了允许范围之外的文件或只读角色动了文件时照常审查。
   */
  private async smallEnoughToSkipReview(job: Job, ws: Workspace): Promise<boolean> {
    const { settings } = this.deps.project;
    const limit = settings.reviewSkipMaxLines;
    if (limit <= 0 || job.unknownChanges || job.readOnlyViolation) return false;
    if (outOfScope(job.changedFiles, settings.writeRoots).length > 0) return false;
    const lines = await ws.changedLines(job.changedFiles);
    if (lines === undefined || lines > limit) return false;
    const text = `改动共 ${lines} 行，不超过 review_skip_max_lines（${limit}），跳过了自动审查。`;
    job.warnings.push(text);
    this.deps.emit({ jobId: job.id, kind: 'phase', text });
    return true;
  }

  /** 给审查和后续步骤附的 diff。取不到（不是 git 仓库、关掉了、没有改动）时为 undefined，照旧让角色自己去读文件。 */
  private async changeDiff(job: Job, ws: Workspace, files: string[]): Promise<ChangeDiff | undefined> {
    const got = await diffText(ws.cwd, files, this.deps.project.settings.handoffMaxChars);
    if (!got) return undefined;
    const before = new Set(job.dirtyAtStart ?? []);
    return { text: got.text, omitted: got.omitted, preexisting: files.filter((f) => before.has(f)) };
  }

  /** 审查并在不通过时返工。通过返回 undefined；失败时返回说明，任务状态已设置。 */
  private async reviewLoop(job: Job, ws: Workspace, opts: RunOptions, extraTask: string | undefined): Promise<string | undefined> {
    const { roles, project } = this.deps;
    const reviewRole = project.settings.reviewRole;
    for (;;) {
      this.setStatus(job, 'reviewing');
      const reviewer = roles.get(reviewRole);
      const diff = await this.changeDiff(job, ws, job.changedFiles);
      const lastReview = job.sessions?.[reviewRole]?.step ?? -1;
      const sinceDiff = lastReview >= 0 ? await this.changeDiff(job, ws, filesChangedAfter(job, lastReview)) : undefined;
      const reviewText = reviewPrompt(project, reviewer, job, extraTask, diff);
      const brief = reviewBrief(project, reviewer);
      const rec = await this.execStep(job, ws, opts, {
        kind: 'review',
        roleId: reviewRole,
        access: 'read-only',
        task: extraTask,
        prompt: reviewText,
        brief,
        followUp: this.followUp(job, reviewRole, brief, {
          full: reviewText,
          carried: () => reviewCarried(reviewer, job, extraTask, diff),
          delta: (after, briefed) => reviewFollowUp(project, reviewer, job, after, extraTask, briefed, after === lastReview ? sinceDiff : undefined),
        }),
      });
      if (rec.outcome !== 'ok') return this.failFromStep(job, rec);
      job.reviewedSinceChange = true;
      const verdict = parseVerdict(rec.text);
      if (!verdict) {
        job.warnings.push('审查没有给出明确的"通过 / 不通过"结论，未触发返工。');
        return undefined;
      }
      // 建议不要求返工，交给发起人决定；只有建议、没有必须修改的问题时按通过处理
      if (verdict.suggestions.length > 0) {
        job.warnings.push(`审查的建议（没有要求返工，由你决定）：\n${verdict.suggestions.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}`);
      }
      if (verdict.verdict === 'pass' || (verdict.issues.length === 0 && verdict.suggestions.length > 0)) return undefined;

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
      const writerRole = roles.get(writer.role);
      const reworkText = reworkPrompt(project, writerRole, writer.task, verdict.issues, rec.text);
      // 主控保留计划的指纹；其他角色与执行步骤共用可写工作规则的指纹。
      const leadRework = writer.role === project.settings.leadRole;
      const reworkBrief = leadRework ? undefined : stepBrief(project, writerRole, 'write');
      const rework = await this.execStep(job, ws, opts, {
        kind: 'rework',
        roleId: writer.role,
        access: 'write',
        prefer: writer.agent,
        task: writer.task,
        ...(reworkScope(job.plan) && { scope: reworkScope(job.plan) }),
        prompt: reworkText,
        brief: reworkBrief,
        followUp: this.followUp(job, writer.role, reworkBrief, {
          full: reworkText,
          delta: (after, briefed) => reworkFollowUp(project, writerRole, job, after, verdict.issues, rec.text, briefed || leadRework),
        }),
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

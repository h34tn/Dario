import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from './config.js';
import type { AgentCatalog, AgentRunResult } from './ports.js';
import { imageSection } from './prompts.js';
import { formatActivity } from './report.js';
import type { RoleBook } from './roles.js';
import type { StateStore } from './state.js';
import type { TokenUsage } from '../plugin.js';
import type { Access, Attempt, ConsultRecord, FallbackQuestion, Job, ProgressEvent, StepKind, StepRecord, StepTokens } from './types.js';
import { parseLeadDecision } from './plan.js';
import { consultPrompt, correctionPrompt } from './prompts.js';
import { formatDuration, formatTokens } from './util.js';
import { usageBaseline, type UsageBaseline } from './baseline.js';
import { StepWatch, type Alert } from './watch.js';

/** 算用量基准时最多看最近多少个任务。 */
const BASELINE_JOBS = 50;

function addTokens(a: StepTokens | undefined, b: StepTokens | undefined): StepTokens | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const requests = sum(a.requests, b.requests);
  // 首次输入是这一步第一次请求的输入，取最早那一轮的
  const firstInput = a.firstInput ?? b.firstInput;
  return {
    input: a.input + b.input, cachedInput: a.cachedInput + b.cachedInput, output: a.output + b.output,
    ...(requests !== undefined && { requests }), ...(firstInput !== undefined && { firstInput }),
  };
}

/** 定时检查的间隔：最多 30 秒，阈值很小时（测试里）按阈值的四分之一，不低于 50 毫秒。 */
function watchInterval(thresholdMs: number): number {
  return Math.max(50, Math.min(30000, Math.floor(thresholdMs / 4)));
}

export interface StepRequest {
  job: Job;
  kind: StepKind;
  roleId: string;
  prompt: string;
  /**
   * 续接该角色已有会话时改用的增量说明，只写会话里还不知道的内容。
   * 不填，或担当者与会话不是同一家、不支持续接时，新开会话并使用 prompt。
   */
  followUp?: string;
  /**
   * prompt 里固定说明（角色、规则、项目约定、输出格式）的指纹。这一步做成后记在会话上，
   * 之后续接这个会话时据此判断固定说明是否已经发过。不填表示这一步没有固定说明，会话上已有的指纹保留。
   */
  brief?: string;
  /** 记录用的任务说明（不含前言）。 */
  task?: string;
  cwd: string;
  /** 不填则用角色自己的权限。 */
  access?: Access;
  prefer?: string;
  avoid?: string;
  /** 角色表的 fallback 为 ask 时，换人之前用它询问。不提供表示没法询问，此时不换人。 */
  confirmFallback?: (question: FallbackQuestion) => Promise<boolean>;
  /** 计划给这一步的预计改动范围；不检查偏离计划时不填。 */
  scope?: string[];
}

export interface RunnerDeps {
  roles: RoleBook;
  catalog: AgentCatalog;
  state: StateStore;
  project: ProjectConfig;
  cooldownMinutes: number;
  emit: (event: ProgressEvent) => void;
}

/** 这一步自己的用量。工具报的是会话累计值时，减去续接之前的累计值。 */
function stepTokens(usage: TokenUsage, base: StepTokens | undefined): StepTokens {
  const own = (now: number, before: number): number => (now >= before ? now - before : now);
  const extra = {
    ...(usage.requests !== undefined && { requests: usage.requests }),
    ...(usage.firstInput !== undefined && { firstInput: usage.firstInput }),
  };
  if (!usage.sessionTotal || !base) return { input: usage.input, cachedInput: usage.cachedInput, output: usage.output, ...extra };
  return { input: own(usage.input, base.input), cachedInput: own(usage.cachedInput, base.cachedInput), output: own(usage.output, base.output), ...extra };
}

const KIND_LABEL: Record<StepKind, string> = { plan: '计划', step: '执行', review: '审查', rework: '返工', summary: '汇总' };

/** 执行一步：按角色表找担当者，不可用时按候选顺序换人。 */
export class StepRunner {
  /** 用量基准要读的历史任务，每个任务只读一次。 */
  private history?: { job: string; jobs: Job[] };

  constructor(private readonly deps: RunnerDeps) {}

  /**
   * 请主控判断一次监控告警：以只读方式运行主控角色当前的担当者，能续接主控的会话就续接（它知道计划）。
   * 干活的一方同时还在运行。运行失败、超时或回复里没有可用的判断时，记录下来、不给判断。
   */
  private async consult(
    req: StepRequest,
    index: number,
    roleLabel: string,
    worker: string,
    workDir: string,
    c: { alert: Alert; watch: StepWatch; tokens?: StepTokens; signal: AbortSignal; n: number },
  ): Promise<ConsultRecord> {
    const { roles, catalog, state, project } = this.deps;
    const started = Date.now();
    const leadRole = project.settings.leadRole;
    const base: ConsultRecord = { rule: c.alert.rule, outcome: 'failed', durationMs: 0 };
    const done = (rec: Partial<ConsultRecord>): ConsultRecord => {
      const out = { ...base, ...rec, durationMs: Date.now() - started };
      state.audit('watch_consult', { job: req.job.id, step: index, rule: out.rule, agent: out.agent, outcome: out.outcome, reason: out.reason, decision: out.decision?.action });
      return out;
    };
    const { usable } = await roles.order(leadRole);
    const agent = usable[0];
    const port = agent ? catalog.get(agent) : undefined;
    if (!agent || !port) return done({ reason: '主控没有可用的 AI' });

    const snap = c.watch.snapshot();
    const prompt = consultPrompt(project, {
      stepNumber: index + 1,
      roleLabel,
      agent: worker,
      task: req.task ?? req.prompt,
      alert: c.alert.detail,
      elapsed: formatDuration(snap.elapsedMs),
      recent: snap.recent.map(formatActivity),
      edited: snap.edited,
      ...(c.tokens && { tokens: `新输入 ${formatTokens(Math.max(0, c.tokens.input - c.tokens.cachedInput))}，输出 ${formatTokens(c.tokens.output)}` }),
    });
    const sessions = (req.job.sessions ??= {});
    const slot = sessions[leadRole];
    const label = `${String(index).padStart(2, '0')}-consult${c.n}-${agent}`;
    try {
      fs.writeFileSync(path.join(workDir, `${label}.prompt.md`), prompt, 'utf8');
    } catch {
      // 记录失败不影响执行
    }
    const { model, effort } = roles.modelFor(leadRole, agent);
    const run = (resume: string | undefined, runLabel: string) => port.run({
      model, effort, access: 'read-only', cwd: req.cwd, prompt,
      timeoutMs: project.settings.supervise.consultTimeoutMinutes * 60000,
      workDir, label: runLabel, signal: c.signal, ...(resume && { resume }),
    });
    let resume = port.resumes && slot?.agent === agent ? slot.sessionId : undefined;
    let out = await run(resume, label);
    if (resume && out.sessionLost) {
      resume = undefined;
      out = await run(undefined, `${label}-new`);
    }
    const tokens = out.tokens && stepTokens(out.tokens, resume ? slot?.tokens : undefined);
    const spent = { agent, ...(tokens && { tokens }), ...(out.costUsd !== undefined && { costUsd: out.costUsd }) };
    if (c.signal.aborted) return done({ ...spent, outcome: 'cancelled', reason: '这一步先结束了' });
    if (out.outcome !== 'ok') return done({ ...spent, reason: out.reason ?? out.outcome });
    // 续接的是主控原来的会话：会话往前走了一轮，记下新的会话号
    if (resume && slot && out.sessionId) {
      sessions[leadRole] = { ...slot, sessionId: out.sessionId, ...(out.tokens?.sessionTotal && { tokens: { input: out.tokens.input, cachedInput: out.tokens.cachedInput, output: out.tokens.output } }) };
    }
    const decision = parseLeadDecision(out.text);
    if (!decision) return done({ ...spent, outcome: 'unparsed', reason: '回复里没有可用的判断' });
    return done({ ...spent, outcome: 'ok', decision });
  }

  private baseline(job: Job, kind: StepKind, agent: string): UsageBaseline {
    if (this.history?.job !== job.id) this.history = { job: job.id, jobs: this.deps.state.listJobs(BASELINE_JOBS + 1) };
    return usageBaseline(this.history.jobs, { projectRoot: job.projectRoot, kind, agent, excludeJob: job.id });
  }

  async run(req: StepRequest): Promise<StepRecord> {
    const { roles, catalog, state, project, emit } = this.deps;
    const role = roles.get(req.roleId);
    const access = req.access ?? role.access;
    const index = req.job.steps.length;
    const started = Date.now();
    const { usable, skipped, sequence, marked } = await roles.order(req.roleId, { prefer: req.prefer, avoid: req.avoid });
    // 排在实际执行者前面、因为不可用而被跳过的候选：这才算"换了人"
    const skippedBefore = (agent: string): Attempt[] => skipped.filter((s) => sequence.indexOf(s.agent) < sequence.indexOf(agent));
    const attempts: Attempt[] = usable.length === 0 ? [...skipped] : skippedBefore(usable[0]!);
    const base = { index, kind: req.kind, role: req.roleId, access, changedFiles: [] as string[], task: req.task };
    // 这一步的监控告警和请主控判断的记录，换人之前那家的也算在内
    const alerts: Alert[] = [];
    const consults: ConsultRecord[] = [];
    let interventions = 0;
    const roleLabel = roles.label(req.roleId);
    const head = `${KIND_LABEL[req.kind]}（${roleLabel}）`;

    if (usable.length === 0) {
      const detail = attempts.map((a) => `${a.agent}：${a.reason ?? '不可用'}`).join('；');
      return {
        ...base,
        outcome: 'all_unavailable',
        reason: `角色 ${req.roleId} 的候选都不可用。${detail}`,
        attempts,
        durationMs: Date.now() - started,
        text: '',
      };
    }

    // 等发起人回答的时间不算进这一步的耗时
    let waited = 0;
    const elapsed = (): number => Date.now() - started - waited;
    /**
     * fallback 为 ask 时，换人之前征得同意。同一个任务里，同一对"原来的 AI → 备选的 AI"只问一次。
     * cannot 表示当前的运行方式没有办法询问。
     */
    const consent = async (from: Array<{ agent: string; reason: string }>, to: string): Promise<'yes' | 'no' | 'cannot'> => {
      const approved = (req.job.fallbackApproved ??= []);
      const keys = from.map((f) => `${f.agent}>${to}`);
      if (keys.every((k) => approved.includes(k))) return 'yes';
      if (!req.confirmFallback) return 'cannot';
      const settings = (id: string) => {
        const { model, effort } = roles.modelFor(req.roleId, id);
        const modelLabel = model && roles.modelLabel(id, model);
        return { model, effort, ...(modelLabel !== model && { modelLabel }) };
      };
      const asked = Date.now();
      let ok = false;
      try {
        ok = await req.confirmFallback({
          jobId: req.job.id,
          role: req.roleId,
          roleLabel,
          from: from.map(f => ({ ...f, ...settings(f.agent) })),
          to: { agent: to, ...settings(to) },
        });
      } finally {
        waited += Date.now() - asked;
      }
      state.audit('fallback_ask', { job: req.job.id, step: index, role: req.roleId, from: from.map((f) => f.agent), to, approved: ok });
      if (ok) {
        approved.push(...keys.filter((k) => !approved.includes(k)));
        state.saveJob(req.job);
      }
      return ok ? 'yes' : 'no';
    };
    const notSwitched = (answer: 'no' | 'cannot', down: string, to: string, text = ''): StepRecord => ({
      ...base,
      outcome: 'all_unavailable',
      reason:
        answer === 'no'
          ? `${down}。没有同意改用 ${to}，任务停止。`
          : `${down}。角色表的 fallback 为 ask，要先确认才能改用 ${to}，但当前的运行方式没法询问：加 --yes 表示同意换人，或者在能交互的终端里运行。`,
      attempts,
      durationMs: elapsed(),
      text,
    });

    // 首选还在"暂时不可用"的冷却期里，这一步一上来就要用备选：同样先问
    if (roles.fallback === 'ask') {
      const down = skippedBefore(usable[0]!)
        .filter((a) => marked.includes(a.agent))
        .map((a) => ({ agent: a.agent, reason: (a.reason ?? '不可用').replace(/^暂时不可用：/, '') }));
      if (down.length > 0) {
        const answer = await consent(down, usable[0]!);
        if (answer !== 'yes') return notSwitched(answer, down.map((d) => `${d.agent} 不可用（${d.reason}）`).join('；'), usable[0]!);
      }
    }

    const workDir = state.jobDir(req.job.id);
    for (let i = 0; i < usable.length; i++) {
      const agent = usable[i]!;
      const step = { index, kind: req.kind, role: req.roleId, roleLabel, agent };
      const port = catalog.get(agent)!;
      const timeoutMinutes = port.timeoutMinutes ?? role.timeoutMinutes ?? project.settings.defaultTimeoutMinutes;
      const label = `${String(index).padStart(2, '0')}-${req.kind}-${agent}`;
      // 只有同一家 AI 才能续接这个角色的会话：会话存在各家工具自己手里，换了人就带不过去
      const sessions = (req.job.sessions ??= {});
      const slot = sessions[req.roleId];
      let resume = req.followUp !== undefined && port.resumes && slot?.agent === agent ? slot.sessionId : undefined;
      if (i === 0 && attempts.length > 0) {
        const why = attempts.map((a) => `${a.agent} ${a.reason ?? '不可用'}`).join('；');
        const fallback = { from: attempts.map((a) => a.agent).join('、'), reason: attempts.map((a) => a.reason ?? '不可用').join('；'), to: agent };
        emit({ jobId: req.job.id, kind: 'fallback', step, fallback, text: `${why}，改用 ${agent}` });
      }
      emit({ jobId: req.job.id, kind: i === 0 ? 'step_start' : 'fallback', step, text: `${head}：交给 ${agent}${resume ? '（续接会话）' : ''}` });

      let tokens: StepTokens | undefined;
      let promptChars = 0;
      // 纠偏之前那几轮的用量和费用：都是这一步实际做的事，算进这一步
      let earlier: StepTokens | undefined;
      let earlierCost: number | undefined;
      // 主控要求纠偏时记下说明，这一轮被中断后据此续接
      let correction: string | undefined;
      const rules = project.settings.supervise;
      // 主控自己的步骤（计划、主控自己做的改动、汇总）没有更上一级来判断
      const consultable = req.roleId !== project.settings.leadRole && roles.has(project.settings.leadRole);
      const invoke = async (prompt: string, resumeId: string | undefined, runLabel: string, freshBase = false): Promise<AgentRunResult> => {
        if (!resumeId || slot?.step === -1) prompt += imageSection(req.job.images);
        promptChars = prompt.length;
        const watch = new StepWatch({
          rules,
          writeRoots: project.settings.writeRoots,
          streams: port.streams === true,
          idleFactor: port.idleFactor,
          access,
          ...(req.scope && { scope: req.scope }),
          ...(rules.usage.action !== 'off' && { baseline: this.baseline(req.job, req.kind, agent) }),
        });
        const controller = new AbortController();
        let running = true;
        // 一次只请主控判断一件事；判断期间又发现的情况只提示
        let consulting: { controller: AbortController; done: Promise<void> } | undefined;
        const stopRun = (reason: string): void => {
          if (!controller.signal.aborted) controller.abort(reason);
        };
        const decide = (alert: Alert, rec: ConsultRecord): void => {
          consults.push(rec);
          const d = rec.decision;
          if (!d || !running) {
            if (running) emit({ jobId: req.job.id, kind: 'watch', step, alert, text: `${head}：主控没能给出判断（${rec.reason ?? rec.outcome}），只提示` });
            return;
          }
          alert.decision = { action: d.action, message: d.message };
          state.audit('watch_decision', { job: req.job.id, step: index, role: req.roleId, agent, rule: alert.rule, decision: d.action, message: d.message });
          let text = '';
          if (d.action === 'continue') {
            watch.snooze(alert.rule, d.snoozeMinutes * 60000);
            text = `主控判断继续${d.message ? `：${d.message}` : ''}`;
          } else if (d.action === 'correct' && interventions >= rules.maxInterventions) {
            text = `主控要求纠偏，但这一步已经纠偏 ${interventions} 次，达到上限，中止：${d.message}`;
            stopRun(text);
          } else if (d.action === 'correct') {
            interventions++;
            correction = d.message;
            text = `主控要求纠偏：${d.message}`;
            stopRun(text);
          } else {
            text = `主控中止：${d.message}`;
            stopRun(text);
          }
          req.job.warnings.push(`第 ${index + 1} 步（${roleLabel}，${agent}）：${text}`);
          emit({ jobId: req.job.id, kind: 'watch', step, alert, text: `${head}：${text}` });
        };
        const raise = (found: Alert[]): void => {
          for (const alert of found) {
            if (alert.action === 'ask_lead' && (!consultable || consulting || controller.signal.aborted)) {
              alert.detail += !consultable ? '（这一步由主控自己做，只提示）'
                : consulting ? '（主控正在判断上一个情况，这次只提示）' : '（这一轮已经中断，只提示）';
              alert.action = 'notify';
            }
            alerts.push(alert);
            const stops = alert.action === 'stop';
            const asks = alert.action === 'ask_lead';
            req.job.warnings.push(`第 ${index + 1} 步（${roleLabel}，${agent}）：${alert.detail}${stops ? '，已中断' : ''}`);
            state.audit('watch_alert', { job: req.job.id, step: index, role: req.roleId, agent, rule: alert.rule, action: alert.action, detail: alert.detail });
            emit({ jobId: req.job.id, kind: 'watch', step, alert, text: `${head}：${alert.detail}${stops ? '，已中断这一步' : asks ? '，请主控判断' : ''}` });
            if (stops) stopRun(`监控发现问题，已中断：${alert.detail}`);
            if (asks) {
              const c = new AbortController();
              const brief = { alert, watch, tokens: tokens && addTokens(earlier, tokens), signal: c.signal, n: consults.length + 1 };
              consulting = {
                controller: c,
                done: this.consult(req, index, roleLabel, agent, workDir, brief)
                  .then((rec) => decide(alert, rec))
                  .finally(() => { consulting = undefined; }),
              };
            }
          }
        };
        // 只有"没动静"要靠定时检查；规则关了或工具不逐行输出时不必开定时器
        const factor = port.idleFactor ?? 1;
        const timer = rules.idle.action !== 'off' && port.streams === true
          ? setInterval(() => raise(watch.tick()), watchInterval(Math.min(rules.idle.minutes, rules.idle.commandMinutes) * factor * 60000))
          : undefined;
        timer?.unref?.();
        const base = resumeId && !freshBase ? slot?.tokens : undefined;
        tokens = undefined;
        try {
          fs.writeFileSync(path.join(workDir, `${runLabel}.prompt.md`), prompt, 'utf8');
        } catch {
          // 记录失败不影响执行
        }
        const { model, effort } = roles.modelFor(req.roleId, agent);
        let out: AgentRunResult;
        try {
          out = await port.run({
            model, effort,
            access,
            cwd: req.cwd,
            prompt,
            ...(req.job.images?.length && { images: req.job.images.map(image => image.path) }),
            timeoutMs: timeoutMinutes * 60000,
            workDir,
            label: runLabel,
            resume: resumeId,
            onLine: () => watch.line(),
            signal: controller.signal,
            onActivity: (activity) => {
              emit({ jobId: req.job.id, kind: 'activity', step, activity, text: formatActivity(activity) });
              raise(watch.activity(activity));
            },
            onQuota: (windows) => {
              if (state.saveQuota(agent, windows)) emit({ jobId: req.job.id, kind: 'quota', step, quota: { agent, windows }, text: '' });
            },
            onUsage: (usage) => {
              tokens = stepTokens(usage, base);
              emit({ jobId: req.job.id, kind: 'usage', step: { ...step, tokens: addTokens(earlier, tokens) }, text: '' });
              raise(watch.usage(tokens));
            },
            onPid: (pid) => {
              req.job.activePid = pid;
              state.saveJob(req.job);
            },
          });
        } finally {
          clearInterval(timer);
          running = false;
        }
        // 这一轮已经结束，还在进行的判断用不上了
        if (consulting) {
          consulting.controller.abort('这一步已经结束');
          await consulting.done;
        }
        if (out.tokens) tokens = stepTokens(out.tokens, base);
        state.audit('agent_run', {
          job: req.job.id, step: index, kind: req.kind, role: req.roleId, agent,
          outcome: out.outcome, reason: out.reason, command: out.command,
          ...(resumeId && { resumed: true }), ...(out.sessionLost && { session_lost: true }),
        });
        return out;
      };

      let res = await invoke(resume ? req.followUp! : req.prompt, resume, label);
      if (resume && res.sessionLost) {
        // 会话已经不在了：工具还没开始干活就退出了。新开会话、用完整说明重跑，不算换人，也不标记这家不可用
        const text = `${agent} 的原会话已失效，改为新开会话`;
        emit({ jobId: req.job.id, kind: 'activity', step, activity: { kind: 'say', text }, text });
        resume = undefined;
        res = await invoke(req.prompt, undefined, `${label}-new`);
      }
      // 主控要求纠偏：这一轮已被中断。接着它的会话把提醒发过去；续接不了就新开会话，带上完整的任务说明
      while (correction !== undefined) {
        const message = correction;
        correction = undefined;
        earlier = addTokens(earlier, tokens);
        if (res.costUsd !== undefined) earlierCost = (earlierCost ?? 0) + res.costUsd;
        const sessionId = port.resumes ? res.sessionId : undefined;
        const text = `按主控的提醒${sessionId ? '接着原会话' : '新开会话'}继续`;
        emit({ jobId: req.job.id, kind: 'activity', step, activity: { kind: 'say', text }, text });
        const fixLabel = `${label}-fix${interventions}`;
        res = sessionId
          ? await invoke(correctionPrompt(message), sessionId, fixLabel, true)
          : await invoke(`${req.prompt}\n\n${correctionPrompt(message)}`, undefined, fixLabel);
        if (sessionId) resume = sessionId;
      }
      tokens = earlier ? addTokens(earlier, tokens) : tokens;
      const costUsd = earlierCost !== undefined ? earlierCost + (res.costUsd ?? 0) : res.costUsd;
      // 会话槽位始终对应这个角色最近的一次运行；没做成的那一轮可能停在半截，不再续
      if (res.outcome === 'ok' && res.sessionId) {
        const total = res.tokens?.sessionTotal ? { input: res.tokens.input, cachedInput: res.tokens.cachedInput, output: res.tokens.output } : undefined;
        // 新开的会话只收到过这一步的固定说明；续接的会话在此之外还留着以前收到的
        const brief = req.brief ?? (resume ? slot?.brief : undefined);
        sessions[req.roleId] = { agent, sessionId: res.sessionId, step: index, job: req.job.id, ...(total && { tokens: total }), ...(brief && { brief }) };
      }
      else delete sessions[req.roleId];
      attempts.push({ agent, outcome: res.outcome, reason: res.reason, durationMs: res.durationMs });

      if (res.outcome === 'unavailable') {
        const reason = res.reason ?? '不可用';
        state.markUnavailable(agent, reason, this.deps.cooldownMinutes);
        const next = usable[i + 1];
        if (next && roles.fallback !== 'manual') {
          const answer = roles.fallback === 'auto' ? 'yes' : await consent([{ agent, reason }], next);
          if (answer !== 'yes') return notSwitched(answer, `${agent} 不可用（${reason}）`, next, res.text);
          emit({ jobId: req.job.id, kind: 'fallback', step, fallback: { from: agent, reason, to: next }, text: `${agent} 不可用（${reason}），换成 ${next}` });
          continue;
        }
        const why =
          roles.fallback === 'manual'
            ? `${agent} 不可用（${reason}）。角色表的 fallback 为 manual，没有自动换人。`
            : `角色 ${req.roleId} 的候选都不可用。${attempts.map((a) => `${a.agent}：${a.reason ?? a.outcome}`).join('；')}`;
        return { ...base, outcome: 'all_unavailable', reason: why, attempts, durationMs: elapsed(), text: res.text };
      }

      const record: StepRecord = {
        ...base,
        agent,
        outcome: res.outcome,
        reason: res.reason,
        attempts,
        durationMs: elapsed(),
        text: res.text,
        costUsd,
        ...(resume && { resumed: true }),
        ...(tokens && { tokens }),
        ...(res.startupMs !== undefined && { startupMs: res.startupMs }),
        promptChars,
        ...(alerts.length > 0 && { alerts }),
        ...(consults.length > 0 && { consults }),
      };
      emit({
        jobId: req.job.id,
        kind: 'step_end',
        step: { ...step, outcome: record.outcome, durationMs: record.durationMs, tokens },
        text: `${head}：${agent} ${res.outcome === 'ok' ? '完成' : res.outcome === 'timeout' ? '超时' : '未完成'}`,
      });
      return record;
    }
    // 循环内每条路径都已返回
    throw new Error('unreachable');
  }
}

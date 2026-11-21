import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from './config.js';
import type { AgentCatalog, AgentRunResult } from './ports.js';
import { formatActivity } from './report.js';
import type { RoleBook } from './roles.js';
import type { StateStore } from './state.js';
import type { TokenUsage } from '../plugin.js';
import type { Access, Attempt, FallbackQuestion, Job, ProgressEvent, StepKind, StepRecord, StepTokens } from './types.js';

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
  if (!usage.sessionTotal || !base) return { input: usage.input, cachedInput: usage.cachedInput, output: usage.output };
  return { input: own(usage.input, base.input), cachedInput: own(usage.cachedInput, base.cachedInput), output: own(usage.output, base.output) };
}

const KIND_LABEL: Record<StepKind, string> = { plan: '计划', step: '执行', review: '审查', rework: '返工', summary: '汇总' };

/** 执行一步：按角色表找担当者，不可用时按候选顺序换人。 */
export class StepRunner {
  constructor(private readonly deps: RunnerDeps) {}

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
      const model = (id: string): string | undefined => catalog.get(id)?.model;
      const asked = Date.now();
      let ok = false;
      try {
        ok = await req.confirmFallback({
          jobId: req.job.id,
          role: req.roleId,
          roleLabel,
          from: from.map((f) => ({ agent: f.agent, model: model(f.agent), reason: f.reason })),
          to: { agent: to, model: model(to) },
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
      const invoke = async (prompt: string, resumeId: string | undefined, runLabel: string): Promise<AgentRunResult> => {
        const base = resumeId ? slot?.tokens : undefined;
        tokens = undefined;
        try {
          fs.writeFileSync(path.join(workDir, `${runLabel}.prompt.md`), prompt, 'utf8');
        } catch {
          // 记录失败不影响执行
        }
        const out = await port.run({
          access,
          cwd: req.cwd,
          prompt,
          timeoutMs: timeoutMinutes * 60000,
          workDir,
          label: runLabel,
          resume: resumeId,
          onActivity: (activity) => emit({ jobId: req.job.id, kind: 'activity', step, activity, text: formatActivity(activity) }),
          onUsage: (usage) => {
            tokens = stepTokens(usage, base);
            emit({ jobId: req.job.id, kind: 'usage', step: { ...step, tokens }, text: '' });
          },
          onPid: (pid) => {
            req.job.activePid = pid;
            state.saveJob(req.job);
          },
        });
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
      // 会话槽位始终对应这个角色最近的一次运行；没做成的那一轮可能停在半截，不再续
      if (res.outcome === 'ok' && res.sessionId) {
        const total = res.tokens?.sessionTotal ? { input: res.tokens.input, cachedInput: res.tokens.cachedInput, output: res.tokens.output } : undefined;
        // 新开的会话只收到过这一步的固定说明；续接的会话在此之外还留着以前收到的
        const brief = req.brief ?? (resume ? slot?.brief : undefined);
        sessions[req.roleId] = { agent, sessionId: res.sessionId, step: index, ...(total && { tokens: total }), ...(brief && { brief }) };
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
        costUsd: res.costUsd,
        ...(resume && { resumed: true }),
        ...(tokens && { tokens }),
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

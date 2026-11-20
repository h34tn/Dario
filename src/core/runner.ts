import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from './config.js';
import type { AgentCatalog } from './ports.js';
import { formatActivity } from './report.js';
import type { RoleBook } from './roles.js';
import type { StateStore } from './state.js';
import type { Access, Attempt, Job, ProgressEvent, StepKind, StepRecord } from './types.js';

export interface StepRequest {
  job: Job;
  kind: StepKind;
  roleId: string;
  prompt: string;
  /** 记录用的任务说明（不含前言）。 */
  task?: string;
  cwd: string;
  /** 不填则用角色自己的权限。 */
  access?: Access;
  prefer?: string;
  avoid?: string;
}

export interface RunnerDeps {
  roles: RoleBook;
  catalog: AgentCatalog;
  state: StateStore;
  project: ProjectConfig;
  cooldownMinutes: number;
  emit: (event: ProgressEvent) => void;
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
    const { usable, skipped, sequence } = await roles.order(req.roleId, { prefer: req.prefer, avoid: req.avoid });
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

    const workDir = state.jobDir(req.job.id);
    for (let i = 0; i < usable.length; i++) {
      const agent = usable[i]!;
      const step = { index, kind: req.kind, role: req.roleId, roleLabel, agent };
      const port = catalog.get(agent)!;
      const timeoutMinutes = port.timeoutMinutes ?? role.timeoutMinutes ?? project.settings.defaultTimeoutMinutes;
      const label = `${String(index).padStart(2, '0')}-${req.kind}-${agent}`;
      try {
        fs.writeFileSync(path.join(workDir, `${label}.prompt.md`), req.prompt, 'utf8');
      } catch {
        // 记录失败不影响执行
      }
      if (i === 0 && attempts.length > 0) {
        const why = attempts.map((a) => `${a.agent} ${a.reason ?? '不可用'}`).join('；');
        const fallback = { from: attempts.map((a) => a.agent).join('、'), reason: attempts.map((a) => a.reason ?? '不可用').join('；'), to: agent };
        emit({ jobId: req.job.id, kind: 'fallback', step, fallback, text: `${why}，改用 ${agent}` });
      }
      emit({ jobId: req.job.id, kind: i === 0 ? 'step_start' : 'fallback', step, text: `${head}：交给 ${agent}` });

      const res = await port.run({
        access,
        cwd: req.cwd,
        prompt: req.prompt,
        timeoutMs: timeoutMinutes * 60000,
        workDir,
        label,
        onActivity: (activity) => emit({ jobId: req.job.id, kind: 'activity', step, activity, text: formatActivity(activity) }),
        onPid: (pid) => {
          req.job.activePid = pid;
          state.saveJob(req.job);
        },
      });
      attempts.push({ agent, outcome: res.outcome, reason: res.reason, durationMs: res.durationMs });
      state.audit('agent_run', { job: req.job.id, step: index, kind: req.kind, role: req.roleId, agent, outcome: res.outcome, reason: res.reason, command: res.command });

      if (res.outcome === 'unavailable') {
        const reason = res.reason ?? '不可用';
        state.markUnavailable(agent, reason, this.deps.cooldownMinutes);
        const next = usable[i + 1];
        if (roles.fallback === 'auto' && next) {
          emit({ jobId: req.job.id, kind: 'fallback', step, fallback: { from: agent, reason, to: next }, text: `${agent} 不可用（${reason}），换成 ${next}` });
          continue;
        }
        const why =
          roles.fallback === 'manual'
            ? `${agent} 不可用（${reason}）。角色表的 fallback 为 manual，没有自动换人。`
            : `角色 ${req.roleId} 的候选都不可用。${attempts.map((a) => `${a.agent}：${a.reason ?? a.outcome}`).join('；')}`;
        return { ...base, outcome: 'all_unavailable', reason: why, attempts, durationMs: Date.now() - started, text: res.text };
      }

      const record: StepRecord = {
        ...base,
        agent,
        outcome: res.outcome,
        reason: res.reason,
        attempts,
        durationMs: Date.now() - started,
        text: res.text,
        costUsd: res.costUsd,
      };
      emit({
        jobId: req.job.id,
        kind: 'step_end',
        step: { ...step, outcome: record.outcome, durationMs: record.durationMs },
        text: `${head}：${agent} ${res.outcome === 'ok' ? '完成' : res.outcome === 'timeout' ? '超时' : '未完成'}`,
      });
      return record;
    }
    // 循环内每条路径都已返回
    throw new Error('unreachable');
  }
}

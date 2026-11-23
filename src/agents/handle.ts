import fs from 'node:fs';
import path from 'node:path';
import type { AgentInstanceConfig, WritePermissions } from '../core/config.js';
import type { AgentDetect, AgentPort, AgentRunRequest, AgentRunResult, ModelList } from '../core/ports.js';
import { realPath } from '../core/util.js';
import { looksSessionLost, looksUnavailable, type Activity, type AgentOutput, type AgentPlugin, type Classification, type QuotaReader, type QuotaWindow, type RawResult, type TokenUsage } from '../plugin.js';
import { buildEnv, runProcess, SYSTEM_ENV, which } from './spawn.js';

export interface HandleSettings {
  startupTimeoutSeconds: number;
  /** 可写角色的权限，本机的总设置；不给时按 full。 */
  permissions?: WritePermissions;
  /** 用户配置里传给所有 AI 的环境变量。 */
  envPass: string[];
  env: NodeJS.ProcessEnv;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}

function displayText(value: string): string {
  const text = value.trim().replace(/\s+/gu, ' ');
  if (text.length <= 200) return text;
  const chars = Array.from(text);
  return chars.length > 200 ? chars.slice(0, 200).join('') + '…' : text;
}

function normalizeActivity(activity: Activity, cwd: string): Activity | undefined {
  if (activity.kind === 'think') return activity;
  if (activity.kind === 'say') {
    const text = displayText(firstLine(activity.text));
    return text ? { kind: 'say', text } : undefined;
  }
  let target = activity.target.trim();
  if (activity.kind === 'read' || activity.kind === 'edit') {
    if (path.isAbsolute(target)) {
      // AI 报回来的路径和 cwd 可能一个是短文件名（如 PROGRA~1）、一个是长文件名，两种写法都试
      for (const base of new Set([cwd, realPath(cwd)])) {
        const relative = path.relative(base, target);
        if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) {
          target = relative || '.';
          break;
        }
      }
    }
    target = target.replaceAll('\\', '/');
  }
  target = displayText(target);
  return target ? { kind: activity.kind, target } : undefined;
}

/** 从报错文字里挑出最能说明"为什么不可用"的那一行。 */
function unavailableReason(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && looksUnavailable(l));
  return (line ?? firstLine(text)).slice(0, 300);
}

function safeParse(plugin: AgentPlugin, raw: RawResult): AgentOutput | undefined {
  try {
    return plugin.parse(raw);
  } catch {
    return undefined;
  }
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  if (typeof reason === 'string' && reason) return reason;
  if (reason instanceof Error && reason.message && reason.name !== 'AbortError') return reason.message;
  return '已被 Dario 中断';
}

/** Dario 的默认失败分类。插件的 classify 返回了结论时以插件为准。 */
export function classify(plugin: AgentPlugin, raw: RawResult): { result: Classification; output?: AgentOutput } {
  if (raw.spawnError) return { result: { outcome: 'unavailable', reason: `命令无法启动：${raw.spawnError}` } };
  if (raw.startupTimedOut) return { result: { outcome: 'unavailable', reason: '启动后长时间没有任何输出' } };
  if (raw.timedOut) return { result: { outcome: 'timeout', reason: '超过时限，已终止' } };

  let output: AgentOutput;
  try {
    output = plugin.parse(raw);
  } catch (e) {
    output = { text: '', isError: true };
    return { result: { outcome: 'task_failed', reason: `无法解析输出：${(e as Error).message}` }, output };
  }
  const custom = plugin.classify?.(raw, output);
  if (custom) return { result: custom, output };

  const failed = raw.exitCode !== 0 || output.isError === true || !output.text.trim();
  if (!failed) return { result: { outcome: 'ok' }, output };

  const evidence = `${raw.stderr.slice(-4000)}\n${output.text.slice(-4000)}`;
  if (looksUnavailable(evidence)) return { result: { outcome: 'unavailable', reason: unavailableReason(evidence) }, output };
  const why = raw.exitCode !== 0 ? `退出码 ${raw.exitCode ?? '无'}` : output.isError ? '工具报告本次运行出错' : '没有给出答复';
  const hint = firstLine(raw.stderr);
  return { result: { outcome: 'task_failed', reason: hint ? `${why}：${hint.slice(0, 300)}` : why }, output };
}

/** 一个可被调用的 AI：一个插件加上这台机器上的设置。 */
export class AgentHandle implements AgentPort {
  readonly command: string;
  private detected?: Promise<AgentDetect>;

  constructor(
    readonly id: string,
    private readonly plugin: AgentPlugin,
    private readonly config: AgentInstanceConfig,
    private readonly settings: HandleSettings,
  ) {
    this.command = config.command ?? plugin.defaultCommand;
  }

  get displayName(): string {
    return this.id === this.plugin.id ? this.plugin.displayName : `${this.id}（${this.plugin.displayName}）`;
  }

  get pluginId(): string {
    return this.plugin.id;
  }

  get enabled(): boolean {
    return this.config.enabled !== false;
  }

  get free(): boolean {
    return this.config.free === true;
  }

  get resumes(): boolean {
    return this.plugin.resumes === true;
  }

  get model(): string | undefined {
    return this.config.model;
  }

  get effort() { return this.config.effort; }
  get efforts() { return this.plugin.efforts; }
  get roles() { return this.config.roles; }

  private pendingModels?: Promise<ModelList>;

  listModels(): Promise<ModelList> {
    return this.pendingModels ??= this.queryModels().finally(() => { this.pendingModels = undefined; });
  }

  private async queryModels(): Promise<ModelList> {
    const models = this.plugin.models ?? [];
    const query = this.plugin.modelsQuery;
    if (!query) return models.length ? { models } : { models, error: '插件没有提供型号清单' };
    try {
      const out = await runProcess({
        command: this.command, args: query.args, stdin: query.stdin, cwd: process.cwd(), env: this.envFor(), timeoutMs: 20000,
      });
      if (out.timedOut) return { models, error: '命令超时（20 秒）' };
      if (out.spawnError) return { models, error: `命令无法启动：${out.spawnError}` };
      if (out.exitCode !== 0) return { models, error: `查询命令失败（退出码 ${out.exitCode ?? '无'}）` };
      const choices = query.parse(out.stdout);
      return choices.length ? { models: choices } : { models, error: '没有返回型号清单' };
    } catch {
      return { models, error: '未能读取型号清单' };
    }
  }

  get streams(): boolean {
    return this.plugin.streams;
  }

  get idleFactor(): number | undefined {
    return this.config.idleFactor;
  }

  get timeoutMinutes(): number | undefined {
    return this.config.timeoutMinutes;
  }

  private envFor(extra: Record<string, string> = {}): Record<string, string> {
    const depth = Number(this.settings.env.DARIO_DEPTH ?? '0') || 0;
    return buildEnv(
      this.settings.env,
      [...SYSTEM_ENV, ...(this.plugin.envPass ?? []), ...this.settings.envPass, ...(this.config.envPass ?? [])],
      { ...extra, DARIO_DEPTH: String(depth + 1) },
    );
  }

  detect(): Promise<AgentDetect> {
    this.detected ??= this.probe();
    return this.detected;
  }

  private async probe(): Promise<AgentDetect> {
    const resolved = which(this.command, this.settings.env);
    if (!resolved) return { installed: false };
    const out = await runProcess({
      command: this.command,
      args: this.plugin.versionArgs ?? ['--version'],
      cwd: process.cwd(),
      env: this.envFor(),
      timeoutMs: 20000,
    });
    const version = firstLine(out.stdout) || firstLine(out.stderr) || undefined;
    return { installed: true, path: resolved, version: version?.slice(0, 80) };
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const resultFile = path.join(req.workDir, `${req.label}.result.txt`);
    fs.rmSync(resultFile, { force: true });
    const tools = this.config.allowedTools;
    const defaults = this.plugin.defaultAllowedTools;
    const imageTools = req.images?.length ? this.plugin.imageTools ?? [] : [];
    const accessKey = req.access === 'write' ? 'write' : 'readOnly';
    const allowedTools = tools?.[accessKey] ?? [...(defaults?.[accessKey] ?? []), ...imageTools];
    const resume = this.resumes ? req.resume : undefined;
    // 只读角色的职责就是不动手，权限放开只对可写角色有意义
    const unrestricted = req.access === 'write' && (this.config.permissions ?? this.settings.permissions ?? 'full') === 'full';

    const model = req.model ?? this.model;
    const effort = req.effort ?? this.effort;
    const invocation = this.plugin.build({
      access: req.access,
      cwd: req.cwd,
      prompt: req.prompt,
      ...(req.images?.length && { images: req.images }),
      model,
      ...(effort && { effort }),
      allowedTools,
      resultFile,
      options: this.config.options ?? {},
      ...(unrestricted && { unrestricted }),
      ...(resume && { resume }),
    });

    const env = this.envFor({ ...req.env, ...invocation.env });
    let reader: QuotaReader | undefined;
    try {
      if (!this.free) reader = this.plugin.quota?.();
    } catch {
      // 插件不能采集额度时，任务照常执行
    }
    let quota: QuotaWindow[] | undefined;
    const observe = (windows: QuotaWindow[] | undefined): void => {
      if (!windows) return;
      quota = windows;
      req.onQuota?.(windows);
    };
    const meter = this.plugin.meter?.();
    let tokens: TokenUsage | undefined;
    const showActivity = req.onActivity;
    const launched = Date.now();
    let startupMs: number | undefined;
    const out = await runProcess({
      command: this.command,
      args: invocation.args,
      cwd: req.cwd,
      env,
      stdin: invocation.stdin,
      timeoutMs: req.timeoutMs,
      startupTimeoutMs: this.plugin.streams ? this.settings.startupTimeoutSeconds * 1000 : undefined,
      onSpawn: (pid) => req.onPid?.(pid),
      ...(req.signal && { signal: req.signal }),
      // 始终逐行接收：流式输出的工具第一行到达的时间就是启动开销，不论是否显示活动、统计用量。
      // 不流式输出的工具到结束才有输出，测不出启动开销
      onStdoutLine: (line) => {
        if (this.plugin.streams) startupMs ??= Date.now() - launched;
        try {
          req.onLine?.();
        } catch {
          // 监控出错不影响运行
        }
        try {
          observe(reader?.onLine?.(line));
        } catch {
          // 额度解析失败不影响用量和活动
        }
        // 用量和活动互不影响：先统计用量，解析活动出错也不会丢掉这一行的用量
        try {
          const usage = meter?.(line);
          if (usage) {
            tokens = usage;
            req.onUsage?.(usage);
          }
        } catch {
          // 用量只用于显示和记录
        }
        if (!showActivity || !this.plugin.progress) return;
        // 进程层隔离逐行回调的异常，下一行仍会正常处理。
        for (const activity of this.plugin.progress(line) ?? []) {
          const normalized = normalizeActivity(activity, req.cwd);
          if (normalized) showActivity(normalized);
        }
      },
    });
    req.onPid?.(undefined);

    try {
      fs.writeFileSync(path.join(req.workDir, `${req.label}.stdout.txt`), out.stdout, 'utf8');
      if (out.stderr) fs.writeFileSync(path.join(req.workDir, `${req.label}.stderr.txt`), out.stderr, 'utf8');
    } catch {
      // 记录失败不影响结果
    }

    let resultFileText: string | undefined;
    try {
      resultFileText = fs.readFileSync(resultFile, 'utf8');
    } catch {
      // 工具没有写结果文件
    }
    const raw: RawResult = {
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      resultFileText,
      spawnError: out.spawnError,
      timedOut: out.timedOut,
      startupTimedOut: out.startupTimedOut,
    };
    // 被 Dario 中断：这一步算没做成，不按退出码或报错判成"不可用"去换人。
    // 照常解析输出，取出会话号，纠偏时可以续接
    const aborted = out.aborted
      ? { result: { outcome: 'task_failed' as const, reason: abortReason(req.signal) }, output: safeParse(this.plugin, raw) }
      : undefined;
    const { result, output } = aborted ?? classify(this.plugin, raw);
    try {
      observe(await reader?.afterRun?.({ sessionId: output?.sessionId, env }));
    } catch {
      // 额度读取失败不影响运行结果
    }
    // 会话不在了是续接特有的失败：工具根本没有开始干活，换成新会话重跑即可，不算这家 AI 不可用。
    // 只看报错和最终答复；没有答复时才看原始输出（有的工具把这个错误写在标准输出里），免得把 AI 干活过程中的文字当成证据
    const answer = output?.text.trim() ?? '';
    const sessionLost =
      !out.aborted &&
      resume !== undefined &&
      result.outcome !== 'ok' &&
      result.outcome !== 'timeout' &&
      looksSessionLost(`${raw.stderr.slice(-4000)}\n${answer ? answer.slice(-4000) : raw.stdout.slice(-4000)}`);
    return {
      outcome: result.outcome,
      reason: result.outcome === 'ok' ? undefined : result.reason,
      text: output?.text ?? '',
      durationMs: out.durationMs,
      ...(startupMs !== undefined && { startupMs }),
      costUsd: output?.costUsd,
      tokens,
      ...(quota && { quota }),
      sessionId: this.resumes ? output?.sessionId : undefined,
      ...(sessionLost && { sessionLost }),
      // 个别插件把任务说明放在参数里，记录时截短
      command: [this.command, ...invocation.args.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a))],
    };
  }
}

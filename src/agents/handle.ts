import fs from 'node:fs';
import path from 'node:path';
import type { AgentInstanceConfig } from '../core/config.js';
import type { AgentDetect, AgentPort, AgentRunRequest, AgentRunResult } from '../core/ports.js';
import { looksUnavailable, type AgentOutput, type AgentPlugin, type Classification, type RawResult } from '../plugin.js';
import { buildEnv, runProcess, SYSTEM_ENV, which } from './spawn.js';

export interface HandleSettings {
  startupTimeoutSeconds: number;
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

/** 从报错文字里挑出最能说明"为什么不可用"的那一行。 */
function unavailableReason(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && looksUnavailable(l));
  return (line ?? firstLine(text)).slice(0, 300);
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

  get model(): string | undefined {
    return this.config.model;
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
    const allowedTools = req.access === 'write' ? (tools?.write ?? defaults?.write ?? []) : (tools?.readOnly ?? defaults?.readOnly ?? []);

    const invocation = this.plugin.build({
      access: req.access,
      cwd: req.cwd,
      prompt: req.prompt,
      model: this.config.model,
      allowedTools,
      resultFile,
      options: this.config.options ?? {},
    });

    const out = await runProcess({
      command: this.command,
      args: invocation.args,
      cwd: req.cwd,
      env: this.envFor(invocation.env),
      stdin: invocation.stdin,
      timeoutMs: req.timeoutMs,
      startupTimeoutMs: this.plugin.streams ? this.settings.startupTimeoutSeconds * 1000 : undefined,
      onSpawn: (pid) => req.onPid?.(pid),
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
    const { result, output } = classify(this.plugin, raw);
    return {
      outcome: result.outcome,
      reason: result.outcome === 'ok' ? undefined : result.reason,
      text: output?.text ?? '',
      durationMs: out.durationMs,
      costUsd: output?.costUsd,
      // 个别插件把任务说明放在参数里，记录时截短
      command: [this.command, ...invocation.args.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a))],
    };
  }
}

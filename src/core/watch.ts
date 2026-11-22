/**
 * 干活监控：盯着一次运行的输出，按项目配置的规则发现"没动静""路径越界""禁用命令""偏离计划""原地打转""用量异常"。
 *
 * 这里只有判断，不碰进程，也不碰界面：调用方喂进输出、活动和定时检查，拿回告警，自己决定怎么提示、要不要中断。
 * 时钟由调用方传入，便于测试。
 */

import type { Access, Activity } from '../plugin.js';
import type { UsageBaseline } from './baseline.js';
import type { SuperviseSettings, WatchAction } from './config.js';
import { inScope } from './scope.js';
import type { LeadDecision, StepTokens } from './types.js';
import { formatDuration, formatTokens } from './util.js';
import { outOfScope } from './workspace.js';

export type WatchRule = 'idle' | 'out_of_roots' | 'forbidden_command' | 'off_plan' | 'loop' | 'usage';

export interface Alert {
  rule: WatchRule;
  /** 触发后的处理，不会是 off。 */
  action: Exclude<WatchAction, 'off'>;
  /** 从这次运行开始到触发时经过的毫秒数。 */
  atMs: number;
  /** 给人看的说明。 */
  detail: string;
  /** 触发它的文件或命令，用于去重；有的规则没有。 */
  target?: string;
  /** action 为 ask_lead 时主控的判断；没能判断时为空。 */
  decision?: { action: LeadDecision['action']; message: string };
}

export interface WatchOptions {
  rules: SuperviseSettings;
  /** 项目允许改动的范围，空表示不限制。 */
  writeRoots: string[];
  /** 工具是否逐行输出。不逐行输出时无法判断有没有动静，不检查 idle。 */
  streams: boolean;
  /** 这家 AI 的 idle 阈值倍数，默认 1。 */
  idleFactor?: number;
  /** 计划给这一步的预计范围；不检查偏离计划时为空。 */
  scope?: string[];
  /** 这一步的权限。连续请求没有改动只对可写的步骤检查。 */
  access?: Access;
  /** 本项目同类步骤的用量基准；不检查用量异常时为空。 */
  baseline?: UsageBaseline;
  now?: () => number;
}

/** 简报里保留的最近活动条数。 */
const RECENT = 30;

/** 命令的比较口径：合并空白。 */
const commandKey = (command: string): string => command.trim().replace(/\s+/g, ' ');

/** 把一条命令按 &&、||、;、| 和换行拆开，每段去掉首尾空白。 */
export function commandSegments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

/** 按词前缀匹配：清单里的 "git push" 匹配 "git push origin"，不匹配 "git pushd"。不区分大小写，多个空白视为一个。 */
export function matchesCommand(command: string, pattern: string): boolean {
  const words = (s: string): string[] => s.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const want = words(pattern);
  if (want.length === 0) return false;
  return commandSegments(command).some((segment) => {
    const have = words(segment);
    return want.length <= have.length && want.every((w, i) => have[i] === w);
  });
}

/** 把活动里的改动路径整理成相对、正斜杠的写法，与 outOfScope 的口径一致。 */
function normalizeTarget(target: string): string {
  return target.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export class StepWatch {
  private readonly now: () => number;
  private readonly started: number;
  /** 最近一次收到输出的时间。收到第一行之前为空：启动阶段没有输出由启动超时负责，不算"没动静"。 */
  private lastLine: number | undefined;
  /**
   * 最近一条活动是执行命令，之后还没有别的活动。只看活动不看输出：工具在发出命令之后、
   * 命令结束之前，常会再输出几行收尾或进度，那些行不代表命令结束了。
   */
  private inCommand = false;
  /** 当前这段静默已经报过。有了新输出才能再报。 */
  private idleReported = false;
  private readonly reportedPaths = new Set<string>();
  private readonly reportedCommands = new Set<string>();
  private readonly reportedOffPlan = new Set<string>();
  /** 自上次改动以来各条命令执行的次数、各个文件读的次数，以及已经报过的打转。有了改动就清零。 */
  private runCounts = new Map<string, number>();
  private readCounts = new Map<string, number>();
  private reportedLoops = new Set<string>();
  /** 最近一次报告的请求次数，以及上次改动时的请求次数。 */
  private requests = 0;
  private requestsAtEdit = 0;
  private readonly reportedUsage = new Set<string>();
  /** 最近的活动和运行中看到的改动，给主控判断用。 */
  private readonly recentActivities: Activity[] = [];
  private readonly editedFiles = new Set<string>();
  /** 主控判断"继续"后，这些规则静默到什么时候。 */
  private readonly snoozed = new Map<WatchRule, number>();

  constructor(private readonly opts: WatchOptions) {
    this.now = opts.now ?? Date.now;
    this.started = this.now();
  }

  /** 工具输出了一行。活动随后由 activity() 送来。 */
  line(): void {
    this.lastLine = this.now();
    this.idleReported = false;
  }

  /** 认出了一条活动。 */
  activity(a: Activity): Alert[] {
    this.recentActivities.push(a);
    if (this.recentActivities.length > RECENT) this.recentActivities.shift();
    if (a.kind === 'edit' && normalizeTarget(a.target)) this.editedFiles.add(normalizeTarget(a.target));
    return this.unsnoozed(this.check(a));
  }

  /** 主控判断要继续：这条规则在 ms 毫秒内不再报。 */
  snooze(rule: WatchRule, ms: number): void {
    this.snoozed.set(rule, this.now() + ms);
  }

  /** 给主控看的现场：最近的活动、运行中看到的改动、已经过了多久。 */
  snapshot(): { recent: Activity[]; edited: string[]; elapsedMs: number } {
    return { recent: [...this.recentActivities], edited: [...this.editedFiles], elapsedMs: this.now() - this.started };
  }

  private unsnoozed(alerts: Alert[]): Alert[] {
    const now = this.now();
    return alerts.filter((a) => (this.snoozed.get(a.rule) ?? 0) <= now);
  }

  private check(a: Activity): Alert[] {
    const alerts: Alert[] = [];
    if (a.kind === 'edit') {
      this.runCounts = new Map();
      this.readCounts = new Map();
      this.reportedLoops = new Set();
      this.requestsAtEdit = this.requests;
    }
    if (a.kind === 'run') alerts.push(...this.repeat('command', commandKey(a.target), this.runCounts, this.opts.rules.loop.repeatCommand));
    if (a.kind === 'read') alerts.push(...this.repeat('read', normalizeTarget(a.target), this.readCounts, this.opts.rules.loop.repeatRead));
    if (a.kind === 'run') {
      this.inCommand = true;
      const { patterns, action } = this.opts.rules.forbiddenCommands;
      const hit = action === 'off' ? undefined : patterns.find((p) => matchesCommand(a.target, p));
      if (hit && action !== 'off' && !this.reportedCommands.has(a.target)) {
        this.reportedCommands.add(a.target);
        alerts.push(this.alert('forbidden_command', action, `执行了禁用的命令：${a.target}（命中 "${hit}"）`, a.target));
      }
    } else {
      // 有了别的活动，说明命令的结果已经回来、AI 接着在做事
      this.inCommand = false;
    }
    if (a.kind === 'edit') {
      const { action } = this.opts.rules.outOfRoots;
      const file = normalizeTarget(a.target);
      if (action !== 'off' && file && !this.reportedPaths.has(file) && outOfScope([file], this.opts.writeRoots).length > 0) {
        this.reportedPaths.add(file);
        alerts.push(this.alert('out_of_roots', action, `改动了允许范围之外的文件：${file}`, file));
      }
      const offPlan = this.opts.rules.offPlan.action;
      if (offPlan !== 'off' && this.opts.scope && file && !this.reportedOffPlan.has(file) && !inScope(file, this.opts.scope)) {
        this.reportedOffPlan.add(file);
        alerts.push(this.alert('off_plan', offPlan, `改动了计划范围之外的文件：${file}`, file));
      }
    }
    return alerts;
  }

  /** 用量有了新数：这一步到目前为止的用量。 */
  usage(tokens: StepTokens): Alert[] {
    return this.unsnoozed(this.checkUsage(tokens));
  }

  private checkUsage(tokens: StepTokens): Alert[] {
    const alerts: Alert[] = [];
    const loop = this.opts.rules.loop;
    if (tokens.requests !== undefined) {
      this.requests = tokens.requests;
      const since = this.requests - this.requestsAtEdit;
      if (loop.action !== 'off' && this.opts.access === 'write' && since >= loop.requestsWithoutEdit && !this.reportedLoops.has('requests')) {
        this.reportedLoops.add('requests');
        alerts.push(this.alert('loop', loop.action, `连续 ${since} 次请求没有新的改动`));
      }
    }
    const { action, factor, minSamples } = this.opts.rules.usage;
    const base = this.opts.baseline;
    if (action === 'off' || !base) return alerts;
    const check = (key: string, label: string, value: number | undefined, ref: UsageBaseline['freshInput'], show: (n: number) => string): void => {
      if (value === undefined || !ref || ref.samples < minSamples || ref.median <= 0 || this.reportedUsage.has(key)) return;
      if (value <= ref.median * factor) return;
      this.reportedUsage.add(key);
      alerts.push(this.alert('usage', action, `${label} ${show(value)}，超过本项目同类步骤中位数 ${show(ref.median)} 的 ${factor} 倍（${ref.samples} 个样本）`));
    };
    check('fresh', '新输入', Math.max(0, tokens.input - tokens.cachedInput), base.freshInput, formatTokens);
    check('requests', '请求次数', tokens.requests, base.requests, (n) => String(Math.round(n)));
    return alerts;
  }

  /** 自上次改动以来同一条命令或同一个文件出现的次数，到了阈值报一次。 */
  private repeat(kind: 'command' | 'read', key: string, counts: Map<string, number>, limit: number): Alert[] {
    const { action } = this.opts.rules.loop;
    if (action === 'off' || !key) return [];
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const id = `${kind}:${key}`;
    if (n < limit || this.reportedLoops.has(id)) return [];
    this.reportedLoops.add(id);
    const what = kind === 'command' ? `同一条命令执行了 ${n} 次：${key}` : `同一个文件读了 ${n} 次：${key}`;
    return [this.alert('loop', action, `${what}，期间没有改动`, key)];
  }

  /** 定时检查。 */
  tick(): Alert[] {
    const { minutes, commandMinutes, action } = this.opts.rules.idle;
    if (action === 'off' || !this.opts.streams || this.idleReported || this.lastLine === undefined) return [];
    const factor = this.opts.idleFactor ?? 1;
    const limit = (this.inCommand ? commandMinutes : minutes) * factor * 60000;
    const quiet = this.now() - this.lastLine;
    if (quiet < limit || (this.snoozed.get('idle') ?? 0) > this.now()) return [];
    this.idleReported = true;
    const what = this.inCommand ? '命令执行中，' : '';
    return [this.alert('idle', action, `${what}${formatDuration(quiet)}没有任何输出`)];
  }

  private alert(rule: WatchRule, action: Exclude<WatchAction, 'off'>, detail: string, target?: string): Alert {
    return { rule, action, atMs: this.now() - this.started, detail, ...(target !== undefined && { target }) };
  }
}

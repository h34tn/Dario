/**
 * 干活监控：盯着一次运行的输出，按项目配置的规则发现"没动静""路径越界""禁用命令"。
 *
 * 这里只有判断，不碰进程，也不碰界面：调用方喂进输出、活动和定时检查，拿回告警，自己决定怎么提示、要不要中断。
 * 时钟由调用方传入，便于测试。
 */

import type { Activity } from '../plugin.js';
import type { SuperviseSettings, WatchAction } from './config.js';
import { formatDuration } from './util.js';
import { outOfScope } from './workspace.js';

export type WatchRule = 'idle' | 'out_of_roots' | 'forbidden_command';

export interface Alert {
  rule: WatchRule;
  /** 触发后的处理，不会是 off。 */
  action: Exclude<WatchAction, 'off'>;
  /** 从这次运行开始到触发时经过的毫秒数。 */
  atMs: number;
  /** 给人看的说明。 */
  detail: string;
}

export interface WatchOptions {
  rules: SuperviseSettings;
  /** 项目允许改动的范围，空表示不限制。 */
  writeRoots: string[];
  /** 工具是否逐行输出。不逐行输出时无法判断有没有动静，不检查 idle。 */
  streams: boolean;
  /** 这家 AI 的 idle 阈值倍数，默认 1。 */
  idleFactor?: number;
  now?: () => number;
}

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
  /** 最近一条活动是开始执行命令，之后还没有新的输出。 */
  private inCommand = false;
  /** 当前这段静默已经报过。有了新输出才能再报。 */
  private idleReported = false;
  private readonly reportedPaths = new Set<string>();
  private readonly reportedCommands = new Set<string>();

  constructor(private readonly opts: WatchOptions) {
    this.now = opts.now ?? Date.now;
    this.started = this.now();
  }

  /** 工具输出了一行。活动随后由 activity() 送来。 */
  line(): void {
    this.lastLine = this.now();
    this.inCommand = false;
    this.idleReported = false;
  }

  /** 认出了一条活动。 */
  activity(a: Activity): Alert[] {
    const alerts: Alert[] = [];
    if (a.kind === 'run') {
      this.inCommand = true;
      const { patterns, action } = this.opts.rules.forbiddenCommands;
      const hit = action === 'off' ? undefined : patterns.find((p) => matchesCommand(a.target, p));
      if (hit && action !== 'off' && !this.reportedCommands.has(a.target)) {
        this.reportedCommands.add(a.target);
        alerts.push(this.alert('forbidden_command', action, `执行了禁用的命令：${a.target}（命中 "${hit}"）`));
      }
    } else if (a.kind !== 'think' && a.kind !== 'say') {
      this.inCommand = false;
    }
    if (a.kind === 'edit') {
      const { action } = this.opts.rules.outOfRoots;
      const file = normalizeTarget(a.target);
      if (action !== 'off' && file && !this.reportedPaths.has(file) && outOfScope([file], this.opts.writeRoots).length > 0) {
        this.reportedPaths.add(file);
        alerts.push(this.alert('out_of_roots', action, `改动了允许范围之外的文件：${file}`));
      }
    }
    return alerts;
  }

  /** 定时检查。 */
  tick(): Alert[] {
    const { minutes, commandMinutes, action } = this.opts.rules.idle;
    if (action === 'off' || !this.opts.streams || this.idleReported || this.lastLine === undefined) return [];
    const factor = this.opts.idleFactor ?? 1;
    const limit = (this.inCommand ? commandMinutes : minutes) * factor * 60000;
    const quiet = this.now() - this.lastLine;
    if (quiet < limit) return [];
    this.idleReported = true;
    const what = this.inCommand ? '命令执行中，' : '';
    return [this.alert('idle', action, `${what}${formatDuration(quiet)}没有任何输出`)];
  }

  private alert(rule: WatchRule, action: Exclude<WatchAction, 'off'>, detail: string): Alert {
    return { rule, action, atMs: this.now() - this.started, detail };
  }
}

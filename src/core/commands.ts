/** 指令解析。所有渠道（终端交互、飞书等）共用同一套。 */

import type { Engine } from './engine.js';
import { findModel } from './ports.js';
import { formatModelTable } from './report.js';
import { ConfigError } from './util.js';
import type { ModelTarget, RoleView } from './roles.js';

export interface ModelCommand {
  kind: 'model';
  role?: string;
  value?: string;
  effort?: string;
  target: ModelTarget;
  reset: boolean;
}

/** 查看压缩界限；带 on 时打开或关闭。 */
export interface CompactCommand {
  kind: 'compact';
  on?: boolean;
}

export type Command =
  | { kind: 'task'; text: string; role?: string }
  | ModelCommand
  | { kind: 'roles' }
  | { kind: 'agents' }
  | { kind: 'help' }
  | { kind: 'pause' }
  | { kind: 'unpause' }
  | { kind: 'resume'; jobId?: string; note?: string }
  | { kind: 'role'; role: string; agent?: string; reset: boolean; save: boolean }
  | { kind: 'health'; agent?: string }
  | CompactCommand
  | { kind: 'status'; jobId?: string }
  | { kind: 'cancel'; jobId?: string }
  | { kind: 'approve'; jobId?: string }
  | { kind: 'invalid'; message: string };

export const HELP_TEXT = [
  '直接输入文字：交给主控安排',
  '/to <角色> <任务>      直接交给指定角色',
  '/roles                 查看角色表',
  '/role <角色> <AI>      临时指定担当者（加 --save 写回项目角色表）',
  '/role <角色> reset     取消临时指定',
  '/model [角色] [型号] [强度]  查看或设置型号（--save、--default、--reset）',
  '/agents                列出各家 AI',
  '/compact [on|off]      查看、开启或关闭各家的压缩界限',
  '/health [AI]           实际调用一次，确认可用',
  '/status [任务号]       查看任务',
  '/approve [任务号]      批准等待确认的计划',
  '/resume [任务号] [补充说明]  从停下的地方接着做没做完的任务',
  '/cancel [任务号]       取消任务',
  '/pause、/unpause       暂停、恢复接收新任务（常驻运行的渠道）',
].join('\n');

export function parseCommand(input: string): Command {
  const text = input.trim();
  if (!text) return { kind: 'invalid', message: '没有内容。' };
  if (!text.startsWith('/')) return { kind: 'task', text };

  const firstSpace = text.search(/\s/);
  const name = (firstSpace < 0 ? text : text.slice(0, firstSpace)).slice(1).toLowerCase();
  const rest = firstSpace < 0 ? '' : text.slice(firstSpace).trim();
  const words = rest ? rest.split(/\s+/) : [];

  switch (name) {
    case 'to': {
      const role = words[0];
      const task = rest.slice(role ? role.length : 0).trim();
      if (!role || !task) return { kind: 'invalid', message: '用法：/to <角色> <任务>' };
      return { kind: 'task', role, text: task };
    }
    case 'model': return parseModel(words);
    case 'roles':
      return { kind: 'roles' };
    case 'agents':
      return { kind: 'agents' };
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'pause':
      return { kind: 'pause' };
    case 'unpause':
      return { kind: 'unpause' };
    case 'resume': {
      // 紧跟的词形如 J 加数字时才是任务号，其余都是给接手角色的补充说明
      const id = words[0] && /^J\d+$/i.test(words[0]) ? words[0].toUpperCase() : undefined;
      const note = (id ? rest.slice(words[0]!.length) : rest).trim();
      return { kind: 'resume', ...(id && { jobId: id }), ...(note && { note }) };
    }
    case 'role': {
      const save = words.includes('--save');
      const args = words.filter((w) => w !== '--save');
      const [role, agent] = args;
      if (!role || !agent) return { kind: 'invalid', message: '用法：/role <角色> <AI> [--save]，或 /role <角色> reset' };
      if (agent === 'reset' || agent === '--reset') return { kind: 'role', role, reset: true, save: false };
      return { kind: 'role', role, agent, reset: false, save };
    }
    case 'health':
      return { kind: 'health', agent: words[0] };
    case 'compact': return parseCompact(words);
    case 'status':
    case 'jobs':
    case 'job':
      return { kind: 'status', jobId: words[0] };
    case 'cancel':
      return { kind: 'cancel', jobId: words[0] };
    case 'approve':
      return { kind: 'approve', jobId: words[0] };
    default:
      return { kind: 'invalid', message: `不认识的指令：/${name}。输入 /help 查看可用指令。` };
  }
}

export function parseModel(words: string[], effort?: string): ModelCommand | Extract<Command, { kind: 'invalid' }> {
  const flags = words.filter(w => w.startsWith('-'));
  const args = words.filter(w => !w.startsWith('-'));
  const [role, value, level] = args;
  const flag = flags[0];
  const reset = flag === '--reset';
  const hasSetting = !!(value || effort);
  const badFlag = flags.length > 1 || (flag && !['--save', '--default', '--reset'].includes(flag));
  const badTarget = flag && (!role || (reset ? hasSetting : !hasSetting));
  if (badFlag || badTarget || args.length > 3 || (effort && (!role || level))) {
    return { kind: 'invalid', message: '用法：/model [角色 [型号] [强度] [--save | --default]]，或 /model <角色> --reset' };
  }
  return { kind: 'model', role, value, effort: effort ?? level, reset,
    target: flag === '--save' ? 'project' : flag === '--default' ? 'default' : 'local' };
}

export function parseCompact(words: string[]): CompactCommand | Extract<Command, { kind: 'invalid' }> {
  const word = words[0]?.toLowerCase();
  if (words.length > 1 || (word && !['on', 'off'].includes(word))) return { kind: 'invalid', message: '用法：/compact [on|off]' };
  return { kind: 'compact', ...(word && { on: word === 'on' }) };
}

export function runCompact(engine: Engine, cmd: CompactCommand): string {
  const lines: string[] = [];
  if (cmd.on !== undefined) lines.push(`压缩界限已${cmd.on ? '开启' : '关闭'}，已写入 ${engine.setCompactLimits(cmd.on)}，下一步起生效。`);
  const { enabled, agents } = engine.compactLimits();
  const set = agents.filter(a => a.limit);
  if (!set.length) {
    lines.push(`压缩界限：${enabled ? '开启' : '关闭'}。还没有给任何 AI 设界限，各家按工具自己的默认值压缩。`,
      '要设界限，在 ~/.dario/agents.yaml 里给对应的 AI 写 compact_limit: <token 数>。');
    return lines.join('\n');
  }
  lines.push(enabled ? '压缩界限：开启' : '压缩界限：关闭，各家按工具自己的默认值压缩。开启后按下面的界限：');
  for (const a of set) lines.push(`  ${a.id}  ${a.limit} token${a.supported ? '' : '（插件不支持，不生效）'}`);
  const rest = agents.filter(a => !a.limit && a.supported).map(a => a.id);
  if (enabled && rest.length) lines.push(`${rest.join('、')} 没设界限，按工具自己的默认值压缩。`);
  return lines.join('\n');
}

/** 每个担当者只查一次，各家独立刷新显示名。 */
export async function refreshHolderModels(engine: Engine, views: RoleView[], refreshed?: (agent: string) => void) {
  const holders = new Set(views.flatMap(view => view.holder ? [view.holder] : []));
  await Promise.allSettled([...holders].map(async agent => {
    const list = await engine.roles.listModels(agent);
    if (!list.error) refreshed?.(agent);
  }));
}

export async function runModel(engine: Engine, cmd: ModelCommand): Promise<string> {
  if (cmd.reset) return engine.resetModel(cmd.role!);
  const views = await engine.rolesView();
  if (!cmd.role) {
    await refreshHolderModels(engine, views);
    return formatModelTable(views, engine.roles.modelLabel).join('\n');
  }
  const id = engine.roles.resolve(cmd.role);
  const role = views.find(v => v.id === id);
  if (!role) throw new ConfigError(`没有这个角色：${cmd.role}`);
  if (!role.holder) throw new ConfigError(`角色 ${role.id} 目前没有可用的 AI`);
  if (cmd.value || cmd.effort) {
    let effortOnly = !cmd.effort && !!cmd.value && engine.roles.efforts(role.holder).includes(cmd.value);
    // 只给了一个词、又不在工具的通用档位里：它可能是当前型号独有的档位（例如 Codex 部分型号的 ultra）。
    // 以工具此刻返回的清单为准：先当型号找，找不到再看是不是当前型号自己的档位
    if (!effortOnly && !cmd.effort && cmd.value) {
      const list = await engine.roles.listModels(role.holder);
      if (!list.error && !findModel(list.models, cmd.value)) {
        const current = role.candidates.find(c => c.agent === role.holder)?.model;
        effortOnly = !!findModel(list.models, current)?.efforts?.includes(cmd.value);
      }
    }
    const settings = effortOnly ? { effort: cmd.value } : { model: cmd.value, effort: cmd.effort };
    return engine.setModel(role.id, settings, cmd.target);
  }
  const list = await engine.roles.listModels(role.holder);
  const current = formatModelTable([role], engine.roles.modelLabel)[0]!;
  if (list.error) return current + '\n没能取到型号清单：' + list.error;
  const choices = list.models.map(m => `${m.label || m.id}  ${m.id}`).join('\n') || '无';
  return current + '\n可选的型号：\n' + choices;
}

/** 管理员才能执行的指令。 */
export function requiresAdmin(cmd: Command): boolean {
  return (cmd.kind === 'model' && !!(cmd.value || cmd.effort || cmd.reset)) || (cmd.kind === 'compact' && cmd.on !== undefined) ||
    cmd.kind === 'role' || cmd.kind === 'health' || cmd.kind === 'pause' || cmd.kind === 'unpause';
}

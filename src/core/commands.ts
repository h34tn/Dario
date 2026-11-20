/** 指令解析。所有渠道（终端交互、飞书等）共用同一套。 */

export type Command =
  | { kind: 'task'; text: string; role?: string }
  | { kind: 'roles' }
  | { kind: 'agents' }
  | { kind: 'help' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'role'; role: string; agent?: string; reset: boolean; save: boolean }
  | { kind: 'health'; agent?: string }
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
  '/agents                列出各家 AI',
  '/health [AI]           实际调用一次，确认可用',
  '/status [任务号]       查看任务',
  '/approve [任务号]      批准等待确认的计划',
  '/cancel [任务号]       取消任务',
  '/pause、/resume        暂停、恢复接收新任务',
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
    case 'roles':
      return { kind: 'roles' };
    case 'agents':
      return { kind: 'agents' };
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'pause':
      return { kind: 'pause' };
    case 'resume':
      return { kind: 'resume' };
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

/** 管理员才能执行的指令。 */
export function requiresAdmin(cmd: Command): boolean {
  return cmd.kind === 'role' || cmd.kind === 'health' || cmd.kind === 'pause' || cmd.kind === 'resume';
}

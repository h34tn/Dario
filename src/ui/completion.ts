export interface Suggestion {
  value: string;
  label: string;
  hint: string;
}

export interface CompletionContext {
  roles: Array<{ id: string; alias: string[] }>;
  agents: string[];
}

const commands = [
  ['/to <角色> <任务>', '直接交给指定角色'],
  ['/roles', '查看角色表'],
  ['/role <角色> <AI>', '临时指定担当者'],
  ['/agents', '列出各家 AI'],
  ['/health [AI]', '实际调用一次，确认可用'],
  ['/status [任务号]', '查看任务'],
  ['/approve <任务号>', '批准等待确认的计划'],
  ['/cancel [任务号]', '取消任务'],
  ['/diff', '查看上一个任务的改动'],
  ['/new', '清空会话上文与 AI 会话'],
  ['/plain', '切换到逐行交互'],
  ['/help', '查看全部指令'],
  ['/exit', '退出'],
] as const;

export function suggest(line: string, ctx: CompletionContext): Suggestion[] {
  if (!line.startsWith('/')) return [];
  const [name, ...args] = line.split(/\s+/);
  const command = name!.toLowerCase();
  if (!args.length) return commands.filter(([label]) => label.startsWith(command)).slice(0, 6)
    .map(([label, hint]) => ({ label, hint, value: label.replace(/ .*/, ' ') }));

  const prefix = args.at(-1)!.toLowerCase();
  let options: Suggestion[];
  if ((command === '/to' || command === '/role') && args.length === 1) {
    const names = ctx.roles.flatMap(({ id, alias }) => alias.map(label => ({ label, hint: id })))
      .concat(ctx.roles.map(({ id, alias }) => ({ label: id, hint: alias[0] ?? '' })));
    options = names.map(item => ({ ...item, value: `${command} ${item.label} ` }));
  } else if ((command === '/role' && args.length === 2) || (command === '/health' && args.length === 1)) {
    const base = command === '/role' ? `/role ${args[0]} ` : '/health ';
    options = ctx.agents.map(label => ({ label, hint: '', value: base + label }));
    if (command === '/role') options.push({ label: 'reset', hint: '恢复为角色表里的顺序', value: base + 'reset' });
  } else return [];
  return options.filter(item => item.label.toLowerCase().startsWith(prefix)).slice(0, 6);
}

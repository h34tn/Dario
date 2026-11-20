import { codexActivities, defineAgent, parseJsonLines, parseStreamJsonResult, PLUGIN_API_VERSION, streamJsonActivities, type AgentPlugin, type InvokeRequest } from '../plugin.js';

function extraArgs(req: InvokeRequest): string[] {
  const extra = req.options.extra_args;
  return Array.isArray(extra) ? extra.map(String) : [];
}

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** Claude Code 与 CodeBuddy 的命令行参数形式相同。 */
function claudeStyleArgs(req: InvokeRequest): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', req.access === 'write' ? 'acceptEdits' : 'dontAsk'];
  if (req.model) args.push('--model', req.model);
  args.push(...extraArgs(req));
  if (req.allowedTools.length > 0) args.push('--allowedTools', ...req.allowedTools);
  // 只读时明确禁止编辑类工具，不受用户自己设置里的放行影响
  if (req.access === 'read-only') args.push('--disallowedTools', ...EDIT_TOOLS);
  return args;
}

export const claudePlugin: AgentPlugin = defineAgent({
  apiVersion: PLUGIN_API_VERSION,
  id: 'claude',
  progress: streamJsonActivities,
  displayName: 'Claude Code',
  defaultCommand: 'claude',
  streams: true,
  envPass: ['ANTHROPIC_*', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_*', 'CLAUDE_CODE_GIT_BASH_PATH'],
  defaultAllowedTools: { readOnly: READ_TOOLS, write: [...READ_TOOLS, ...EDIT_TOOLS] },
  build: (req) => ({ args: claudeStyleArgs(req), stdin: req.prompt }),
  parse: (raw) => parseStreamJsonResult(raw.stdout),
});

export const codebuddyPlugin: AgentPlugin = defineAgent({
  apiVersion: PLUGIN_API_VERSION,
  id: 'codebuddy',
  progress: streamJsonActivities,
  displayName: 'CodeBuddy',
  defaultCommand: 'codebuddy',
  streams: true,
  envPass: ['CODEBUDDY_*'],
  defaultAllowedTools: { readOnly: READ_TOOLS, write: [...READ_TOOLS, ...EDIT_TOOLS] },
  build: (req) => ({ args: claudeStyleArgs(req), stdin: req.prompt }),
  parse: (raw) => parseStreamJsonResult(raw.stdout),
});

export const codexPlugin: AgentPlugin = defineAgent({
  apiVersion: PLUGIN_API_VERSION,
  id: 'codex',
  progress: codexActivities,
  displayName: 'Codex',
  defaultCommand: 'codex',
  streams: true,
  envPass: ['OPENAI_*', 'CODEX_*'],
  build: (req) => {
    const args = [
      'exec',
      '-C',
      req.cwd,
      '-s',
      req.access === 'write' ? 'workspace-write' : 'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--json',
      '-o',
      req.resultFile,
    ];
    if (req.model) args.push('-m', req.model);
    args.push(...extraArgs(req));
    // 末尾的 - 表示任务说明从标准输入读取
    args.push('-');
    return { args, stdin: req.prompt };
  },
  parse: (raw) => {
    const events = parseJsonLines(raw.stdout);
    let lastMessage = '';
    let usage: unknown;
    const errors: string[] = [];
    let turnFailed = false;
    for (const e of events) {
      const item = e.item as { type?: string; text?: string; message?: string } | undefined;
      if (e.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text;
      else if (e.type === 'turn.completed') usage = e.usage;
      else if (e.type === 'turn.failed') {
        turnFailed = true;
        const err = e.error as { message?: string } | undefined;
        if (err?.message) errors.push(err.message);
      } else if (e.type === 'error' && typeof e.message === 'string') errors.push(e.message);
    }
    const text = (raw.resultFileText ?? '').trim() || lastMessage;
    if (turnFailed || !text) {
      // 失败时把 Codex 报的错误带出来，供判断是否"不可用"
      return { text: [...errors, text].filter(Boolean).join('\n'), isError: true, usage };
    }
    return { text, usage };
  },
});

export const BUILTIN_PLUGINS: AgentPlugin[] = [claudePlugin, codexPlugin, codebuddyPlugin];

/** 内置的 AI：id → 使用的插件与默认设置。 */
export const BUILTIN_AGENTS: Record<string, { plugin: string; model?: string }> = {
  claude: { plugin: 'claude' },
  codex: { plugin: 'codex' },
  codebuddy: { plugin: 'codebuddy' },
  deepseek: { plugin: 'codebuddy', model: 'deepseek-v4-pro' },
};

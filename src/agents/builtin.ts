import {
  codexActivities,
  codexMeter,
  defineAgent,
  parseJsonLines,
  parseStreamJsonResult,
  PLUGIN_API_VERSION,
  streamJsonActivities,
  streamJsonMeter,
  type AgentPlugin,
  type InvokeRequest,
} from '../plugin.js';

/**
 * 本机配置里追加的参数：extra_args 两种方式都加；write_args 只在可写方式加，read_only_args 只在只读方式加。
 * 分开是因为有的设置只该给一种方式，例如放行某个 MCP 服务只给可写、关掉它只给只读。
 */
function extraArgs(req: InvokeRequest): string[] {
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  return [...list(req.options.extra_args), ...list(req.access === 'write' ? req.options.write_args : req.options.read_only_args)];
}

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
// 可写角色要自己把任务做完：跑测试、跑生成脚本、调用项目自己的工具都要执行命令
const EXEC_TOOLS = ['Bash', 'PowerShell'];

/** Claude Code 与 CodeBuddy 的命令行参数形式相同。 */
function claudeStyleArgs(req: InvokeRequest): string[] {
  // --include-partial-messages：每条消息结束时都报准确的 token 用量，运行中就能显示；不加时要等整次运行结束
  // 可写方式默认全部放行（bypassPermissions）：任务要由角色自己做完，需要什么工具都能用；
  // 用户把权限设为按清单放行时用 acceptEdits，只有清单里的工具能用。
  const mode = req.access === 'read-only' ? 'dontAsk' : req.unrestricted ? 'bypassPermissions' : 'acceptEdits';
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode];
  // 续接只带回对话历史，权限与工具清单仍按这一次的参数生效
  // 只读时不加载任何 MCP 服务：用户或项目自己的设置里放行过的 MCP 工具（例如在编辑器里执行代码）
  // 不受下面两份清单约束，只读角色会借它动手干活。要用这些工具的工作应当分派给可写的角色。
  if (req.access === 'read-only') args.push('--strict-mcp-config');
  if (req.resume) args.push('--resume', req.resume);
  if (req.model) args.push('--model', req.model);
  args.push(...extraArgs(req));
  if (req.allowedTools.length > 0 && !req.unrestricted) args.push('--allowedTools', ...req.allowedTools);
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
  resumes: true,
  // 后两个是 Claude Code 自动压缩会话历史的阈值设置：用户为自己调过的上限，续接时照样生效
  envPass: ['ANTHROPIC_*', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_*', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'],
  defaultAllowedTools: { readOnly: READ_TOOLS, write: ['Read', 'Grep', 'Glob', ...EDIT_TOOLS, ...EXEC_TOOLS] },
  build: (req) => ({ args: claudeStyleArgs(req), stdin: req.prompt }),
  parse: (raw) => parseStreamJsonResult(raw.stdout),
  meter: () => streamJsonMeter({ inputIncludesCache: false }),
});

export const codebuddyPlugin: AgentPlugin = defineAgent({
  apiVersion: PLUGIN_API_VERSION,
  id: 'codebuddy',
  progress: streamJsonActivities,
  displayName: 'CodeBuddy',
  defaultCommand: 'codebuddy',
  streams: true,
  resumes: true,
  envPass: ['CODEBUDDY_*'],
  defaultAllowedTools: { readOnly: READ_TOOLS, write: ['Read', 'Grep', 'Glob', ...EDIT_TOOLS, ...EXEC_TOOLS] },
  build: (req) => ({ args: claudeStyleArgs(req), stdin: req.prompt }),
  parse: (raw) => parseStreamJsonResult(raw.stdout),
  // 实测 CodeBuddy 报的 input_tokens 已经包含命中缓存的部分
  meter: () => streamJsonMeter({ inputIncludesCache: true }),
});

export const codexPlugin: AgentPlugin = defineAgent({
  apiVersion: PLUGIN_API_VERSION,
  id: 'codex',
  progress: codexActivities,
  meter: codexMeter,
  displayName: 'Codex',
  defaultCommand: 'codex',
  streams: true,
  resumes: true,
  envPass: ['OPENAI_*', 'CODEX_*'],
  build: (req) => {
    // 沙箱方式是 exec 自己的参数，续接时必须写在 resume 之前才对这一轮生效
    // 可写方式默认全部放行：不走沙箱、不审批（沙箱里起不了子进程，跑不了生成脚本和完整测试，MCP 调用也要逐个预先批准）。
    // 用户把权限设为按清单放行时用 workspace-write 沙箱。
    const access = req.access === 'read-only' ? ['-s', 'read-only'] : req.unrestricted ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-s', 'workspace-write'];
    const args = ['exec', '-C', req.cwd, ...access, '--skip-git-repo-check', '--color', 'never'];
    if (req.resume) args.push('resume', req.resume);
    args.push('--json', '-o', req.resultFile);
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
    let sessionId: string | undefined;
    const errors: string[] = [];
    let turnFailed = false;
    for (const e of events) {
      const item = e.item as { type?: string; text?: string; message?: string } | undefined;
      if (e.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text;
      else if (e.type === 'thread.started' && typeof e.thread_id === 'string' && e.thread_id) sessionId = e.thread_id;
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
      return { text: [...errors, text].filter(Boolean).join('\n'), isError: true, usage, sessionId };
    }
    return { text, usage, sessionId };
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

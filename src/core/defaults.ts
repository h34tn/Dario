/** 内置默认配置。`dario init` 生成的文件也取自这里，保证只有一份。 */

export const DEFAULT_ROLES_YAML = `# 角色表：每个角色的候选 AI 及顺序。
# 担当者 = 用 \`dario role\` 临时指定的那家；没有指定时取候选里第一个可用的。
# 这里只能按名字引用 AI，不能写命令；AI 的命令在本机的 ~/.dario/agents.yaml 里配置。

roles:
  lead:
    alias: [主控]
    description: 读任务、出计划、最后汇总。
    candidates: [claude, codex]
    access: read-only
  executor:
    alias: [执行者, 执行]
    description: 动手完成任务：写代码、改文件、整理资料等。
    candidates: [codex, claude, codebuddy]
    access: write
  # 要让测试者能运行测试或程序，在本机 ~/.dario/agents.yaml 里给它的候选放行相应的命令。
  tester:
    alias: [测试者, 测试]
    description: 验证结果：补测试、运行测试或程序、确认效果，如实报告通过与否。
    candidates: [claude, codebuddy]
    access: write
  reviewer:
    alias: [审核者, 审核]
    description: 只读审核改动、评估方案，给出通过或不通过的结论。
    candidates: [claude, codex]
    access: read-only
    must_differ_from: executor

# auto：某家不可用时自动换下一家；ask：先问一句，同意后再换；manual：只报告，等人换
fallback: auto
`;

export const DEFAULT_PROJECT_YAML = `# 项目设置

# 承担"主控"和"审核"两个职能的角色
lead_role: lead
review_role: reviewer

# 是否允许主控留下小改动，确认计划后自己执行
lead_implements: true

# 允许改动的目录（相对项目根目录）。留空表示不限制。
write_roots: []

# 审查不通过时最多返工几轮
max_rework_rounds: 2

# 单步时限（分钟）。角色或 AI 上另有设置时以它们为准。
default_timeout_minutes: 30

# 一份计划最多几步
max_plan_steps: 8

# 附在每次任务说明前面的固定文字
preamble: ""

# 每个任务开工前是否先与远端同步（就地执行时）。
# off：不同步。
# pull：先 git fetch；本地落后时 git pull --rebase。工作区有未提交的改动又落后于远端时，不自动暂存，任务不开始并说明情况。
# pull-autostash：同上，但有未提交的改动时用 --autostash 自动暂存、拉取后放回。
sync_before_task: off

# 干活监控：运行中发现问题时怎么处理。action 可选 off（不检查）、notify（只提示）、stop（中断这一步，任务停下）。
# 这只是发现问题的手段，不是安全边界：绕过检查的写法（例如写个脚本去执行）它查不出来。
supervise:
  # 没动静：超过 minutes 分钟没有任何输出；正在执行命令时用 command_minutes。到结束才输出的工具不检查。
  idle: { minutes: 10, command_minutes: 30, action: notify }
  # 改了 write_roots 之外的文件。write_roots 为空时不检查。
  out_of_roots: { action: notify }
  # 执行了清单里的命令。按词前缀匹配："git push" 匹配 "git push origin main"。清单为空时不检查。
  forbidden_commands: { patterns: [], action: notify }
`;

export function defaultDispatchRules(leadImplements: boolean): string {
  const smallChange = leadImplements
    ? '- 开启 lead_implements 时，主控可以留下只涉及一两个文件、总共几十行以内的小改动：出计划时已读过相关代码，知道具体怎么改，无需大范围了解项目。拿不准、范围广、要操作编辑器或其他外部工具、验证耗时长，都交给其他角色。\n'
    : '';
  return `# 分派规则

主控按下面的规则决定每一步交给哪个角色。按项目实际情况修改本文件。

${smallChange}- ${leadImplements ? '其余' : ''}要动手的工作交给"执行者"：写代码、改文件、整理资料。
- 要验证的工作交给"测试者"：补测试、运行测试或程序、确认效果。行为有变化的改动，在执行之后安排一步验证。
- 只需要阅读和判断的工作（评估方案、检查改动）交给"审核者"。
- 任务由这些角色自己做完，不安排要人中途介入的步骤；人只在全部结束后看最终结果。
- 一步只做一件事。能一步做完的不要拆成多步。
- 改了文件的计划会在最后自动追加一次审核，不必专门安排。
`;
}

export const DEFAULT_DISPATCH_RULES = defaultDispatchRules(true);

export const DEFAULT_AGENTS_YAML = `# 本机的 AI 配置。本文件只在这台机器上生效，不要放进仓库。
#
# 内置的 AI：claude、codex、codebuddy，以及 deepseek（CodeBuddy 插件 + DeepSeek 模型）。
# 下面的每一项都是可选的，不写就用内置默认值。

# 额外加载的插件：声明式清单（.yaml）、代码模块（.mjs / .js）或已安装的包名。
# 相对路径相对于本文件所在目录。
plugins: []

agents: {}
  # claude:
  #   command: C:/path/to/claude.exe     # 可执行文件，默认按名字在 PATH 里找
  #   model: sonnet                      # 模型
  #   timeout_minutes: 30
  #   enabled: true
  #   free: true                         # 免费模型，额度固定按 0% 显示，不采集
  #   allowed_tools:                     # 放行的工具清单；不写时可写方式放行读取、搜索、文件编辑和命令执行
  #     read_only: [Read, Grep, Glob]
  #     write: [Read, Grep, Glob, Edit, Write, Bash, PowerShell, mcp__某个服务]
  #   env_pass: [MY_PROXY_*]             # 额外传给它的环境变量
  # codebuddy:
  #   model: glm-5.3                     # 不写则用 CodeBuddy 自己的默认模型

# 可写角色（执行者、测试者）的权限。
# full：全部放行，不逐项审批。任务要由角色自己做完，需要什么工具、命令、MCP 都能用，各家 AI 自己把握分寸。
# listed：只放行 allowed_tools 清单里的工具（没写清单时是读取、搜索、文件编辑和命令执行）。
# 主控出计划、汇总和审核者审查时只读；主控执行自己的步骤或返工时用可写权限。某一家要单独设置，在它的条目里写 permissions。
permissions: full

# 某家 AI 被判为不可用后，多久之内不再尝试（分钟）
cooldown_minutes: 10

# 启动后多久没有任何输出就判为不可用（秒）
startup_timeout_seconds: 120
# 某家 AI 平时输出就稀疏、常被误报"没动静"时，在它的条目里写 idle_factor: 2，把项目设的阈值对它放宽一倍。

# 额外传给所有 AI 的环境变量
env_pass: []
`;

export const DEFAULT_CHANNELS_YAML = `# 渠道配置。本文件只在这台机器上生效。

feishu:
  enabled: false
  # 飞书应用凭据所在的环境变量名（凭据本身不要写进文件）
  app_id_env: DARIO_FEISHU_APP_ID
  app_secret_env: DARIO_FEISHU_APP_SECRET
  # 隔离执行用的独立克隆（其中的 .dario/ 提供角色表）。不能是日常开发用的工作目录。
  project: ""
  # 任务分支的起点，留空则取远端默认分支
  base_branch: ""
  # 明确禁止用作隔离克隆的路径
  forbidden_paths: []
  # 允许使用的会话（群的 chat_id）
  conversations: []
  # 每人每分钟最多下达几个任务、最多排队几个
  rate_limit_per_minute: 5
  max_queue: 10
  # 含改文件步骤的计划是否免确认
  auto_approve: false
  # 单条回复的最大字数，超出部分存到任务目录
  reply_max_chars: 6000
`;

export const DEFAULT_ACCESS_YAML = `# 各渠道的成员与管理员，使用渠道内的用户 ID（飞书为 open_id）。
# 不在名单里的人发来的消息不会得到任何回复。

feishu:
  members: []
  admins: []
`;

export const HEALTH_PROMPT = '这是一次可用性检查。只回复两个字：正常';

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
  coder:
    alias: [实现]
    description: 写代码、改文件。
    candidates: [codex, claude, codebuddy]
    access: write
  server:
    alias: [服务端]
    description: 服务端与配表相关的改动。
    candidates: [codex, codebuddy]
    access: write
  reviewer:
    alias: [审查]
    description: 只读审查改动，给出通过或不通过的结论。
    candidates: [claude, codex]
    access: read-only
    must_differ_from: coder
  bulk:
    alias: [杂活]
    description: 量大、低风险的工作，如批量检查、整理、文档初稿。
    candidates: [codebuddy, deepseek]
    access: write

# auto：某家不可用时自动换下一家；ask：先问一句，同意后再换；manual：只报告，等人换
fallback: auto
`;

export const DEFAULT_PROJECT_YAML = `# 项目设置

# 承担"主控"和"审查"两个职能的角色
lead_role: lead
review_role: reviewer

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
`;

export const DEFAULT_DISPATCH_RULES = `# 分派规则

主控按下面的规则决定每一步交给哪个角色。按项目实际情况修改本文件。

- 需要写代码、改文件的工作交给"实现"。
- 服务端与配表相关的改动交给"服务端"。
- 量大、重复、低风险的工作（批量检查、整理、文档初稿）交给"杂活"。
- 只需要阅读和判断的工作（评估方案、检查改动）交给"审查"。
- 一步只做一件事。能一步做完的不要拆成多步。
- 改了文件的计划，最后要有一步交给"审查"。
`;

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
  #   allowed_tools:                     # 放行的工具清单
  #     read_only: [Read, Grep, Glob]
  #     write: [Read, Grep, Glob, Edit, Write, "Bash(npm test:*)"]
  #   env_pass: [MY_PROXY_*]             # 额外传给它的环境变量
  # codebuddy:
  #   model: glm-5.3                     # 不写则用 CodeBuddy 自己的默认模型

# 某家 AI 被判为不可用后，多久之内不再尝试（分钟）
cooldown_minutes: 10

# 启动后多久没有任何输出就判为不可用（秒）
startup_timeout_seconds: 120

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

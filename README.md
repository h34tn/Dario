# Dario

按角色调用各家 AI 编码工具的命令行程序。

你维护一份角色表（主控、执行者、测试者、审核者），写明每个角色由哪家 AI 担当；Dario 负责按角色启动本机已安装的 Claude Code、Codex、CodeBuddy 等工具，在某一家不可用时自动换下一家。也可以接上飞书，在群里下达任务。

设计约定见 [SPEC.md](SPEC.md)。

## 安装

需要 Node 22 及以上，以及至少一家已登录的 AI 命令行工具。

```
git clone https://github.com/h34tn/Dario.git
cd Dario
npm install
npm run build
npm link          # 得到全局的 dario 命令
```

## 开始使用

```
cd 你的项目
dario init        # 生成 .dario/（项目配置）并补齐 ~/.dario/（本机配置）
dario check       # 确认各家 AI 已安装、角色表没有问题
```

```
dario --to 审核者 "看一下 src/login.ts 有没有空指针问题"
dario --to 执行者 "把 src/answer.ts 里的 41 改成 42"
dario "给登录接口加上次数限制"            # 交给主控：出计划、确认、执行、审查、汇总
dario                                      # 交互方式
dario -c                                   # 交互方式，接上这个项目上一次的会话
dario -c J0027                             # 交互方式，还原到指定任务结束时的会话
```

主控出计划时只读。已经读过代码、清楚怎么改的小改动（一两个文件、总共几十行以内），可以列为主控自己的步骤，确认后续接会话完成，改完照常审查。主控给出的计划如果要改文件，会先停下来等你确认：

```
dario -p "给登录接口加上次数限制"          # 打印计划，退出码 4
dario approve J0007                        # 批准后执行
dario -p --yes "给登录接口加上次数限制"    # 或者直接免确认
```

任务停在半截时（某一步受阻，比如 Unity MCP 断了；或者失败、超时、被取消、Dario 中途退出），问题解决后可以从停下的地方接着做，不用从头再走一遍：

```
dario resume                               # 接着做本项目最近的一个任务
dario resume J0007 Unity 已经重启          # 指定任务号，后面可以写一句补充说明给接手的角色
```

交互里输入 `/resume [任务号] [补充说明]`，效果相同。续接沿用原任务号和原计划，做成的步骤不重做；受阻的那一步接着原来的会话做，其他没做完的一步新开会话，并告诉它上次停在哪里、工作区里可能有改了一半的文件。停下之后被改过的文件会列给接手的角色，也计入这个任务的改动，照常审查。审查返工到上限而停下的任务，续接时直接按最后一次审查的问题再返工一轮。任务停下时，结果末尾会提示能不能续接、怎么接。远程渠道的任务暂不支持续接。

换人：

```
dario roles                    # 看每个角色现在由谁担当
dario role 执行者 claude         # 临时改由 Claude Code 担当，只在本机生效
dario role 执行者 claude --save  # 写回项目的角色表
dario role 执行者 --reset        # 恢复
```

某家 AI 达到限额、登录失效或过载时，Dario 默认自动换成候选里的下一家。想先被问一句再换，把项目 `.dario/roles.yaml` 最后一行改成 `fallback: ask`：

```
! 主控的担当者 claude（Fable 5.2[high]） 不可用（You've hit your limit · resets 6pm）。
  改用备选 codex（GPT-6.2-Astra[medium]） 继续这个任务吗？
改用备选继续吗？  y 继续   n 停止任务
```

同一个任务里同一对换人只问一次。脚本里用 `--yes` 表示事先同意；既没法询问又没加 `--yes` 时不换人，任务停下并说明原因。

### 给角色选型号和强度

`/model` 只调整角色当前担当的 AI。换 AI 用 `/role`。在全屏或行内界面输入 `/model` 选角色，或用 `/model 执行者` 直接选型号。上下键选型号，左右键调强度，Enter 保存，Esc 返回。逐行交互和飞书会打印同样的设置，指定角色时列出工具当前提供的型号。

```
/model 执行者 high                # 只调强度
/model 主控 opus high             # 写本机角色设置（主控由 Claude 担当时）
/model 主控 opus high --save      # 写项目角色表建议
/model 主控 opus high --default   # 写本机这家 AI 的默认值
/model 主控 --reset               # 删除本机对这个角色、这家 AI 的设置
dario model 主控 opus --effort high
```

界面用 `显示名[强度]` 展示当前设置，例如 `Fable 5.2[high]`。型号清单每行先显示名称，再列出标识，同名型号可按标识区分。选中哪一行，就把该行的标识原样写入配置并传给工具。手写的标识也可以匹配工具返回的实际型号，例如 `claude-fable-5-2` 可以匹配别名 `fable`。

每次成功取得清单都会更新 `~/.dario/state/models.json` 中这家 AI 的显示名对照。全屏和行内界面启动时在后台分别查询角色表里用到的 AI。不带角色运行 `dario model` 或 `/model` 会并发查询当前担当者，每家只查一次。文本列表等查询结束后对齐各列；选择界面先显示已有名称，再随查询结果刷新。查看指定角色的清单、保存设置和执行 `dario check` 时也会刷新。查询失败会保留上次的对照；`dario roles`、`dario agents` 直接读取对照，缺少显示名时显示标识。

型号与强度分别按本机角色设置 → 项目建议 → 本机 AI 默认 → 工具默认取值。在选择界面保存“默认”强度会删除本机角色层的强度，继承项目、AI 或工具的默认设置。指令里省略强度会保留同层已有值。保存型号或用 `dario role … --save` 保存候选首位时，只改配置中相应的条目，其他行保留原格式。清单外的型号不能通过指令保存，查询失败时仍可只改强度。任务运行期间保存的设置从下一步起生效。

给脚本或其他 AI 调用：

```
dario -p --to 审核者 --output-format json "检查这次改动" < 任务说明.txt
```

退出码：0 完成 · 1 任务失败 · 2 用法或配置错误 · 3 没有可用的 AI · 4 计划等待确认 · 5 取消或超时。

## 终端界面

在终端里运行时，Dario 会显示实时进度：现在是哪一步、哪个角色、哪家 AI、用了多久、用了多少 token（`↑` 新发送的输入，不含命中缓存的部分；`↓` 输出），以及这家 AI 此刻在读哪个文件、执行什么命令。输出被管道或文件接走时自动变成纯文本，给脚本用的输出格式不受影响。

任务结束后（以及 `dario job <任务号>`）会列出各步明细和按阶段的汇总：每一步的启动耗时、请求次数、首次输入（起一次进程就要付的固定开销）和任务说明字数，以及计划、执行、返工、审查、汇总各花了多少时间和 token，方便看出时间和用量花在了哪一段。

不带任务直接运行 `dario` 默认进入全屏界面。历史在上方，输入框、按键提示和状态栏在下方：

```
----------------------------------------
> 给背包窗口加一个按品质排序的按钮
----------------------------------------
  / 指令   Alt+V 粘贴图片   PgUp/PgDn 翻看   Shift+Enter 换行   Esc 中断当前任务   Ctrl+C 退出
rise · 主控 claude · 执行者 codex · 测试者 claude · 审核者 claude
```

状态栏里型号后面的百分数是该 AI 最近一次运行时报告的已用额度。Claude Code 和 Codex 由工具自己报告，CodeBuddy 不报告。如果工具标了主窗口，状态栏只显示这个窗口的比例。到达主窗口的重置时刻，数字就会隐藏，直到下一次运行报告新额度。如果工具没标主窗口，就显示尚未过期窗口中最高的已用比例，全部过期后隐藏数字。用 `/agents` 或 `dario agents` 可以查看所有尚未过期的窗口和各自的重置时间，也可以用 `dario health <AI>` 实际调用一次来刷新。在 `~/.dario/agents.yaml` 里给免费的 AI 写上 `free: true`，状态栏就会显示 `0%`。

- 直接输入文字是把任务交给主控；`/to 执行者 …` 直接交给某个角色。
- 输入 `/` 弹出指令列表，上下键选择，Tab 补全，Enter 选中并执行。需要补参数时，Enter 先补全，等你继续输入。`/help` 查看全部指令。
- 任务运行时可以继续输入，新任务会排队。
- 后一个任务自动带上前一个任务的结论，各角色也接着用上一个任务的 AI 会话，不必重新读一遍项目，同一个会话已经知道的内容 Dario 不再重发：角色说明、工作规则和项目约定只在会话第一次发（项目配置改了会重发一次），上一个任务的结论也只发给没参加那个任务的角色；`/new` 清空，从头开始。同一个问题做完、要换一个问题时，记得 `/new`。
- 退出后再进来（比如更新 Dario 之后）可以接着做：启动时加 `-c`（`--continue`），或者进来后输入 `/continue`。想回到更早的某个任务，在后面写任务号：`dario -c J0027` 或 `/continue J0027`（任务号用 `dario jobs` 查）；会话还原成那个任务刚结束时的样子，只能接本项目里已经结束的任务。上文和各角色的 AI 会话都会接上，并回显上一个任务的结论。每个项目只保留最近一次会话，`/new` 会把它删掉。
- `/continue` 只是带着之前的记忆下达新任务，新任务照常从出计划开始。要让没做完的任务从停下的那一步接着做，用 `/resume`（见上文）。
- 会话变长后由各家工具自己压缩，Dario 不另设上限。想让它早点压缩，在 `~/.dario/agents.yaml` 里给对应的 AI 加参数：Claude Code 用 `extra_args: ["--autocompact", "200000"]`，Codex 用 `extra_args: ["-c", "model_auto_compact_token_limit=200000"]`。
- `/diff` 查看上一个任务改了什么。
- Esc 中断当前任务；Ctrl+C 连按两次退出。输入框里有内容时，这两个键先清空输入。
- Enter 提交，Shift+Enter 换行。长行自动折行，上下键在屏幕行之间移动，到第一行或最后一行再翻历史输入。粘贴不超过 8 行时直接插入光标处，可以继续编辑；超过 8 行显示为“[已粘贴 N 行]”，提交时放在正文前。全屏界面可以在输入框或它的边线上点右键粘贴。
- 全屏和行内输入框按 Alt+V 粘贴本机剪贴板里的图片，输入框显示 `[Image #N]`。一次任务最多带 10 张，提交后各角色的 AI 都会收到对应图片的路径。全屏右键在没有文字时也会尝试粘贴图片。图片保存在 `~/.dario/state/images/`，保留 7 天，在交互启动时清理。SSH 远程会话无法使用。
- PgUp / PgDn 或鼠标滚轮翻看会话记录。输入框为空时按 End 回到最新，提交输入也会回到最新。在历史区直接拖选，松开即复制。双击选词，三击选整段；按住 Shift 仍可使用终端自带的选择。复制结果在输入框上方靠右显示 3 秒。
- 退出全屏界面后，会话记录保留在普通屏幕上。

Shift+Enter 需要终端支持增强键盘协议，Dario 启动时会自动询问，支持才启用。运行 `dario input-test`，按下 Shift+Enter，看到“收到换行键：Shift+Enter”就表示能识别。终端分不出它时（会被当作普通回车直接提交），用 Ctrl+J 换行，或在行尾加反斜杠再按回车。

几个开关：

```
dario --inline                 # 使用行内界面，用终端滚动条回看历史
dario --plain                  # 不用完整界面，逐行交互
dario --plain --to 审核者 "…"    # 单次命令也不要动态进度
dario --to 审核者 "…" --verbose  # 纯文本输出时，逐行打印 AI 的每个动作
dario input-test               # 检查中文输入法和粘贴在你的终端里是否正常
```

环境变量 `DARIO_INLINE=1` 等同于始终带 `--inline`；终端不足 12 行也会使用行内界面。终端不足 40 列时使用逐行交互。`DARIO_PLAIN=1` 等同于始终带 `--plain`，`NO_COLOR=1` 关闭颜色。

## 配置

| 位置 | 文件 | 说明 |
|---|---|---|
| 项目的 `.dario/` | `roles.yaml` | 角色表，随仓库提交，团队共用 |
| | `dispatch-rules.md` | 主控按什么规则分派 |
| | `project.yaml` | `lead_implements` 默认 `true`，设为 `false` 可让主控把动手步骤全部分派出去；另可设置允许改动的目录、时限、返工轮数、小改动跳过自动审查的行数门槛（`review_skip_max_lines`，默认 0 即始终审查）、交接时附上的代码和 diff 的长度上限（`handoff_max_chars`，默认 20000 个字符，0 即不附）、开工前是否先拉取等 |
| 本机的 `~/.dario/` | `agents.yaml` | 各家 AI 的命令路径、默认及按角色的型号与强度、放行的工具、要加载的插件 |
| | `channels.yaml`、`access.yaml` | 渠道设置与名单 |
| | `state/` | 任务记录、审计日志 |

### 干活监控

AI 干活时，Dario 盯着它的输出，发现问题会在界面、纯文本输出和渠道里提示，并记进任务的注意事项和 JSON 输出的 `alerts`。规则在项目的 `project.yaml` 里设置，不写就用默认值：

```yaml
supervise:
  idle: { minutes: 10, command_minutes: 30, action: notify }   # 多久没有任何输出算没动静；正在执行命令时用 command_minutes
  out_of_roots: { action: notify }                              # 改了 write_roots 之外的文件
  forbidden_commands: { patterns: ["git push"], action: stop }  # 执行了清单里的命令，按词前缀匹配
  off_plan: { action: notify }                                  # 改了计划给这一步预计范围之外的文件，只能 off 或 notify
  loop: { action: off, repeat_command: 3, repeat_read: 5, requests_without_edit: 20 }  # 原地打转：反复做同一件事却没有改动
  usage: { action: off, factor: 3, min_samples: 5 }             # 用量超过本项目同类步骤历史中位数的 3 倍
```

`action` 可选 `off`（不检查）、`notify`（只提示）、`stop`（中断这一步，任务停下）和 `ask_lead`（交给主控判断）。设为 `ask_lead` 时，Dario 让主控看一下现场再决定：继续（这条规则静默一段时间）、纠偏（中断后接着原会话把主控的提醒发过去，同一步接着做，每一步最多 `max_interventions` 次，默认 2）或中止。没动静、路径越界、原地打转、用量异常可以用 `ask_lead`；主控自己的步骤没人替它判断，只提示。默认只提示不打断，禁用命令清单默认为空，原地打转和用量异常默认关闭。主控出计划时会给改文件的步骤写一个预计范围（`files`），确认计划时按 `d` 能看到；它是估计，所以"偏离计划"只提示。某家 AI 平时输出就稀疏、常被误报没动静时，在本机 `~/.dario/agents.yaml` 里给它写 `idle_factor: 2`，阈值对它放宽一倍。这只是发现问题的手段，不是安全边界：AI 写个脚本去执行的命令它查不出来。

项目配置按名字引用 AI，可以为角色建议型号和强度。命令与参数的拼法由插件和本机配置决定。所以克隆别人的仓库再运行 Dario，不会执行对方指定的程序。

### 各角色能用哪些工具

交给 Dario 的任务由各角色自己做完，中途不靠人，所以角色干活要用的工具都放行：

- 只读步骤（出计划、汇总、审查）：读取、搜索、几条只读的 git 命令，不加载 MCP。
- 可写步骤（包括主控自己执行和返工的小改动）：**全部放行**，不逐项审批。命令、文件、MCP 都能用，分寸由各家 AI 自己把握。实现上是各家自己的方式：Claude Code 与 CodeBuddy 用 `--permission-mode bypassPermissions`，Codex 用 `--dangerously-bypass-approvals-and-sandbox`。

这意味着可写角色在你的机器上不受 Dario 限制，接入飞书后群里下达的任务也是这个权限。想收紧，在 `~/.dario/agents.yaml` 里改：

```yaml
permissions: listed        # 对各家生效；full 是默认值
agents:
  codex:
    permissions: listed    # 或者只收紧某一家
```

`listed` 时可写角色只能用清单里的工具，没写清单就是读取、搜索、文件编辑和命令执行。清单这样写（写了就整个替换默认值）：

```yaml
agents:
  claude:
    allowed_tools:
      write: [Read, Grep, Glob, Edit, Write, "Bash(npm test:*)", "Bash(git diff:*)"]   # 只让它跑测试
```

`listed` 时 Codex 跑在它自己的 `workspace-write` 沙箱里，不用工具清单。

### 让 AI 能用 MCP 工具

权限为 `full`（默认）时可写角色的 MCP 工具都能用，不用另外配置，只需要像下面最后一行那样给 Codex 的只读方式关掉预先批准过的服务。权限为 `listed` 时要逐家放行，三家的写法不一样，都写在 `~/.dario/agents.yaml`：

```yaml
agents:
  claude:
    allowed_tools:      # 按服务放行写 mcp__<服务名>；只读方式不加载 MCP，这一行对它无效
      write: [Read, Grep, Glob, Edit, Write, NotebookEdit, mcp__UnityMCP]
  codebuddy:
    allowed_tools:      # CodeBuddy 的 MCP 调用走 DeferExecuteTool，要放行它
      write: [Read, Grep, Glob, Edit, Write, NotebookEdit, "DeferExecuteTool(mcp__unityMCP__*)"]
  codex:
    options:
      write_args: ["-c", 'mcp_servers.unityMCP.default_tools_approval_mode="approve"']   # 可写方式整服务放行
      read_only_args: ["-c", "mcp_servers.unityMCP.enabled=false"]                       # 只读方式关掉
```

`options` 里 `extra_args` 两种方式都追加，`write_args` 只给可写方式，`read_only_args` 只给只读方式。Codex 的只读沙箱不管 MCP：它自己配置里预先批准过的工具，只读角色也能调用，所以要像上面那样关掉。

### 开工前先拉取代码

项目规定动手前要先更新仓库的，在项目的 `.dario/project.yaml` 里写：

```yaml
sync_before_task: pull     # off（默认）、pull、pull-autostash
```

每个任务开始前 Dario 先 `git fetch`，本地落后时 `git pull --rebase`，结果在进度里说明。工作区有未提交的改动又落后于远端时：`pull` 不替你暂存，任务不开始并说明情况；`pull-autostash` 用 `--autostash` 自动暂存、拉取后放回。拉取出现冲突时任务不开始：本地提交与远端冲突会撤销这次拉取，放回暂存时冲突则把改动留在 `git stash` 里。连不上远端、当前分支没有远端分支时只提醒，在本地代码上继续。

### 做完后自动提交、推送

想让任务从头到尾不用人接手，在项目的 `.dario/project.yaml` 里打开收尾：

```yaml
finish:
  mode: push            # none（默认）、commit、push
  instructions: |       # 交给主控的收尾说明，按项目的提交规矩写
    按功能分组提交，提交信息用 feat/fix/chore 前缀。
    推送前运行 python tools/check.py，不通过就停下。
  max_rounds: 3
```

审查通过后，主控续接自己的会话做收尾：按收尾说明分组提交，`push` 时再与远端同步，落后就 rebase，有冲突自己解决。这一轮里它推送不出去。Dario 随后核对：提交的内容要和审过的一致，对不上（解冲突改了内容、多提交了别的文件）就把差别交给审核者复审；核对过了再由 Dario 推送到当前分支的远端分支，不强制推送，不跳过钩子。推送因为远端有了新提交被拒时，回到主控那里再同步一次，轮数到 `max_rounds` 为止。

- 计划确认时会写明结束后提交、推送到哪里，批准计划就是同意这一安排。
- 只提交本任务改过的文件；工作区里别的未提交改动不提交，也不丢弃。
- 开工时本地已经有没推送的提交，或者当前分支没有远端分支时，只提交、不推送。
- 收尾没做成时任务失败，改动和本地提交都留着，处理后用 `/resume` 或 `dario resume` 从收尾接着做。
- `instructions` 只是给主控看的文字，Dario 不执行里面的命令；要跑的检查由主控执行，结果写在它的回复里。

要 Dario 自己在推送前跑、不靠主控转述的检查，写在本机的 `~/.dario/projects.yaml`（不放进仓库，项目的 `.dario/` 里不能有这个文件）：

```yaml
projects:
  "D:/Projects/myrepo":
    pre_push:
      - command: [python, tools/check.py, --revision, HEAD]   # 不经过命令行解释器，参数逐个写
        timeout_minutes: 10
```

核对通过后、推送之前，Dario 在项目根目录里按先后运行这些命令，退出码都为 0 才推送；有一项不通过就不推送，结论里附上退出码和输出。

### 按角色设置型号和强度、停用某家

本机的 `~/.dario/agents.yaml` 可以给同一家 AI 设置默认值，再单独调整某个角色：

```yaml
agents:
  claude:
    model: sonnet
    effort: high
    roles:
      reviewer: { effort: medium }  # 审核者单独选强度，型号继续按优先级取值
  codebuddy:
    enabled: false
  deepseek:            # 内置：CodeBuddy 插件 + DeepSeek 模型
    model: deepseek-v4.1-flash
```

项目可以在 `.dario/roles.yaml` 为候选 AI 建议型号和强度：

```yaml
roles:
  reviewer:
    candidates: [claude, codex]
    access: read-only
    models:
      claude: { model: opus, effort: xhigh }
```

两个示例一起使用时，审核者调用 Claude 会使用项目建议的 `opus` 和本机设置的 `medium`。型号和强度各自按「本机角色设置 → 角色表建议 → 本机 AI 默认值 → 工具默认值」取值。运行步骤和刷新界面时直接使用配置。执行 `dario check` 会向工具重新查询型号，列出清单外的型号、不支持的强度和可选档位。型号自己的档位优先，空档位表示该型号不支持设置强度。配置里已有的清单外型号执行时仍原样使用；工具没返回清单时，强度按插件档位核对。已有的 `extra_args` 强度参数在没有配置强度时继续生效。

## 接入新的 AI

插件只描述"怎么调用、怎么读结果"，进程由 Dario 启动。在 `~/.dario/agents.yaml` 的 `plugins` 里列出后生效。

### 声明式：一份 YAML

`~/.dario/plugins/dsh.yaml`：

```yaml
id: dsh
display_name: DeepSeek Harness
command: dsh
args:
  read_only: [--profile, headless]
  write: [--profile, headless]
model_args: [--model, "{model}"]   # 配置了模型时才追加
prompt: arg                        # stdin（默认）或 arg（作为最后一个参数）
output: stdout                     # stdout（默认）或 file（工具把答复写到 {result_file}）
streams: false
env_pass: [DEEPSEEK_*]
progress: lines                    # 可选：把工具运行中输出的每一行显示在界面上
```

`~/.dario/agents.yaml`：

```yaml
plugins:
  - ./plugins/dsh.yaml
```

之后就可以在角色表的 `candidates` 里写 `dsh`。参数里可用的占位符：`{cwd}`、`{model}`、`{result_file}`。

### 代码式：一个 JS 模块

输出格式复杂时用。`~/.dario/plugins/mytool.mjs`：

```js
export default {
  apiVersion: 1,
  id: 'mytool',
  displayName: 'My Tool',
  defaultCommand: 'mytool',
  streams: true,                    // 启动后是否很快有输出
  resumes: true,                    // 可选：支持续接会话
  envPass: ['MYTOOL_*'],
  build(req) {
    // req: access, cwd, prompt, model, effort, allowedTools, resultFile, options, resume
    const args = ['run', '--json', req.access === 'write' ? '--allow-write' : '--read-only'];
    // 续接时 req.resume 是上一次 parse 给出的会话号；读写权限仍按这一次的 req.access 给
    if (req.resume) args.push('--resume', req.resume);
    return { args, stdin: req.prompt };
  },
  parse(raw) {
    // raw: exitCode, stdout, stderr, resultFileText, ...
    const last = raw.stdout.trim().split('\n').pop() ?? '{}';
    const data = JSON.parse(last);
    return { text: data.answer ?? '', isError: data.ok === false, sessionId: data.session };
  },
  // 可选：把运行中输出的一行翻译成界面上显示的活动。只用于显示，出错的行会被忽略。
  progress(line) {
    const event = JSON.parse(line);
    if (event.type === 'read') return [{ kind: 'read', target: event.path }];
    if (event.type === 'shell') return [{ kind: 'run', target: event.command }];
    if (event.type === 'message') return [{ kind: 'say', text: event.text }];
  },
};
```

活动的种类：`read`、`search`、`run`、`edit`、`tool`（这五种带 `target`）、`say`（带 `text`）、`think`。

想在界面上显示 token 用量，再实现一个可选的 `meter()`：每次运行调用一次，返回的函数逐行接收标准输出，用量有变化时返回 `{ input, cachedInput, output }`（到目前为止的累计值，`input` 含命中缓存的 `cachedInput`）。能拿到每次请求的用量时，可以再带上 `requests`（请求次数）和 `firstInput`（第一次请求的输入），`dario job` 的开销明细会用到。工具只报整个会话的累计值时加上 `sessionTotal: true`，续接时 Dario 会自己减去上一轮的数。

要显示额度，可实现 `quota()`。Dario 每次运行调用一次，返回的读取器可以提供 `onLine(line)` 逐行读取标准输出，也可以提供 `afterRun({ sessionId, env })` 在运行结束后读取会话记录，两者可同时提供。有数据时返回本次观测的全部窗口，每个窗口包含标识 `id`、已用百分数 `usedPercent`（如 75 表示 75%），以及可选的窗口长度 `windowMinutes`、重置时刻 `resetsAt` 和主窗口标记 `primary`。额度只用于显示。

声明了 `resumes: true` 的 AI，再次担当同一角色时会续接上一次的会话（比如执行者返工、审核者再审，以及交互界面里的后续任务），不必重新读一遍项目。内置的三家都支持；声明式插件不支持，每一步都新开会话。

接口的类型定义和辅助函数（`parseJsonLines`、`parseStreamJsonResult`、`streamJsonMeter`、`claudeQuotaReader`、`codexQuotaReader`、`looksUnavailable`、`looksSessionLost`）从 `dario/plugin` 导出。

## 接入飞书

1. 在飞书开放平台新建一个**专用的**企业自建应用，开启机器人能力。不要和别的机器人程序共用应用。
2. 权限：`im:message.group_at_msg:readonly`、`im:message:send_as_bot`；需要私聊再加 `im:message.p2p_msg:readonly`。
3. 事件订阅选择"使用长连接接收事件"，订阅 `im.message.receive_v1`。
4. 另外克隆一份仓库专门给 Dario 用，不要用日常开发的那份。这份克隆里要有 `.dario/` 配置。
5. 填写本机配置：

   `~/.dario/channels.yaml`

   ```yaml
   feishu:
     enabled: true
     project: D:/Projects/myrepo-dario     # 第 4 步的克隆
     forbidden_paths: [D:/Projects/myrepo] # 日常开发的目录，防止填错
     conversations: [oc_xxxxxxxx]          # 允许使用的群
   ```

   `~/.dario/access.yaml`

   ```yaml
   feishu:
     members: [ou_xxxxxxxx]
     admins: [ou_yyyyyyyy]
   ```

6. 把应用凭据放进环境变量 `DARIO_FEISHU_APP_ID` 和 `DARIO_FEISHU_APP_SECRET`，然后：

   ```
   dario check
   dario serve
   ```

在群里 @机器人 下达任务，用法与命令行的交互方式相同（`/to 执行者 ……`、`/roles`、`/status`）。计划要改文件时，在话题里回复"确认"或"取消"。

飞书来的任务在那份独立克隆里执行：每个任务一个本地分支 `dario/<任务号>`，Dario 把产出提交到这个分支，AI 在这份克隆里推送不出去。克隆里的项目开启了 `finish: { mode: push }` 时，审查通过后由主控分组提交，Dario 核对后推送到远端主干，见上面"做完后自动提交、推送"。没有开启时，要采纳产出，在你自己的仓库里把分支取过来：

```
git fetch D:/Projects/myrepo-dario dario/J0012
git cherry-pick FETCH_HEAD      # 或按你的习惯整理后再提交
```

## 排障

- **`dario check`**：先看它报什么。
- **某家 AI 一直被跳过**：`dario roles` 会显示"暂时不可用"。问题解决后运行 `dario health <AI>` 立即恢复，或等冷却时间过去。
- **想看 AI 实际收到了什么、输出了什么**：`~/.dario/state/jobs/<任务号>/` 里有每一步的任务说明、标准输出和标准错误。
- **想看 Dario 启动了什么命令**：`~/.dario/state/audit.log`。
- **MCP 服务断了（比如 Unity MCP）**：Dario 里没有"重连"这个操作，每一步都是新启动的进程，启动时会自动连接。角色发现必需的服务连不上，会先重试几次，仍然不行就停下，任务以失败结束并写明是哪个服务。把服务恢复后再下达一次任务（或输入"继续"）即可，各角色接着原来的会话做。
- **AI 说没有权限执行某条命令或调用某个工具**：见上面的"各角色能用哪些工具"和"让 AI 能用 MCP 工具"。
- **界面显示错乱、符号变成方框、输入法不正常**：先用 `dario --plain`（或 `DARIO_PLAIN=1`）照常干活；`dario input-test` 可以确认输入是否被正确接收。
- **全屏拖选后粘贴不到文字**：本机剪贴板命令可能不可用；SSH 会话或本机命令失败时使用 OSC 52，有些终端会忽略或禁止它。可以按住 Shift 拖选并用终端的复制快捷键，也可以用 `dario --inline`。
- **拖动窗口后留下一两行残影**：已知现象，不影响任务；清屏或继续使用即可。

## 开发

```
npm run typecheck
npm test          # 用假 AI，不消耗额度
npm run build
```

# Dario

按角色调用各家 AI 编码工具的命令行程序。

你维护一份角色表（主控、实现、审查……），写明每个角色由哪家 AI 担当；Dario 负责按角色启动本机已安装的 Claude Code、Codex、CodeBuddy 等工具，在某一家不可用时自动换下一家。也可以接上飞书，在群里下达任务。

设计约定见 [SPEC.md](SPEC.md)。

## 安装

需要 Node 22 及以上，以及至少一家已登录的 AI 命令行工具。

```
cd D:\Projects\Dario
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
dario --to 审查 "看一下 src/login.ts 有没有空指针问题"
dario --to 实现 "把 src/answer.ts 里的 41 改成 42"
dario "给登录接口加上次数限制"            # 交给主控：出计划、确认、执行、审查、汇总
dario                                      # 交互方式
```

主控给出的计划如果要改文件，会先停下来等你确认：

```
dario -p "给登录接口加上次数限制"          # 打印计划，退出码 4
dario approve J0007                        # 批准后执行
dario -p --yes "给登录接口加上次数限制"    # 或者直接免确认
```

换人：

```
dario roles                    # 看每个角色现在由谁担当
dario role 实现 claude         # 临时改由 Claude Code 担当，只在本机生效
dario role 实现 claude --save  # 写回项目的角色表
dario role 实现 --reset        # 恢复
```

给脚本或其他 AI 调用：

```
dario -p --to 审查 --output-format json "检查这次改动" < 任务说明.txt
```

退出码：0 完成 · 1 任务失败 · 2 用法或配置错误 · 3 没有可用的 AI · 4 计划等待确认 · 5 取消或超时。

## 配置

| 位置 | 文件 | 说明 |
|---|---|---|
| 项目的 `.dario/` | `roles.yaml` | 角色表，随仓库提交，团队共用 |
| | `dispatch-rules.md` | 主控按什么规则分派 |
| | `project.yaml` | 允许改动的目录、时限、返工轮数等 |
| 本机的 `~/.dario/` | `agents.yaml` | 各家 AI 的命令路径、模型、放行的工具、要加载的插件 |
| | `channels.yaml`、`access.yaml` | 渠道设置与名单 |
| | `state/` | 任务记录、审计日志 |

项目里的配置只能按名字引用 AI，不能写命令；命令只认本机配置。所以克隆别人的仓库再运行 Dario，不会执行对方指定的程序。

### 让 AI 能跑更多命令

默认只放行读取、搜索、几条只读的 git 命令和文件编辑。要让某家 AI 能跑测试，在 `~/.dario/agents.yaml` 里加：

```yaml
agents:
  claude:
    allowed_tools:
      write: [Read, Grep, Glob, Edit, Write, "Bash(npm test:*)", "Bash(git diff:*)"]
```

### 换模型、停用某家

```yaml
agents:
  claude:
    model: sonnet
  codebuddy:
    enabled: false
  deepseek:            # 内置：CodeBuddy 插件 + DeepSeek 模型
    model: deepseek-v4.1-flash
```

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
  envPass: ['MYTOOL_*'],
  build(req) {
    // req: access, cwd, prompt, model, allowedTools, resultFile, options
    const args = ['run', '--json', req.access === 'write' ? '--allow-write' : '--read-only'];
    return { args, stdin: req.prompt };
  },
  parse(raw) {
    // raw: exitCode, stdout, stderr, resultFileText, ...
    const last = raw.stdout.trim().split('\n').pop() ?? '{}';
    const data = JSON.parse(last);
    return { text: data.answer ?? '', isError: data.ok === false };
  },
};
```

接口的类型定义和辅助函数（`parseJsonLines`、`parseStreamJsonResult`、`looksUnavailable`）从 `dario/plugin` 导出。

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

在群里 @机器人 下达任务，用法与命令行的交互方式相同（`/to 实现 ……`、`/roles`、`/status`）。计划要改文件时，在话题里回复"确认"或"取消"。

飞书来的任务在那份独立克隆里执行：每个任务一个本地分支 `dario/<任务号>`，Dario 把产出提交到这个分支，这份克隆推送不出去。要采纳时，在你自己的仓库里把分支取过来：

```
git fetch D:/Projects/myrepo-dario dario/J0012
git cherry-pick FETCH_HEAD      # 或按你的习惯整理后再提交
```

## 排障

- **`dario check`**：先看它报什么。
- **某家 AI 一直被跳过**：`dario roles` 会显示"暂时不可用"。问题解决后运行 `dario health <AI>` 立即恢复，或等冷却时间过去。
- **想看 AI 实际收到了什么、输出了什么**：`~/.dario/state/jobs/<任务号>/` 里有每一步的任务说明、标准输出和标准错误。
- **想看 Dario 启动了什么命令**：`~/.dario/state/audit.log`。
- **AI 说没有权限执行某条命令**：见上面的"让 AI 能跑更多命令"。

## 开发

```
npm run typecheck
npm test          # 用假 AI，不消耗额度
npm run build
```

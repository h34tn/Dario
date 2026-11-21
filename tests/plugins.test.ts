import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { claudePlugin, codebuddyPlugin, codexPlugin } from '../src/agents/builtin.js';
import { classify } from '../src/agents/handle.js';
import { pluginFromManifest } from '../src/agents/manifest.js';
import { looksUnavailable, type InvokeRequest, type RawResult } from '../src/plugin.js';
import { Sandbox } from './helpers.js';

const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent', 'fake-agent.mjs');

const req = (over: Partial<InvokeRequest> = {}): InvokeRequest => ({
  access: 'read-only',
  cwd: 'D:/work',
  prompt: '任务说明',
  allowedTools: ['Read', 'Bash(git diff:*)'],
  resultFile: 'D:/jobs/out.txt',
  options: {},
  ...over,
});

const raw = (over: Partial<RawResult> = {}): RawResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, startupTimedOut: false, ...over });

// 下面两段取自本机实测的真实输出（已删去无关字段）
const CLAUDE_STDOUT = [
  '{"type":"system","subtype":"init","cwd":"D:\\\\work","session_id":"s1","model":"claude-x"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]},"session_id":"s1"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"s1"}',
  '{"duration_api_ms":1035,"stop_reason":"end_turn","session_id":"s1","total_cost_usd":0.2875,"usage":{"input_tokens":2,"output_tokens":4},"type":"result","subtype":"success","is_error":false,"result":"你好","num_turns":1}',
].join('\n');

const CODEX_STDOUT = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting."}}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"你好"}}',
  '{"type":"turn.completed","usage":{"input_tokens":23188,"output_tokens":5}}',
].join('\n');

describe('内置插件：命令行参数', () => {
  it('Claude Code 只读：dontAsk，不加载 MCP，放行清单内的工具，并明确禁止编辑类工具', () => {
    const inv = claudePlugin.build(req({ model: 'sonnet' }));
    expect(inv.stdin).toBe('任务说明');
    expect(inv.args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--model', 'sonnet',
      '--allowedTools', 'Read', 'Bash(git diff:*)',
      '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
    ]);
    expect(inv.args.join(' ')).not.toContain('任务说明');
  });

  it('可写且全部放行：三家都用各自不逐项审批的方式，不再带工具清单；只读不受影响', () => {
    for (const plugin of [claudePlugin, codebuddyPlugin]) {
      const full = plugin.build(req({ access: 'write', unrestricted: true, allowedTools: ['Edit'] })).args;
      expect(full[full.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      expect(full).not.toContain('--allowedTools');
      expect(full).not.toContain('--strict-mcp-config');
      // 只读角色即使收到这个标记也保持只读
      const ro = plugin.build(req({ unrestricted: true })).args;
      expect(ro[ro.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      expect(ro).toContain('--strict-mcp-config');
      expect(ro).toContain('--disallowedTools');
    }
    const codex = codexPlugin.build(req({ access: 'write', unrestricted: true })).args;
    expect(codex).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(codex).not.toContain('-s');
    expect(codexPlugin.build(req({ unrestricted: true })).args.join(' ')).toContain('-s read-only');
    // 按清单放行时仍是原来的方式
    expect(codexPlugin.build(req({ access: 'write' })).args.join(' ')).toContain('-s workspace-write');
  });

  it('默认放行的工具：只读是读取与只读的 git 命令，可写另有文件编辑和命令执行', () => {
    for (const plugin of [claudePlugin, codebuddyPlugin]) {
      const { readOnly, write } = plugin.defaultAllowedTools!;
      expect(readOnly).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash(git diff:*)']));
      for (const tool of ['Edit', 'Write', 'Bash', 'PowerShell']) expect(readOnly).not.toContain(tool);
      expect(write).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash', 'PowerShell']));
    }
  });

  it('本机配置的追加参数：extra_args 两种方式都加，write_args 与 read_only_args 各管一种', () => {
    const options = { extra_args: ['-c', 'a=1'], write_args: ['-c', 'w=1'], read_only_args: ['-c', 'r=1'] };
    const ro = codexPlugin.build(req({ options })).args.join(' ');
    const rw = codexPlugin.build(req({ access: 'write', options })).args.join(' ');
    expect(ro).toContain('-c a=1 -c r=1');
    expect(ro).not.toContain('w=1');
    expect(rw).toContain('-c a=1 -c w=1');
    expect(rw).not.toContain('r=1');
    expect(claudePlugin.build(req({ access: 'write', options })).args.join(' ')).toContain('-c a=1 -c w=1');
  });

  it('Claude Code 可写且按清单放行：acceptEdits，不使用跳过全部权限的参数', () => {
    const inv = claudePlugin.build(req({ access: 'write', allowedTools: ['Edit'] }));
    expect(inv.args).toContain('acceptEdits');
    expect(inv.args).not.toContain('--disallowedTools');
    // 可写角色照常使用 MCP 工具
    expect(inv.args).not.toContain('--strict-mcp-config');
    expect(inv.args.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
  });

  it('CodeBuddy 与 Claude Code 参数形式相同', () => {
    expect(codebuddyPlugin.build(req()).args).toEqual(claudePlugin.build(req()).args);
    expect(codebuddyPlugin.build(req({ access: 'write' })).args.join(' ')).not.toMatch(/dangerously|-y\b/);
  });

  it('Codex：按权限选择沙箱方式，任务说明走标准输入', () => {
    const ro = codexPlugin.build(req({ model: 'gpt-x' }));
    expect(ro.args).toEqual(['exec', '-C', 'D:/work', '-s', 'read-only', '--skip-git-repo-check', '--color', 'never', '--json', '-o', 'D:/jobs/out.txt', '-m', 'gpt-x', '-']);
    expect(ro.stdin).toBe('任务说明');
    expect(codexPlugin.build(req({ access: 'write' })).args).toContain('workspace-write');
  });

  it('options.extra_args 追加到参数里', () => {
    expect(claudePlugin.build(req({ options: { extra_args: ['--max-turns', 5] } })).args).toContain('--max-turns');
    expect(codexPlugin.build(req({ options: { extra_args: ['--ephemeral'] } })).args.at(-1)).toBe('-');
  });
});

describe('内置插件：解析真实输出', () => {
  it('Claude Code 的 stream-json：取 result 记录', () => {
    const out = claudePlugin.parse(raw({ stdout: CLAUDE_STDOUT }));
    expect(out).toMatchObject({ text: '你好', isError: false, costUsd: 0.2875 });
  });

  it('Claude Code 续接会话时费用只算这一次运行的，不取会话累计值', () => {
    // 取自本机实测（Claude Code 2.1.330）：同一个会话的第一次运行和续接后的一次运行，已删去无关字段
    const first =
      '{"type":"result","subtype":"success","is_error":false,"result":"计划","session_id":"s1","total_cost_usd":0.3823668,' +
      '"modelUsage":{"claude-fable-5-2":{"costUSD":0.3823668}},"model_usage_since_last_result":{"claude-fable-5-2":{"costUSD":0.3823668}}}';
    const resumed =
      '{"type":"result","subtype":"success","is_error":false,"result":"汇总","session_id":"s1","total_cost_usd":0.47694800000000004,' +
      '"modelUsage":{"claude-fable-5-2":{"costUSD":0.47694800000000004}},"model_usage_since_last_result":{"claude-fable-5-2":{"costUSD":0.0945812}}}';
    expect(claudePlugin.parse(raw({ stdout: first })).costUsd).toBe(0.3823668);
    expect(claudePlugin.parse(raw({ stdout: resumed })).costUsd).toBe(0.0945812);
    // 用到多个模型时相加；这一次运行没有产生用量时记 0，不退回累计值
    const two = '{"type":"result","subtype":"success","result":"好","total_cost_usd":9,"model_usage_since_last_result":{"a":{"costUSD":0.25},"b":{"costUSD":0.5}}}';
    expect(claudePlugin.parse(raw({ stdout: two })).costUsd).toBe(0.75);
    const none = '{"type":"result","subtype":"success","result":"好","total_cost_usd":9,"model_usage_since_last_result":{}}';
    expect(claudePlugin.parse(raw({ stdout: none })).costUsd).toBe(0);
  });

  it('Codex 的 JSONL：取最终答复，配置警告不算失败', () => {
    expect(codexPlugin.parse(raw({ stdout: CODEX_STDOUT, resultFileText: '你好\n' }))).toMatchObject({ text: '你好' });
    expect(codexPlugin.parse(raw({ stdout: CODEX_STDOUT })).text).toBe('你好');
    expect(codexPlugin.parse(raw({ stdout: CODEX_STDOUT })).isError).toBeUndefined();
  });

  it('Codex 回合失败时带出报错文字', () => {
    const failed = '{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":"You have hit your usage limit."}}';
    const out = codexPlugin.parse(raw({ stdout: failed, exitCode: 1 }));
    expect(out.isError).toBe(true);
    expect(out.text).toContain('usage limit');
  });
});

describe('失败分类', () => {
  it('正常输出里的 rate_limit_event 不会被误判为不可用', () => {
    expect(classify(claudePlugin, raw({ stdout: CLAUDE_STDOUT })).result).toEqual({ outcome: 'ok' });
  });

  it('登录失效、额度、过载、网络问题判为不可用', () => {
    const loginExpired = '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}';
    expect(classify(claudePlugin, raw({ stdout: loginExpired, exitCode: 1 })).result.outcome).toBe('unavailable');
    for (const stderr of ['Error: 429 Too Many Requests', 'overloaded_error', 'getaddrinfo ENOTFOUND api.example.com', '额度已用尽', "You've hit your usage limit"]) {
      expect(classify(codexPlugin, raw({ exitCode: 1, stderr })).result.outcome, stderr).toBe('unavailable');
    }
  });

  it('普通报错判为任务失败', () => {
    const r = classify(codexPlugin, raw({ exitCode: 1, stderr: 'error: the model could not complete the task' }));
    expect(r.result.outcome).toBe('task_failed');
    expect(classify(claudePlugin, raw({ stdout: '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"reached max turns"}' })).result.outcome).toBe('task_failed');
  });

  it('命令起不来、启动后无输出判为不可用；超时单独一类', () => {
    expect(classify(claudePlugin, raw({ exitCode: null, spawnError: '找不到命令：claude' })).result.outcome).toBe('unavailable');
    expect(classify(claudePlugin, raw({ exitCode: null, startupTimedOut: true })).result.outcome).toBe('unavailable');
    expect(classify(claudePlugin, raw({ exitCode: null, timedOut: true })).result.outcome).toBe('timeout');
  });

  it('退出码为 0 但没有答复，算任务失败', () => {
    expect(classify(codexPlugin, raw({ stdout: '{"type":"turn.started"}' })).result.outcome).toBe('task_failed');
  });

  it('各种说法的限额提示都判为不可用，带 limit 字样的普通报错不算', () => {
    for (const text of [
      "You've hit your usage limit. Upgrade to Pro or try again in 3 hours.",
      "You've hit your limit · resets 6pm (Asia/Shanghai)",
      "You've hit your session limit · resets 3pm",
      "You've hit your weekly limit · resets Mon 9am",
      'Claude usage limit reached. Your limit will reset at 3pm.',
      '5-hour limit reached ∙ resets 3pm',
      'Weekly limit reached ∙ resets Nov 24',
      'You have reached your daily message limit',
      'Limit reached · resets 11pm',
      '今日额度已用完',
      '已达到使用上限，请稍后再试',
      '本周用量已达上限',
      '请求过于频繁，请稍后重试',
    ]) {
      expect(looksUnavailable(text), text).toBe(true);
      expect(classify(codexPlugin, raw({ exitCode: 1, stderr: text })).result.outcome, text).toBe('unavailable');
    }
    for (const text of [
      'reached max turns',
      'The file exceeds the size limit of 256KB',
      'Request exceeded the maximum size limit',
      'limit: 10 items per page',
      'Maximum call stack size exceeded',
      '把重试次数的上限改成 3',
      'const limit = resetCounter(limit)',
    ]) {
      expect(looksUnavailable(text), text).toBe(false);
    }
  });

  it('looksUnavailable 不把普通文字当成不可用', () => {
    expect(looksUnavailable('函数 getQuotaForUser 返回了错误的类型')).toBe(false);
    expect(looksUnavailable('    at parse (src/billing/file.ts:429:11)')).toBe(false);
    expect(looksUnavailable('TypeError: x is not a function')).toBe(false);
    expect(looksUnavailable('测试失败：期望 3 实际 4')).toBe(false);
    for (const text of ['insufficient_quota', 'You exceeded your current quota', 'HTTP 503', 'status code: 429', 'API Error: 529 overloaded']) {
      expect(looksUnavailable(text), text).toBe(true);
    }
  });
});

describe('声明式插件', () => {
  it('支持占位符、模型参数、从文件取结果、把任务说明作为参数', () => {
    const plugin = pluginFromManifest(
      stringify({
        id: 'mytool',
        command: 'mytool',
        args: { read_only: ['run', '--ro', '--cwd', '{cwd}'], write: ['run', '--out', '{result_file}'] },
        model_args: ['--model', '{model}'],
        prompt: 'arg',
        output: 'file',
        unavailable_patterns: ['license expired'],
      }),
      'mytool.yaml',
    );
    expect(plugin.build(req()).args).toEqual(['run', '--ro', '--cwd', 'D:/work', '任务说明']);
    expect(plugin.build(req({ access: 'write', model: 'm1' })).args).toEqual(['run', '--out', 'D:/jobs/out.txt', '--model', 'm1', '任务说明']);
    expect(plugin.build(req()).stdin).toBeUndefined();
    expect(plugin.parse(raw({ stdout: '忽略', resultFileText: ' 文件里的答复 \n' })).text).toBe('文件里的答复');
    expect(classify(plugin, raw({ exitCode: 1, stderr: 'License Expired' })).result.outcome).toBe('unavailable');
    expect(classify(plugin, raw({ exitCode: 1, stderr: 'boom' })).result.outcome).toBe('task_failed');
  });

  it('清单有误时说明哪里不对', () => {
    expect(() => pluginFromManifest('id: Bad Id\ncommand: x\nargs: { read_only: [], write: [] }\n', 'bad.yaml')).toThrow(/bad\.yaml[\s\S]*id/);
    expect(() => pluginFromManifest('id: ok\ncommand: x\n', 'bad.yaml')).toThrow(/args/);
    expect(() => pluginFromManifest('id: ok\ncommand: x\nargs: { read_only: [], write: [] }\nshell: true\n', 'bad.yaml')).toThrow();
  });
});

describe('插件加载', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  const useAgents = (data: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(sb.home, 'agents.yaml'), stringify({ startup_timeout_seconds: 2, ...data }));
  };

  it('代码插件（.mjs）可以加载并被角色使用', async () => {
    sb = new Sandbox();
    fs.writeFileSync(
      path.join(sb.home, 'plugins', 'upper.mjs'),
      `export default {
        apiVersion: 1,
        id: 'upper',
        displayName: '大写器',
        defaultCommand: ${JSON.stringify(process.execPath)},
        versionArgs: ['--version'],
        streams: false,
        build: (req) => ({ args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("RESULT:"+d.length))'], stdin: req.prompt }),
        parse: (raw) => ({ text: raw.stdout.replace('RESULT:', '收到的字数：') }),
      };`,
    );
    useAgents({ plugins: ['./plugins/upper.mjs'] });
    sb.writeRoles('roles:\n  coder:\n    candidates: [upper]\n    access: write\n');
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps[0].agent).toBe('upper');
    expect(r.json.conclusion).toMatch(/^收到的字数：\d+$/);
  });

  it('接口版本不对、缺少函数、标识与内置插件重复时拒绝加载', async () => {
    sb = new Sandbox();
    fs.writeFileSync(path.join(sb.home, 'plugins', 'old.mjs'), `export default { apiVersion: 99, id: 'old', defaultCommand: 'x', streams: false, build() {}, parse() {} };`);
    useAgents({ plugins: ['./plugins/old.mjs'] });
    const bad = await sb.cli(['roles']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('apiVersion');

    fs.writeFileSync(path.join(sb.home, 'plugins', 'dup.yaml'), stringify({ id: 'claude', command: 'x', args: { read_only: [], write: [] } }));
    useAgents({ plugins: ['./plugins/dup.yaml'] });
    const dup = await sb.cli(['roles']);
    expect(dup.code).toBe(2);
    expect(dup.err).toContain('插件标识重复');

    useAgents({ plugins: ['./plugins/missing.yaml'] });
    expect((await sb.cli(['roles'])).err).toContain('找不到插件文件');
  });

  it('一个插件可以配出多个 AI，各自带模型', async () => {
    sb = new Sandbox();
    fs.writeFileSync(
      path.join(sb.home, 'plugins', 'base.yaml'),
      stringify({
        id: 'base',
        command: process.execPath,
        version_args: [FAKE_AGENT, '--version'],
        args: {
          read_only: [FAKE_AGENT, '--name', 'base', '--scenario', sb.scenarioFile],
          write: [FAKE_AGENT, '--name', 'base', '--scenario', sb.scenarioFile],
        },
        model_args: ['--model', '{model}'],
      }),
    );
    useAgents({ plugins: ['./plugins/base.yaml'], agents: { fast: { plugin: 'base', model: 'flash' }, smart: { plugin: 'base', model: 'pro' } } });
    sb.writeRoles('roles:\n  coder:\n    candidates: [fast]\n    access: write\n  reviewer:\n    candidates: [smart]\n    access: read-only\n');
    sb.setScenario({ base: [{ text: 'ok' }] });
    await sb.cli(['--to', 'coder', '任务']);
    await sb.cli(['--to', 'reviewer', '任务']);
    const models = sb.calls().map((c) => c.argv[c.argv.indexOf('--model') + 1]);
    expect(models).toEqual(['flash', 'pro']);
  });

  it('agents.yaml 引用不存在的插件时报错', async () => {
    sb = new Sandbox();
    useAgents({ agents: { ghost: { plugin: 'nope' } } });
    const r = await sb.cli(['roles']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('不存在的插件 nope');
  });

  it('可以在本机配置里停用某个 AI，角色会跳到下一家', async () => {
    sb = new Sandbox();
    useAgents({ plugins: sb.agents.map((n) => `./plugins/${n}.yaml`), agents: { a2: { enabled: false } } });
    sb.setScenario({ a3: [{ text: 'a3 完成' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.json.steps[0].agent).toBe('a3');
    expect((await sb.cli(['roles'])).out).toContain('a2[已停用]');
  });

  it.runIf(process.platform === 'win32')('通过 .cmd 脚本启动时，带特殊字符的参数原样送达', async () => {
    sb = new Sandbox();
    const shim = path.join(sb.dir, 'fake tool.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FAKE_AGENT}" %*\r\n`);
    const tricky = ['Bash(git status:*)', 'a b', 'x&y', 'p|q', '50%', 'say "hi"', '^caret', 'semi;colon'];
    fs.writeFileSync(
      path.join(sb.home, 'plugins', 'a2.yaml'),
      stringify({
        id: 'a2',
        command: shim,
        version_args: ['--name', 'a2', '--version'],
        args: {
          read_only: ['--name', 'a2', '--scenario', sb.scenarioFile],
          write: ['--name', 'a2', '--scenario', sb.scenarioFile, '--allowedTools', ...tricky],
        },
      }),
    );
    sb.setScenario({ a2: [{ echoPrompt: true }] });
    const task = '带 "引号" 和 & 的任务\n第二行';
    const r = await sb.runJson(['--to', 'coder', task]);
    expect(r.code).toBe(0);
    const call = sb.calls()[0]!;
    expect(call.argv.slice(call.argv.indexOf('--allowedTools') + 1)).toEqual(tricky);
    expect(call.prompt).toContain(task);
  });
});

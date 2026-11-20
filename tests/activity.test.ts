import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentHandle } from '../src/agents/handle.js';
import { pluginFromManifest } from '../src/agents/manifest.js';
import { runProcess } from '../src/agents/spawn.js';
import { createApp } from '../src/compose.js';
import { formatActivity } from '../src/core/report.js';
import type { ProgressEvent } from '../src/core/types.js';
import { codexActivities, streamJsonActivities, type Activity } from '../src/plugin.js';
import { Sandbox, type SandboxOptions } from './helpers.js';

function fixture(name: string): string[] {
  return fs.readFileSync(new URL(`./fixtures/stream-${name}.jsonl`, import.meta.url), 'utf8').trimEnd().split(/\r?\n/);
}

const boxes: Sandbox[] = [];
const powershell = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"`;
it.each([
  [powershell + ' -Command "Get-Content -LiteralPath \'src/notes.txt\'"', "Get-Content -LiteralPath 'src/notes.txt'"],
  [powershell + " -Command 'Get-ChildItem -LiteralPath src -File -Name'", 'Get-ChildItem -LiteralPath src -File -Name'],
  ['pwsh -NoProfile -NonInteractive -Command "echo ok"', 'echo ok'],
  ['bash -lc "ls -la"', 'ls -la'],
  ["sh -c 'pwd'", 'pwd'],
  ['cmd.exe /d /s /c "dir"', 'dir'],
  ['cmd /c "dir"', 'dir'],
  ['git status', 'git status'],
  ['bash -lc "echo \\"ok\\""', 'echo \\"ok\\"'],
])('执行活动只显示已知外壳的内层命令 %s', (command, target) => {
  const item = { type: 'command_execution', command };
  expect(codexActivities(JSON.stringify({ type: 'item.started', item }))).toEqual([{ kind: 'run', target }]);
});

function sandbox(options?: SandboxOptions): Sandbox {
  const box = new Sandbox(options);
  boxes.push(box);
  return box;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const box of boxes.splice(0)) box.cleanup();
});

it('从 Claude 样本只提取助手活动，保留每次搜索和读取', () => {
  const lines = fixture('claude');
  for (const line of lines.filter((s) => JSON.parse(s).type !== 'assistant')) expect(streamJsonActivities(line)).toEqual([]);
  const acts = lines.flatMap(streamJsonActivities);
  expect(acts).toHaveLength(14);
  expect(acts.filter(a => a.kind === 'search')).toEqual(Array(6).fill({ kind: 'search', target: 'DailyDungeon|daily_dungeon' }));
  expect(acts.filter(a => a.kind === 'read').map(a => a.target)).toEqual([expect.stringMatching(/file1\.lua$/), expect.stringMatching(/file2\.lua$/)]);
  expect(acts.filter(a => a.kind === 'think')).toHaveLength(5);
  expect(acts.filter(a => a.kind === 'say')).toHaveLength(1);
});

it('从 CodeBuddy 样本提取读写、命令、思考和文字', () => {
  const acts = fixture('codebuddy').flatMap(streamJsonActivities);
  expect(acts).toHaveLength(11);
  expect(acts.filter(a => a.kind === 'read')).toHaveLength(2);
  expect(acts.filter(a => a.kind === 'run')).toEqual([{ kind: 'run', target: 'ls -la' }]);
  expect(acts.filter(a => a.kind === 'edit')).toEqual([{ kind: 'edit', target: expect.stringMatching(/notes\.txt$/) }]);
  expect(acts.filter(a => a.kind === 'think')).toHaveLength(4);
  expect(acts.filter(a => a.kind === 'say')).toHaveLength(3);
});

it('从 Codex 样本提取活动，跳过错误项和工具的完成通知', () => {
  const lines = fixture('codex');
  const ignored = lines.filter(line => {
    const { type, item } = JSON.parse(line);
    return type === 'item.completed' && ['error', 'file_change', 'mcp_tool_call'].includes(item.type);
  });
  expect(ignored).toHaveLength(6);
  for (const line of ignored) expect(codexActivities(line)).toEqual([]);
  const acts = lines.flatMap(codexActivities);
  expect(acts).toHaveLength(6);
  expect(acts.filter(a => a.kind === 'tool')).toEqual(Array(3).fill({ kind: 'tool', target: 'node_repl.js' }));
  expect(acts.filter(a => a.kind === 'edit')).toEqual([{ kind: 'edit', target: expect.stringMatching(/notes\.txt$/) }]);
  expect(acts.filter(a => a.kind === 'say')).toHaveLength(2);
});

it('忽略损坏或缺字段的记录', () => {
  for (const parse of [streamJsonActivities, codexActivities]) {
    for (const line of ['', '坏数据', 'null', '{}', '{"type":"assistant","message":{"content":{}}}', '{"type":"item.started"}']) {
      expect(parse(line)).toEqual([]);
    }
  }
});

it('补全样本未用到的工具、缺少参数的工具及推理映射', () => {
  const content = [
    { name: 'Glob', input: { pattern: '*.ts' } }, { name: 'PowerShell', input: { command: 'ls' } },
    { name: 'NotebookEdit', input: { notebook_path: 'a.ipynb' } }, { name: 'Write' }, { name: 'WebFetch' },
  ].map(block => ({ type: 'tool_use', ...block }));
  const acts = streamJsonActivities(JSON.stringify({ type: 'assistant', message: { content } }));
  expect(acts.map(formatActivity)).toEqual(['搜 *.ts', '执行 ls', '改 a.ipynb', '工具 Write', '工具 WebFetch']);
  for (const type of ['item.started', 'item.completed']) {
    expect(codexActivities(JSON.stringify({ type, item: { type: 'reasoning' } })).map(formatActivity)).toEqual(['思考中']);
  }
  const item = { type: 'command_execution', command: 'ls' };
  expect(codexActivities(JSON.stringify({ type: 'item.started', item }))).toEqual([{ kind: 'run', target: 'ls' }]);
  expect(codexActivities(JSON.stringify({ type: 'item.completed', item }))).toEqual([]);
  expect(formatActivity({ kind: 'read', target: 'a' })).toBe('读 a');
});

it('逐行回调拼接跨块内容、去掉回车并补发末行，回调失败仍保留原始输出', async () => {
  const lines: string[] = [];
  const result = await runProcess({
    command: process.execPath, args: ['-e', "process.stdout.write('前'); setTimeout(() => process.stdout.write('后\\r\\n\\n末行'), 100)"],
    cwd: process.cwd(), env: {}, timeoutMs: 5000,
    onStdoutLine(line) {
      lines.push(line);
      throw new Error('显示失败');
    },
  });
  expect(lines).toEqual(['前后', '', '末行']);
  expect(result).toMatchObject({ stdout: '前后\r\n\n末行', exitCode: 0 });
});

const manifest = JSON.stringify({ id: 'demo', command: process.execPath, args: { read_only: [], write: [] } });
it('清单只接受逐行活动选项，未配置时没有方法', () => {
  expect(pluginFromManifest(manifest, 'demo.yaml')).not.toHaveProperty('progress');
  const make = (progress: string) => pluginFromManifest(JSON.stringify({ ...JSON.parse(manifest), progress }), 'demo.yaml');
  expect(() => make('json')).toThrow(/demo\.yaml/);
  expect(make('lines').progress?.('  你好  ')).toEqual([{ kind: 'say', text: '你好' }]);
  expect(make('lines').progress?.('   ')).toBeUndefined();
});

it('句柄压缩活动内容、转换项目内路径、丢弃空活动，并隔离插件异常', async () => {
  const box = sandbox();
  const outside = box.project + '-other' + path.sep + 'b.ts';
  const long = '字'.repeat(201);
  const plugin = pluginFromManifest(manifest, 'demo.yaml');
  plugin.build = () => ({ args: ['-e', "console.log('坏行'); console.log('好行')"] });
  plugin.progress = line => {
    if (line === '坏行') throw new Error('坏行');
    const root = process.platform === 'win32' ? box.project.toUpperCase() : box.project;
    return [
      { kind: 'read', target: path.join(root, 'src', 'a.ts') }, { kind: 'edit', target: outside },
      { kind: 'say', text: '\n \r\n  第一\t  行\n第二行' }, { kind: 'run', target: ' a\n b ' },
      { kind: 'search', target: long }, { kind: 'say', text: long }, { kind: 'say', text: '\n' }, { kind: 'tool', target: '  ' },
    ];
  };
  const handle = new AgentHandle('demo', plugin, {}, { envPass: [], env: process.env, startupTimeoutSeconds: 2 });
  const acts: Activity[] = [];
  const result = await handle.run({
    access: 'read-only', cwd: box.project, workDir: box.dir, label: '测试', prompt: '', timeoutMs: 5000,
    onActivity: a => acts.push(a),
  });
  expect(result.outcome).toBe('ok');
  expect(acts.map(formatActivity)).toEqual(['读 src/a.ts', '改 ' + outside.replaceAll('\\', '/'), '第一 行', '执行 a b', '搜 ' + long.slice(1) + '…', long.slice(1) + '…']);
});

const origin = { channel: 'terminal', senderId: 'tester' };
it('三条活动随进程输出依次到达，并携带当前步骤', async () => {
  const box = sandbox({ progressLines: true });
  const lines = ['开始', '读取', '完成'];
  box.setScenario({ a1: [{ stream: lines.map(line => ({ line, delayMs: 300 })) }] });
  const { engine } = await createApp({ cwd: box.project, env: box.env() });
  const events: Array<{ event: ProgressEvent; time: number }> = [];
  engine.onProgress(event => events.push({ event, time: performance.now() }));
  const job = await engine.submit({ task: '测试', role: 'lead', origin });
  expect(job.status).toBe('done');
  const activities = events.filter(({ event }) => event.kind === 'activity');
  expect(activities.map(({ event }) => event.text)).toEqual(lines);
  for (const { event } of activities) {
    expect(event).toMatchObject({ jobId: job.id, step: { index: 0, agent: 'a1', role: 'lead' }, activity: { kind: 'say', text: event.text } });
  }
  expect(events.find(({ event }) => event.kind === 'step_end')!.time - activities[0]!.time).toBeGreaterThanOrEqual(400);
});

it('纯文本详细方式只在标准错误追加五空格缩进的活动行', async () => {
  // 固定计时时钟，使两次任务报告里的步骤耗时可以逐字比较。
  vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  async function run(progressLines: boolean, flags: string[] = []) {
    const box = sandbox({ progressLines });
    box.setScenario({ a1: [{ stream: [{ line: '正在读取' }], text: '完成' }] });
    return box.cli(['--to', 'lead', '测试', ...flags]);
  }
  const baseline = await run(false);
  const plain = await run(true);
  const verbose = await run(true, ['--verbose']);
  expect(plain.code).toBe(0);
  expect(plain).toEqual(baseline);
  expect(plain.err).not.toContain('正在读取');
  const lines = verbose.err.split('\n');
  expect(lines.filter(line => line.startsWith('[J0001]     '))).toEqual(['[J0001]     正在读取', '[J0001]     完成']);
  expect(lines.filter(line => !line.startsWith('[J0001]     ')).join('\n')).toBe(plain.err);
  expect(verbose.out).toBe(plain.out);
});

it('候选不可用时，步骤开始、换人及步骤结束事件携带结构化信息', async () => {
  const box = sandbox();
  box.setScenario({ a2: [{ exit: 1, stderr: 'rate limit' }], a3: [{ text: '接手完成' }] });
  const { engine } = await createApp({ cwd: box.project, env: box.env() });
  const events: ProgressEvent[] = [];
  engine.onProgress(e => events.push(e));
  const step = { index: 0, kind: 'step', role: 'coder', roleLabel: engine.roles.label('coder') };
  const job = await engine.submit({ task: '测试', role: 'coder', origin });
  expect(events.find(e => e.kind === 'step_start')?.step).toEqual({ ...step, agent: 'a2' });
  expect(events.find(e => e.fallback)?.fallback).toEqual({ from: 'a2', to: 'a3', reason: 'rate limit' });
  expect(events.find(e => e.kind === 'step_end')?.step).toEqual({ ...step, agent: 'a3', outcome: 'ok', durationMs: job.steps[0]!.durationMs });
});

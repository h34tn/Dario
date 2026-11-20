#!/usr/bin/env node
/**
 * 测试用的假 AI：按剧本文件里预设的内容回应，不调用任何模型。
 *
 *   node fake-agent.mjs --name a1 --scenario <剧本.json> --access write [其余参数原样记录]
 *
 * 剧本：{ "<name>": [ <回应>, ... ] }，同一个名字每被调用一次取下一条，用完后重复最后一条。
 * 回应的字段：
 *   text        输出到标准输出的答复
 *   stream      [{ line, delayMs? }]，写完文件后依次等待并输出各行，缺省等待 0 毫秒
 *   exit        退出码，默认 0
 *   stderr      输出到标准错误的内容
 *   delayMs     回应前等待
 *   hang        不退出，直到被终止
 *   silent      不输出任何内容（配合 hang 测试"启动后无输出"）
 *   files       [{ path, content }]，相对当前目录写文件；content 为 null 表示删除
 *   spawnChild  启动一个长时间存活的子进程，并把它的进程号写到 <剧本>.child.pid
 *   echoPrompt  把收到的任务说明原样作为答复
 * 每次调用会在 <剧本>.log.jsonl 里追加一行记录：名字、权限、参数、收到的任务说明、环境变量名。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = opt('--name') ?? 'agent';
const scenarioFile = opt('--scenario');
const access = opt('--access') ?? '';

if (argv.includes('--version')) {
  process.stdout.write(`fake-agent 1.0 (${name})\n`);
  process.exit(0);
}

const readStdin = () =>
  new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });

const prompt = await readStdin();
const scenario = scenarioFile && fs.existsSync(scenarioFile) ? JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) : {};
const list = scenario[name] ?? [{ text: `${name} 的默认答复` }];

const countFile = `${scenarioFile}.count.json`;
let counts = {};
try {
  counts = JSON.parse(fs.readFileSync(countFile, 'utf8'));
} catch {
  // 第一次调用
}
const n = counts[name] ?? 0;
counts[name] = n + 1;
if (scenarioFile) fs.writeFileSync(countFile, JSON.stringify(counts));
const response = list[Math.min(n, list.length - 1)];

if (scenarioFile) {
  fs.appendFileSync(
    `${scenarioFile}.log.jsonl`,
    `${JSON.stringify({ name, access, call: n, argv, prompt, cwd: process.cwd(), envNames: Object.keys(process.env), depth: process.env.DARIO_DEPTH })}\n`,
  );
}

if (response.spawnChild) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  fs.writeFileSync(`${scenarioFile}.child.pid`, String(child.pid));
}
for (const f of response.files ?? []) {
  const target = path.resolve(process.cwd(), f.path);
  if (f.content === null) fs.rmSync(target, { force: true });
  else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
}
if (response.delayMs) await new Promise((r) => setTimeout(r, response.delayMs));
if (!response.silent) {
  for (const { line, delayMs } of response.stream ?? []) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    process.stdout.write(line + '\n');
  }
}
if (response.hang) {
  if (!response.silent) process.stdout.write('开始工作…\n');
  await new Promise(() => setInterval(() => {}, 1000));
}
if (response.stderr) process.stderr.write(response.stderr);
if (!response.silent) process.stdout.write(response.echoPrompt ? prompt : (response.text ?? ''));
process.exitCode = response.exit ?? 0;

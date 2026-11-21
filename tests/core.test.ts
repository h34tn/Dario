import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAlive, Sandbox } from './helpers.js';
import { createApp } from '../src/compose.js';

let sb: Sandbox;
afterEach(() => sb?.cleanup());

describe('角色表', () => {
  beforeEach(() => {
    sb = new Sandbox();
  });

  it('担当者取候选里第一个，可以用别名指定角色', async () => {
    sb.setScenario({ a2: [{ text: '做完了' }] });
    const r = await sb.runJson(['--to', '实现', '写点东西']);
    expect(r.code).toBe(0);
    expect(r.json.steps[0]).toMatchObject({ role: 'coder', agent: 'a2', outcome: 'ok' });
    expect(r.json.conclusion).toBe('做完了');
  });

  it('临时指定担当者后立即生效，重新启动后仍然生效，可以取消', async () => {
    sb.setScenario({ a2: [{ text: '我是 a2' }], a3: [{ text: '我是 a3' }] });
    const set = await sb.cli(['role', 'coder', 'a3']);
    expect(set.code).toBe(0);
    expect(set.out).toContain('临时改由 a3');
    // 每次 cli 调用都重新加载全部配置与状态，相当于重启
    expect((await sb.runJson(['--to', 'coder', '任务'])).json.steps[0].agent).toBe('a3');
    const roles = await sb.cli(['roles']);
    expect(roles.out).toContain('已临时指定 a3');
    // 临时指定不改项目文件
    expect(fs.readFileSync(path.join(sb.project, '.dario', 'roles.yaml'), 'utf8')).toContain('candidates: [a2, a3]');

    expect((await sb.cli(['role', 'coder', '--reset'])).code).toBe(0);
    expect((await sb.runJson(['--to', 'coder', '任务'])).json.steps[0].agent).toBe('a2');
  });

  it('--save 写回项目角色表并保留注释', async () => {
    sb.writeRoles(`# 这是注释\nroles:\n  coder:\n    candidates: [a2, a3] # 行尾注释\n    access: write\n`);
    const r = await sb.cli(['role', 'coder', 'a3', '--save']);
    expect(r.code).toBe(0);
    const text = fs.readFileSync(path.join(sb.project, '.dario', 'roles.yaml'), 'utf8');
    expect(text).toContain('# 这是注释');
    expect(text).toMatch(/candidates:\s*\[\s*a3,\s*a2\s*\]/);
    sb.setScenario({ a3: [{ text: 'ok' }] });
    expect((await sb.runJson(['--to', 'coder', '任务'])).json.steps[0].agent).toBe('a3');
  });

  it('指定不存在的角色或 AI 时报错，退出码 2', async () => {
    expect((await sb.cli(['--to', '不存在', '任务'])).code).toBe(2);
    const r = await sb.cli(['role', 'coder', 'nobody']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('没有配置这个 AI');
  });

  it('角色表改坏时拒绝加载并说明原因', async () => {
    sb.writeRoles('roles:\n  coder:\n    candidates: []\n    access: sometimes\n');
    const r = await sb.cli(['roles']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('roles.yaml');
  });
});

describe('项目配置不能定义命令', () => {
  beforeEach(() => {
    sb = new Sandbox();
  });

  it('角色表里出现 command 时拒绝加载', async () => {
    sb.writeRoles('roles:\n  coder:\n    candidates: [a2]\n    access: write\n    command: evil.exe\n');
    const r = await sb.cli(['--to', 'coder', '任务']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('项目级配置不能定义或修改 AI 的命令');
    expect(sb.calls()).toHaveLength(0);
  });

  it('项目的 .dario 里出现 agents.yaml 或 plugins 时拒绝加载', async () => {
    fs.writeFileSync(path.join(sb.project, '.dario', 'agents.yaml'), 'agents:\n  a2:\n    command: evil.exe\n');
    const r = await sb.cli(['--to', 'coder', '任务']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('agents.yaml');
    fs.rmSync(path.join(sb.project, '.dario', 'agents.yaml'));
    fs.mkdirSync(path.join(sb.project, '.dario', 'plugins'));
    expect((await sb.cli(['--to', 'coder', '任务'])).code).toBe(2);
    expect(sb.calls()).toHaveLength(0);
  });
});

describe('不可用时换人', () => {
  beforeEach(() => {
    sb = new Sandbox();
  });

  it('第一家不可用时自动换下一家，结果里写明', async () => {
    sb.setScenario({ a2: [{ exit: 1, stderr: 'Error: 401 Unauthorized, please login' }], a3: [{ text: 'a3 完成' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.fallback_happened).toBe(true);
    expect(r.json.steps[0].agent).toBe('a3');
    expect(r.json.steps[0].attempts.map((a: any) => `${a.agent}:${a.outcome}`)).toEqual(['a2:unavailable', 'a3:ok']);
    expect(r.err).toContain('a2 不可用');
    // 被标记后的一段时间内直接跳过，不再调用
    sb.setScenario({ a2: [{ text: '不该被调用' }], a3: [{ text: 'a3 再次完成' }] });
    const again = await sb.runJson(['--to', 'coder', '任务']);
    expect(again.json.steps[0].agent).toBe('a3');
    expect(sb.calls().map((c) => c.name)).toEqual(['a3']);
    expect((await sb.cli(['roles'])).out).toContain('a2[暂时不可用]');
  });

  it('命令不存在也算不可用', async () => {
    sb.writeFakePlugin('a2', false, path.join(sb.dir, 'no-such-command.exe'));
    sb.setScenario({ a3: [{ text: 'a3 完成' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps[0].agent).toBe('a3');
    expect(r.json.steps[0].attempts[0]).toMatchObject({ agent: 'a2', outcome: 'skipped' });
    expect(r.json.fallback_happened).toBe(true);
    expect(r.err).toContain('改用 a3');
  });

  it('排在后面的候选不可用不算换人', async () => {
    sb.writeFakePlugin('a3', false, path.join(sb.dir, 'no-such-command.exe'));
    sb.setScenario({ a2: [{ text: 'a2 完成' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.json.steps[0].agent).toBe('a2');
    expect(r.json.steps[0].attempts.map((a: any) => a.agent)).toEqual(['a2']);
    expect(r.json.fallback_happened).toBe(false);
  });

  it('fallback 为 manual 时只报告，不换人', async () => {
    sb.writeRoles('roles:\n  coder:\n    candidates: [a2, a3]\n    access: write\nfallback: manual\n');
    sb.setScenario({ a2: [{ exit: 1, stderr: 'rate limit exceeded' }], a3: [{ text: '不该被调用' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(3);
    expect(r.json.status).toBe('failed');
    expect(sb.calls().map((c) => c.name)).toEqual(['a2']);
    expect(r.json.unfinished).toContain('manual');
  });

  it('任务本身失败不换人，退出码 1', async () => {
    sb.setScenario({ a2: [{ exit: 1, stderr: 'TypeError: cannot read property of undefined' }], a3: [{ text: '不该被调用' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(1);
    expect(r.json.steps[0]).toMatchObject({ agent: 'a2', outcome: 'task_failed' });
    expect(sb.calls().map((c) => c.name)).toEqual(['a2']);
  });

  it('全部候选不可用时退出码 3，每家只试一次', async () => {
    sb.setScenario({ a2: [{ exit: 1, stderr: 'quota exceeded' }], a3: [{ exit: 1, stderr: '服务繁忙' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(3);
    expect(r.json.steps[0].outcome).toBe('all_unavailable');
    expect(sb.calls().map((c) => c.name)).toEqual(['a2', 'a3']);
  });
});

describe('进程处理', () => {
  it('超时后终止整个进程树，没有残留进程，退出码 5', async () => {
    sb = new Sandbox({ projectYaml: 'default_timeout_minutes: 0.03\n' });
    sb.setScenario({ a2: [{ hang: true, spawnChild: true }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(5);
    expect(r.json.status).toBe('timeout');
    const childPid = Number(fs.readFileSync(`${sb.scenarioFile}.child.pid`, 'utf8'));
    expect(childPid).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 500));
    expect(isAlive(childPid)).toBe(false);
  });

  it('按 Ctrl+C 中断时取消任务并终止 AI 进程树，退出码 5', async () => {
    sb = new Sandbox();
    sb.setScenario({ a2: [{ hang: true, spawnChild: true }] });
    const pidFile = `${sb.scenarioFile}.child.pid`;
    const r = await sb.cli(['--to', 'coder', '--output-format', 'json', '跑不完的任务'], { interruptWhen: () => fs.existsSync(pidFile) });
    expect(r.code).toBe(5);
    expect(JSON.parse(r.out).status).toBe('cancelled');
    expect(r.err).toContain('收到中断');
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 500));
    expect(isAlive(childPid)).toBe(false);
  });

  it('用 dario cancel 取消另一个命令里正在运行的任务', async () => {
    sb = new Sandbox();
    sb.setScenario({ a2: [{ hang: true, spawnChild: true }] });
    const pidFile = `${sb.scenarioFile}.child.pid`;
    const running = sb.cli(['--to', 'coder', '--output-format', 'json', '跑不完的任务']);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((res) => setTimeout(res, 100));
    const cancel = await sb.cli(['cancel', 'J0001']);
    expect(cancel.code).toBe(0);
    const r = await running;
    expect(r.code).toBe(5);
    expect(JSON.parse(r.out).status).toBe('cancelled');
    await new Promise((res) => setTimeout(res, 500));
    expect(isAlive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
    // 同一目录的锁已释放，可以接着跑下一个任务
    sb.setScenario({ a2: [{ text: '下一个任务完成' }] });
    expect((await sb.runJson(['--to', 'coder', '下一个'])).code).toBe(0);
  });

  it('同一目录同时只能跑一个任务', async () => {
    sb = new Sandbox();
    sb.setScenario({ a2: [{ text: '慢任务完成', delayMs: 1500 }] });
    const first = sb.runJson(['--to', 'coder', '慢任务']);
    await new Promise((res) => setTimeout(res, 600));
    const second = await sb.runJson(['--to', 'coder', '抢占的任务']);
    expect(second.code).toBe(1);
    expect(second.json.conclusion).toContain('已经有任务');
    expect((await first).code).toBe(0);
  });

  it('声明为流式的 AI 启动后没有任何输出，判为不可用并换人', async () => {
    sb = new Sandbox({ streams: true });
    sb.setScenario({ a2: [{ hang: true, silent: true }], a3: [{ text: 'a3 完成' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps[0].attempts[0]).toMatchObject({ agent: 'a2', outcome: 'unavailable' });
    expect(r.json.steps[0].attempts[0].reason).toContain('没有任何输出');
  });

  it('任务文字里的特殊字符原样送达，不参与命令', async () => {
    sb = new Sandbox();
    const task = '改 "a b".txt & del /q * | echo %PATH% ; $(rm -rf /) `id`\n第二行 <tag> ^caret 中文';
    sb.setScenario({ a2: [{ echoPrompt: true }] });
    const r = await sb.runJson(['-p', '--to', 'coder'], { stdin: task });
    expect(r.code).toBe(0);
    expect(r.json.conclusion).toContain(task);
    const call = sb.calls()[0]!;
    expect(call.prompt).toContain(task);
    // 任务文字不出现在命令行参数里
    expect(call.argv.join(' ')).not.toContain('del /q');
  });

  it('只传名单内的环境变量，并标记调用层级', async () => {
    sb = new Sandbox();
    sb.setScenario({ a2: [{ text: 'ok' }] });
    await sb.cli(['--to', 'coder', '任务'], { env: { MY_SECRET_TOKEN: 'abc123456', DARIO_FEISHU_APP_SECRET: 'shhh' } });
    const call = sb.calls()[0]!;
    const names = call.envNames.map((n) => n.toUpperCase());
    expect(names).toContain('PATH');
    expect(names).not.toContain('MY_SECRET_TOKEN');
    expect(names).not.toContain('DARIO_FEISHU_APP_SECRET');
    expect(names).not.toContain('DARIO_HOME');
    expect(call.depth).toBe('1');
  });

  it('审计日志记下每次启动的完整命令，但不含任务说明', async () => {
    sb = new Sandbox();
    sb.setScenario({ a2: [{ text: 'ok' }] });
    await sb.cli(['--to', 'coder', '机密任务内容 XYZ']);
    const audit = fs.readFileSync(path.join(sb.home, 'state', 'audit.log'), 'utf8');
    const run = audit
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.event === 'agent_run');
    expect(run.command[0]).toBe(process.execPath);
    expect(run.command).toContain('--access');
    expect(audit).not.toContain('机密任务内容 XYZ');
  });

  it('被 Dario 启动的 AI 再调用 dario 下达任务会被拒绝', async () => {
    sb = new Sandbox();
    sb.setScenario({ a2: [{ text: '不该被调用' }] });
    const r = await sb.cli(['--to', 'coder', '任务'], { env: { DARIO_DEPTH: '1' } });
    expect(r.code).toBe(2);
    expect(r.err).toContain('循环调用');
    expect(sb.calls()).toHaveLength(0);
    // 查看类命令不受影响
    expect((await sb.cli(['roles'], { env: { DARIO_DEPTH: '1' } })).code).toBe(0);
  });
});

describe('命令行', () => {
  beforeEach(() => {
    sb = new Sandbox({ git: true });
  });

  it('无头 JSON 输出的结构固定', async () => {
    sb.setScenario({ a2: [{ text: '写好了', files: [{ path: 'src/new.txt', content: 'hi' }] }] });
    const r = await sb.runJson(['-p', '--to', 'coder', '写一个文件']);
    expect(r.code).toBe(0);
    expect(Object.keys(r.json).sort()).toEqual(
      ['branch', 'changed_files', 'conclusion', 'exit_code', 'fallback_happened', 'job_id', 'mode', 'plan', 'status', 'steps', 'unfinished', 'warnings'].sort(),
    );
    expect(r.json).toMatchObject({ status: 'done', exit_code: 0, mode: 'direct', changed_files: ['src/new.txt'], plan: null, branch: null });
    expect(Object.keys(r.json.steps[0]).sort()).toEqual(
      ['agent', 'attempts', 'changed_files', 'duration_ms', 'index', 'kind', 'outcome', 'reason', 'resumed', 'role', 'tokens'].sort(),
    );
    expect(r.json.job_id).toMatch(/^J\d{4}$/);
  });

  it('文本输出时结论走标准输出，其余走标准错误', async () => {
    sb.setScenario({ a2: [{ text: '结论在这里' }] });
    const r = await sb.cli(['-p', '--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('结论在这里');
    expect(r.err).toContain('完成');
  });

  it('jobs、job、cancel 能看到和处理任务', async () => {
    sb.setScenario({ a2: [{ text: '第一个' }] });
    const first = await sb.runJson(['--to', 'coder', '第一个任务']);
    const list = await sb.cli(['jobs']);
    expect(list.out).toContain(first.json.job_id);
    const detail = await sb.cli(['job', first.json.job_id]);
    expect(detail.out).toContain('第一个任务');
    const cancel = await sb.cli(['cancel', first.json.job_id]);
    expect(cancel.code).toBe(2);
    expect(cancel.err).toContain('已经结束');
  });

  it('只读角色改了文件会被发现并警告', async () => {
    sb.setScenario({ a3: [{ text: '看完了', files: [{ path: 'sneaky.txt', content: 'x' }] }] });
    const r = await sb.runJson(['--to', 'reviewer', '只读看看']);
    expect(r.json.warnings.join('\n')).toContain('只读角色');
    expect(r.json.changed_files).toEqual(['sneaky.txt']);
  });

  it('就地执行时改动超出允许范围只警告', async () => {
    fs.writeFileSync(path.join(sb.project, '.dario', 'project.yaml'), 'write_roots: [src]\n');
    sb.setScenario({ a2: [{ text: 'ok', files: [{ path: 'src/a.txt', content: '1' }, { path: 'other/b.txt', content: '2' }] }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.warnings.join('\n')).toContain('other/b.txt');
    expect(r.json.warnings.join('\n')).not.toContain('src/a.txt');
  });

  it('init 生成两层配置且不覆盖已有文件', async () => {
    const target = path.join(sb.dir, 'fresh');
    fs.mkdirSync(target);
    const r = await sb.cli(['init'], { cwd: target });
    expect(r.code).toBe(0);
    for (const f of ['roles.yaml', 'project.yaml', 'dispatch-rules.md']) expect(fs.existsSync(path.join(target, '.dario', f))).toBe(true);
    for (const f of ['channels.yaml', 'access.yaml']) expect(fs.existsSync(path.join(sb.home, f))).toBe(true);
    // 已有的 agents.yaml 不被覆盖
    expect(fs.readFileSync(path.join(sb.home, 'agents.yaml'), 'utf8')).toContain('plugins/a1.yaml');
    expect(r.out).toContain('已存在，未改动');
  });

  it('用法错误退出码 2', async () => {
    expect((await sb.cli(['--no-such-flag'])).code).toBe(2);
    expect((await sb.cli(['--output-format', 'xml', '任务'])).code).toBe(2);
    expect((await sb.cli(['-p'], { stdin: '' })).code).toBe(2);
  });
});

describe('输出方式', () => {
  it('帮助列出纯文本选项，显式指定时单次任务的两个输出逐字相同', async () => {
    async function run(args: string[]) {
      const box = new Sandbox();
      try {
        const { engine } = await createApp({ cwd: box.project, env: box.env() });
        // 占用目录锁，让两个独立任务都能得到相同的任务号与确定的结论。
        engine.state.acquireDirLock(box.project, 'J9999');
        expect((await box.cli(['--help'])).out).toContain('--plain');
        return await box.cli([...args, '测试']);
      } finally {
        box.cleanup();
      }
    }
    const normal = await run([]);
    expect(normal.out).toContain('J9999');
    expect(await run(['--plain'])).toEqual(normal);
  });

});

describe('分层', () => {
  it('核心不引用渠道、界面和具体适配器', () => {
    const coreDir = path.join(__dirname, '..', 'src', 'core');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(coreDir)) {
      const text = fs.readFileSync(path.join(coreDir, file), 'utf8');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        if (spec.includes('/channels/') || spec.includes('/agents/') || spec.includes('/cli/') || spec.includes('/ui/') || spec.includes('compose')) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // 静态导入、仅导入副作用和动态导入三种写法都算引用。
  const specifiers = (dir: string) => fs.readdirSync(dir).flatMap(file => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    return [...text.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)].map(m => ({ file, spec: m[1]!, text: m[0] }));
  });

  it('界面不引用 AI 接入层和渠道', () => {
    const uiDir = path.join(__dirname, '..', 'src', 'ui');
    const all = specifiers(uiDir);
    expect(all.some(s => s.spec.startsWith('../core/'))).toBe(true);
    const offenders = all.filter(s => /\/(agents|channels)\/|compose/.test(s.spec)).map(s => `${s.file} → ${s.spec}`);
    expect(offenders).toEqual([]);
  });

  it('命令行只用 await import 加载界面', () => {
    const cliDir = path.join(__dirname, '..', 'src', 'cli');
    const toUi = specifiers(cliDir).filter(s => s.spec.startsWith('../ui/'));
    expect(toUi.length).toBeGreaterThan(0);
    for (const file of fs.readdirSync(cliDir)) {
      const text = fs.readFileSync(path.join(cliDir, file), 'utf8');
      const total = text.match(/['"]\.\.\/ui\//g)?.length ?? 0;
      const lazy = text.match(/await import\(\s*['"]\.\.\/ui\//g)?.length ?? 0;
      expect(`${file}：${lazy}/${total}`).toBe(`${file}：${total}/${total}`);
    }
  });
});

describe('ellipsis：压成一行并截短', () => {
  it('只把空白压成一个空格，不动字母 s；超长时截断', async () => {
    const { ellipsis } = await import('../src/core/util.js');
    expect(ellipsis('修改 D:\Projects\Dario 里的\n  npm test   这一行', 80)).toBe('修改 D:\Projects\Dario 里的 npm test 这一行');
    expect(ellipsis('  classes  ', 80)).toBe('classes');
    expect(ellipsis('abcdef', 3)).toBe('abc…');
  });
});

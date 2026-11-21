import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, expect, it } from 'vitest';
import { parseCommand, requiresAdmin } from '../src/core/commands.js';
import { formatModel } from '../src/core/report.js';
import { createApp } from '../src/compose.js';
import { loadUserConfig, parseRoles, writeModelSettings } from '../src/core/config.js';
import { Sandbox } from './helpers.js';

let sb: Sandbox;
afterEach(() => sb?.cleanup());
const app = () => createApp({ cwd: sb.project, env: sb.env() });
const agentsFile = () => path.join(sb.home, 'agents.yaml');
const rolesFile = () => path.join(sb.project, '.dario', 'roles.yaml');
const origin = { channel: 'terminal', senderId: '测试' };

it('按角色与 AI 分别取型号和强度，原样使用强度，保留内置型号', async () => {
  sb = new Sandbox({ resumable: true, agentsExtra: { agents: {
    a2: { model: 'base', effort: 'high', roles: { coder: { effort: 'bogus' } } },
  } } });
  sb.writeRoles(`roles:
  coder: { candidates: [a2], access: write, models: { a2: { model: light, effort: low } } }
  reviewer: { candidates: [a2], access: read-only, models: { a2: { effort: bogus } } }
`);
  const { engine } = await app();
  const pick = (role: string, ai: string) => engine.roles.modelFor(role, ai);
  expect(await engine.roles.listModels('a2')).toEqual({ models: [{ id: 'light', efforts: ['low'] }, ...['custom', 'base', 'review', 'work'].map(id => ({ id }))] });
  expect(pick('coder', 'a1')).toEqual({ modelSource: 'tool', effortSource: 'tool' });
  expect(pick('coder', 'deepseek')).toEqual({ model: 'deepseek-v4-pro', modelSource: 'default', effortSource: 'tool' });
  expect(pick('reviewer', 'a2')).toEqual({ model: 'base', effort: 'bogus', modelSource: 'default', effortSource: 'project' });
  expect(pick('coder', 'a2')).toEqual({ model: 'light', effort: 'bogus', modelSource: 'project', effortSource: 'local' });
  await engine.setModel('coder', { effort: 'low' });
  expect(pick('coder', 'a2')).toEqual({ model: 'light', effort: 'low', modelSource: 'project', effortSource: 'local' });
  await engine.resetModel('coder');
  await engine.setModel('coder', { model: 'custom' });
  expect((await engine.rolesView())[0]?.candidates[0]).toMatchObject({
    model: 'custom', modelSource: 'local', effort: 'low', effortSource: 'project',
  });
  await engine.setModel('coder', { effort: 'high' });
  expect(pick('coder', 'a2')).toEqual({ model: 'custom', effort: 'high', modelSource: 'local', effortSource: 'local' });
});

it('刷新角色和执行一步都不查型号，写入时每次查询并按当次回复校验', async () => {
  sb = new Sandbox({ resumable: true, roles: 'roles: { coder: { alias: [执行], candidates: [a2], access: read-only } }',
    agentsExtra: { agents: { a2: { roles: { coder: { effort: 'unexpected' } } } } } });
  sb.writeResumablePlugin('a2', 'models');
  const { engine } = await app();
  sb.setScenario({ models: [
    { text: '[{"id":"fixed","efforts":[]}]' }, { text: '[{"id":"known"}]' }, { exit: 1 }, { exit: 1 },
  ] });
  await engine.rolesView();
  expect((await engine.submit({ task: '测试', role: 'coder', origin })).status).toBe('done');
  expect(sb.calls().filter(c => c.name === 'models')).toHaveLength(0);
  const args = sb.calls()[0]!.argv;
  expect(args[args.indexOf('--effort') + 1]).toBe('unexpected');

  await expect(engine.setModel('coder', { model: 'fixed', effort: 'low' })).rejects.toThrow(/可选档位：无/);
  const before = fs.readFileSync(agentsFile(), 'utf8');
  await expect(engine.setModel('coder', { model: 'custom', effort: 'high' })).rejects.toThrow(/没有 custom.*known/);
  // 查询失败时，静态建议里 light 的档位也不能作为当前型号的限制。
  await expect(engine.setModel('coder', { model: 'light', effort: 'high' })).rejects.toThrow(/没能取到型号清单/);
  expect(fs.readFileSync(agentsFile(), 'utf8')).toBe(before);
  await engine.resetModel('coder');
  expect(await engine.setModel('coder', { effort: 'low' })).toContain('执行（a2）改为 a2[low]');
  expect(sb.calls().filter(c => c.name === 'models')).toHaveLength(4);
});

it('三种写入位置、保留注释、同进程执行与健康检查、清理空角色表', async () => {
  sb = new Sandbox({ resumable: true });
  fs.appendFileSync(agentsFile(), '# 本机注释\n');
  sb.writeRoles(`# 项目注释
roles:
  coder: { alias: [执行], candidates: [a2], access: read-only }
  reviewer: { candidates: [a2], access: read-only }
`);
  const { engine } = await app();
  await engine.setModel('执行', { model: 'base', effort: 'low' }, 'default');
  await engine.setModel('reviewer', { model: 'review', effort: 'high' }, 'project');
  await engine.setModel('执行', { model: 'work' });
  await engine.setModel('执行', { model: undefined, effort: 'high' });
  const local = fs.readFileSync(agentsFile(), 'utf8');
  expect(local).toContain('# 本机注释');
  expect(parse(local).agents.a2).toEqual({ model: 'base', effort: 'low', roles: { coder: { model: 'work', effort: 'high' } } });
  const project = fs.readFileSync(rolesFile(), 'utf8');
  expect(project).toContain('# 项目注释');
  expect(parse(project).roles.reviewer.models).toEqual({ a2: { model: 'review', effort: 'high' } });
  const run = async (role: string) => {
    const job = await engine.submit({ task: '测试', role, origin });
    expect(job.status).toBe('done');
  };
  await run('执行');
  await run('reviewer');
  await engine.health('a2');
  await engine.resetModel('执行');
  expect(parse(fs.readFileSync(agentsFile(), 'utf8')).agents.a2).toEqual({ model: 'base', effort: 'low' });
  await run('执行');
  const actual = sb.calls().map(c => [c.name, c.argv[c.argv.indexOf('--model') + 1], c.argv[c.argv.indexOf('--effort') + 1]]);
  expect(actual).toEqual([['a2', 'work', 'high'], ['a2', 'review', 'high'], ['a2', 'base', 'low'], ['a2', 'base', 'low']]);
});

it('写入以当前担当者为准，拒绝所选型号不支持的档位与非法型号', async () => {
  sb = new Sandbox({ resumable: true });
  const { engine } = await app();
  engine.setRole('coder', 'a3', false);
  expect(await engine.setModel('coder', { model: 'light' })).toBe(`实现（a3）改为 light，已写入 ${agentsFile()}，下一步起生效。`);
  const before = fs.readFileSync(agentsFile(), 'utf8');
  expect(parse(before).agents).toEqual({ a3: { roles: { coder: { model: 'light' } } } });
  await expect(engine.setModel('coder', { effort: 'high' })).rejects.toThrow(/a3.*high.*可选档位：low$/);
  await expect(engine.setModel('coder', { effort: 'HIGH' })).rejects.toThrow(/可选档位：low$/);
  await expect(engine.setModel('coder', { model: '--version' })).rejects.toThrow(/型号格式/);
  expect(fs.readFileSync(agentsFile(), 'utf8')).toBe(before);
});

it('用户角色表也提供建议；没有项目角色表时禁止写回项目', async () => {
  sb = new Sandbox();
  sb.writeRoles('roles: { coder: { candidates: [a2], access: write, models: { a2: { model: custom, effort: high } } } }');
  fs.renameSync(rolesFile(), path.join(sb.home, 'roles.yaml'));
  const { engine } = await app();
  expect(engine.roles.modelFor('coder', 'a2')).toEqual({ model: 'custom', modelSource: 'project', effortSource: 'tool' });
  await expect(engine.setModel('coder', { effort: 'high' })).rejects.toThrow(/可选档位：无/);
  await expect(engine.setModel('coder', { model: 'custom' }, 'project')).rejects.toThrow(/没有自己的角色表/);
});

it('本机 agents 留空时能新建条目并保留行尾注释', async () => {
  sb = new Sandbox({ resumable: true });
  fs.appendFileSync(agentsFile(), 'agents: # 保留这句\n');
  const { engine } = await app();
  await engine.setModel('coder', { model: 'custom' });
  const saved = fs.readFileSync(agentsFile(), 'utf8');
  expect(saved).toContain('# 保留这句');
  expect(parse(saved).agents.a2.roles.coder).toEqual({ model: 'custom' });
});

it('没有可用担当者时拒绝设置与重置', async () => {
  sb = new Sandbox({ agentsExtra: { agents: { a1: { enabled: false } } } });
  const { engine } = await app();
  await expect(engine.setModel('lead', { model: 'x' })).rejects.toThrow(/没有可用/);
  await expect(engine.resetModel('lead')).rejects.toThrow(/没有可用/);
});

it.each([{ model: '-c' }, { effort: 'HIGH' }, { args: ['--other'] }])('角色表与本机角色设置都拒绝非法字段 %o', value => {
  sb = new Sandbox();
  for (const project of [true, false]) {
    const file = project ? rolesFile() : path.join(sb.home, 'roles.yaml');
    const data = { roles: { coder: { candidates: ['a2'], access: 'write', models: { a2: value } } } };
    const load = () => parseRoles(data, file, project);
    expect(load).toThrow(file);
    expect(load).toThrow(/roles\.coder\.models\.a2/);
  }
  fs.writeFileSync(agentsFile(), stringify({ agents: { a2: { roles: { coder: value } } } }));
  expect(() => loadUserConfig(sb.home)).toThrow(/agents\.a2\.roles\.coder/);
});

it('检查报告三处不支持的强度，即使被上层覆盖也会报告', async () => {
  sb = new Sandbox({ resumable: true, agentsExtra: { agents: {
    a2: { model: 'unknown', effort: 'wrong', roles: { coder: { effort: 'localbad' } } },
    ...Object.fromEntries(['codex', 'claude', 'codebuddy', 'deepseek'].map(id => [id, { enabled: false, command: 'dario-test-missing' }])),
  } } });
  sb.writeRoles('roles: { coder: { candidates: [a2], access: write, models: { a2: { model: light, effort: high } } } }');
  sb.writeResumablePlugin('a2', 'models');
  sb.setScenario({ models: [
    { text: '[{"id":"light","efforts":["low"]}]' },
    { text: '[{"id":"light","efforts":["low","high"]},{"id":"alias","resolved":"unknown"}]' },
  ] });
  const result = await sb.cli(['check']);
  expect(result.code).toBe(1);
  expect(result.out).toContain('a2 返回的型号清单里没有 unknown。');
  expect(result.out).not.toContain('清单里没有 deepseek-v4-pro');
  expect(result.out).toMatch(/默认.*a2.*wrong.*low、high/);
  expect(result.out).toMatch(/coder.*a2.*localbad.*可选档位：low/);
  expect(result.out).toMatch(/coder.*a2.*high.*可选档位：low/);
  const next = await sb.cli(['check']);
  expect(next.out).not.toContain('清单里没有 unknown');
  expect(next.out).not.toContain('不支持强度 high');
  expect(next.out).toContain('不支持强度 localbad，可选档位：low、high');
  expect(sb.calls().filter(c => c.name === 'models')).toHaveLength(2);
});

it.each([
  [undefined, undefined, '甲'], ['乙', undefined, '乙'], [undefined, 'low', '甲[low]'], ['乙', 'high', '乙[high]'],
])('格式化型号与强度 %s、%s', (model, effort, expected) => {
  expect(formatModel('甲', model, effort)).toBe(expected);
});

it('型号指令区分查看与修改，缺少参数和冲突标志均报用法', () => {
  for (const line of ['/model', '/model 实现']) expect(requiresAdmin(parseCommand(line))).toBe(false);
  for (const [line, expected] of [
    ['/model 实现 high', { value: 'high', target: 'local' }],
    ['/model coder work high --save', { value: 'work', effort: 'high', target: 'project' }],
    ['/model 实现 work --default', { target: 'default' }], ['/model 实现 --reset', { reset: true }],
  ] as const) {
    const parsed = parseCommand(line);
    expect(parsed).toMatchObject({ kind: 'model', ...expected });
    expect(requiresAdmin(parsed)).toBe(true);
  }
  for (const args of ['--save', '--reset', '实现 --default', '实现 work --reset', '实现 work --save --default', '实现 work low 多余']) {
    expect(parseCommand('/model ' + args)).toMatchObject({ kind: 'invalid', message: expect.stringContaining('用法') });
  }
});

it('型号子命令接受别名、档位简写和三个目标，角色表与 AI 列表显示各自生效值', async () => {
  const disabled = { enabled: false };
  sb = new Sandbox({ resumable: true, agentsExtra: { agents: { claude: disabled, codex: disabled, codebuddy: disabled, deepseek: disabled } } });
  const model = async (...args: string[]) => {
    const r = await sb.cli(['model', ...args]);
    expect(r.code, r.err).toBe(0);
    return r.out;
  };
  expect(await model('实现')).toMatch(/可选的型号：[\s\S]*light/);
  await model('实现', 'base', '--effort', 'high', '--default');
  await model('实现', 'work', 'low', '--save');
  expect(await model('coder', 'high')).toContain('work[high]');
  expect(await model()).toMatch(/实现\s+a2\s+work\[high\]\s+项目/);
  expect((await sb.cli(['roles'])).out).toMatch(/担当：a2（work\[high\]）\s+候选：a2（work\[high\]）/);
  expect((await sb.cli(['agents'])).out).toContain('模型 base[high]');
  await model('实现', '--reset');
  expect(await model()).toContain('work[low]');
  expect((await sb.cli(['model', '实现', '--effort'])).code).toBe(2);
});

it('显示名对照跨进程保留，按标识和实际型号匹配，保存与调用保留原值', async () => {
  const disabled = { enabled: false, command: 'dario-test-missing' };
  sb = new Sandbox({ resumable: true, agentsExtra: { agents: {
    a2: { model: 'full', effort: 'low', roles: { coder: { effort: 'high' } } },
    claude: disabled, codex: disabled, codebuddy: disabled, deepseek: disabled,
  } } });
  sb.writeResumablePlugin('a2', 'models');
  const reply = { text: JSON.stringify([{ id: 'alias', resolved: 'full', label: '显示名' }]) };
  sb.setScenario({ models: [reply, reply, { exit: 1 }] });
  const { engine } = await app();
  expect(await engine.setModel('coder', { model: 'full' })).toContain('显示名[high]');
  expect(engine.roles.modelFor('coder', 'a2').model).toBe('full');
  expect(await engine.setModel('coder', { model: 'alias', effort: null })).toContain('显示名[low]');
  expect(parse(fs.readFileSync(agentsFile(), 'utf8')).agents.a2.roles.coder).toEqual({ model: 'alias' });
  const { modelLabel } = engine.roles;
  expect(['alias', 'full', 'other'].map(m => modelLabel('a2', m))).toEqual(['显示名', '显示名', 'other']);
  expect(formatModel('a2', 'full', undefined, modelLabel)).toBe('显示名');
  const cache = path.join(sb.home, 'state', 'models.json');
  const saved = fs.readFileSync(cache, 'utf8');
  expect(JSON.parse(saved).a2).toEqual({ observedAt: expect.any(String), models: JSON.parse(reply.text) });
  expect((await engine.roles.listModels('a2')).error).toBeTruthy();
  expect(fs.readFileSync(cache, 'utf8')).toBe(saved);
  sb.setScenario({ models: [reply] });
  const listing = await sb.cli(['model', 'coder']);
  expect(listing.out.split('\n')).toContain('显示名  alias');
  sb.setScenario({});
  for (const cmd of ['roles', 'agents']) {
    expect((await sb.cli([cmd])).out).toContain('显示名[low]');
  }
  expect(sb.calls()).toHaveLength(0);
  sb.setScenario({ models: [{ text: JSON.stringify([{ id: 'alias', label: '最新显示名' }]) }, { exit: 1 }] });
  for (let i = 0; i < 2; i++) expect((await sb.cli(['model'])).out).toContain('最新显示名[low]');
  expect(sb.calls().map(c => c.name)).toEqual(['models', 'models']);
  sb.setScenario({});
  await engine.submit({ task: '测试', role: 'coder', origin });
  const args = sb.calls()[0]!.argv;
  expect(args[args.indexOf('--model') + 1]).toBe('alias');
});

it('只给一个词时，当前型号独有的档位按强度处理，清单里的型号按型号处理', async () => {
  const disabled = { enabled: false, command: 'dario-test-missing' };
  sb = new Sandbox({ resumable: true, agentsExtra: { agents: {
    a2: { model: 'm1' }, claude: disabled, codex: disabled, codebuddy: disabled, deepseek: disabled,
  } } });
  sb.writeResumablePlugin('a2', 'models');
  // ultra 不在工具的通用档位里，只有 m1 自己支持；m2 是清单里的另一个型号
  const reply = { text: JSON.stringify([{ id: 'm1', label: '型号一', efforts: ['low', 'ultra'] }, { id: 'm2', label: '型号二' }]) };
  sb.setScenario({ models: [reply, reply] });
  expect((await sb.cli(['model', 'coder', 'ultra'])).out).toContain('型号一[ultra]');
  expect(parse(fs.readFileSync(agentsFile(), 'utf8')).agents.a2.roles.coder).toEqual({ effort: 'ultra' });
  sb.setScenario({ models: [reply, reply] });
  expect((await sb.cli(['model', 'coder', 'm2'])).out).toContain('型号二');
  expect(parse(fs.readFileSync(agentsFile(), 'utf8')).agents.a2.roles.coder.model).toBe('m2');
  // 既不是型号也不是当前型号的档位：按型号处理并被拒绝
  sb.setScenario({ models: [reply, reply] });
  const rejected = await sb.cli(['model', 'coder', 'nonsense']);
  expect(rejected.code).toBe(2);
  expect(rejected.err + rejected.out).toContain('清单里没有 nonsense');
});

it('清单较长时，拒绝信息给出前十个型号和总数', async () => {
  sb = new Sandbox({ resumable: true });
  sb.writeResumablePlugin('a2', 'models');
  const models = Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, label: '型号' + i }));
  sb.setScenario({ models: [{ text: JSON.stringify(models) }] });
  const { engine } = await app();
  await expect(engine.setModel('coder', { model: 'missing' })).rejects.toThrow('可选型号：' + models.slice(0, 10).map(m => `${m.label}（${m.id}）`).join('、') + '（共 12 个）');
});

const manualConfig = `# 本机的 AI 配置。
plugins: []

agents:
  claude:
    model: claude-fable-5-2              # 这家 AI 的默认型号
    effort: high                         # 默认强度
    options:
      # --autocompact：压缩界限
      extra_args: ["--autocompact", "150000"]
    allowed_tools:
      write: [Read, Grep, Glob, Edit, Write, NotebookEdit, Bash, PowerShell, mcp__UnityMCP]

  # 型号与强度以这里为准
  codex:
    model: gpt-6.2-astra
    effort: medium
    options:
      write_args: ["-c", 'mcp_servers.unityMCP.default_tools_approval_mode="approve"']
      read_only_args: ["-c", "mcp_servers.unityMCP.enabled=false", "-c", "mcp_servers.blender.enabled=false"]

# 可写角色的权限。
# 第二行注释。
permissions: full

# 冷却时间（分钟）
cooldown_minutes: 10
`;

it.each(['\n', '\r\n'])('局部写入与撤销逐字节保留手工配置（换行 %j）', eol => {
  sb = new Sandbox();
  const file = agentsFile();
  const bytes = (s: string) => Buffer.from(s.replaceAll('\n', eol));
  const source = manualConfig + '\n';
  fs.writeFileSync(file, bytes(source));
  const read = () => fs.readFileSync(file);
  const role = ['agents', 'claude', 'roles', 'reviewer'];
  const added = '    roles:\n      reviewer:\n        model: opus\n        effort: xhigh\n';
  const expected = source.replace('\n  # 型号', added + '\n  # 型号');
  writeModelSettings(file, role, { model: 'opus', effort: 'xhigh' });
  expect(read()).toEqual(bytes(expected));
  writeModelSettings(file, role, { effort: 'medium' });
  expect(read()).toEqual(bytes(expected.replace('effort: xhigh', 'effort: medium')));
  writeModelSettings(file, role);
  expect(read()).toEqual(bytes(source));

  const newRole = ['agents', 'codebuddy', 'roles', 'reviewer'];
  writeModelSettings(file, newRole, { model: 'buddy' });
  expect(read()).toEqual(bytes(source.replace('\n# 可写', '  codebuddy:\n    roles:\n      reviewer:\n        model: buddy\n\n# 可写')));
  writeModelSettings(file, newRole);
  expect(read()).toEqual(bytes(source));

  writeModelSettings(file, ['agents', 'codex'], { model: 'new' });
  writeModelSettings(file, ['agents', 'claude'], { effort: 'low' });
  expect(read()).toEqual(bytes(source.replace('gpt-6.2-astra', 'new').replace('effort: high ', 'effort: low  ')));
});

it.each(['', 'null', 'agents: Null    # 显式空值\n', 'agents: ~\r\n', 'agents: # 留空\n\n', 'agents: {codebuddy: {}}', 'agents:\n  codebuddy: {}\n', '# 文件头\nagents: {}   # 内联\n\n', 'plugins: []', 'agents: {codex: {model: base}}'])(
  '空配置、内联映射与无末尾换行的配置都可写入并还原（%j）', source => {
    sb = new Sandbox();
    const file = agentsFile();
    fs.writeFileSync(file, source);
    const keys = ['agents', 'codebuddy', 'roles', 'reviewer'];
    writeModelSettings(file, keys, { model: 'buddy', effort: 'high' });
    expect(parse(fs.readFileSync(file, 'utf8')).agents.codebuddy.roles.reviewer).toEqual({ model: 'buddy', effort: 'high' });
    writeModelSettings(file, keys);
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
  });

it('项目建议与保存候选首位都只改目标行', async () => {
  sb = new Sandbox({ resumable: true });
  const source = `# 项目角色
roles:
  coder:
    candidates: [a2, a3]            # 候选顺序
    access: write

# 换人方式
fallback: auto

`;
  sb.writeRoles(source);
  const { engine } = await app();
  const read = () => fs.readFileSync(rolesFile(), 'utf8');
  await engine.setModel('coder', { model: 'custom' }, 'project');
  const expected = source.replace('    access: write\n', '    access: write\n    models:\n      a2:\n        model: custom\n');
  expect(read()).toBe(expected);
  engine.setRole('coder', 'a3', true);
  expect(read()).toBe(expected.replace('[a2, a3]', '[a3, a2]'));
});

it('型号列表按中文显示宽度对齐每一列', async () => {
  sb = new Sandbox({ resumable: true, roles: `roles:
  lead: { alias: [主控], candidates: [a2], access: read-only }
  coder: { alias: [执行者], candidates: [a3], access: write }
  empty: { alias: [空], candidates: [missing], access: read-only }
`, agentsExtra: { agents: { a2: { model: 'base' }, a3: { model: 'custom', effort: 'high' } } } });
  expect((await sb.cli(['model'])).out.trimEnd().split('\n')).toEqual([
    '主控     a2   base           默认',
    '执行者   a3   custom[high]   默认',
    '空       无可用 AI',
  ]);
});

it('同次编辑的后续字段无法安全删除时整份文件保持原样', () => {
  sb = new Sandbox();
  const file = agentsFile();
  const source = 'agents:\n  a2:\n    roles:\n      coder: {model: old, # 两项之间的注释\n              effort: high}\n';
  fs.writeFileSync(file, source);
  expect(() => writeModelSettings(file, ['agents', 'a2', 'roles', 'coder'], { model: 'new', effort: null }))
    .toThrow('无法安全地局部修改配置');
  expect(fs.readFileSync(file, 'utf8')).toBe(source);
});

it('局部替换会经 YAML 别名连带改变另一家 AI 时拒绝写入', () => {
  sb = new Sandbox();
  const file = agentsFile();
  const source = 'agents:\n  a2: &shared\n    model: base\n  a3: *shared\n';
  fs.writeFileSync(file, source);
  expect(() => writeModelSettings(file, ['agents', 'a2'], { model: 'custom' })).toThrow('无法安全地局部修改配置');
  expect(fs.readFileSync(file, 'utf8')).toBe(source);
});

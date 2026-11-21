import path from 'node:path';
import fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/compose.js';
import { DEFAULT_TEST_ROLES, plan, Sandbox, verdict } from './helpers.js';

let sb: Sandbox;
afterEach(() => sb?.cleanup());
const own = { role: 'lead', task: '修正标题', writes: true, acceptance: '标题拼写正确' };
const change = { text: '已改标题', files: [{ path: 'README.md', content: '# 新标题' }] };
const origin = { channel: 'terminal', senderId: '测试' };
const trace = () => sb.calls().map(c => [c.name, c.access, c.argv.includes('--resume') ? c.argv[c.argv.indexOf('--resume') + 1] : undefined]);

it('默认允许主控自做小改动，等待批准后以可写方式续接，自动审查并只读汇总', async () => {
  sb = new Sandbox({ git: true, resumable: true, projectYaml: 'preamble: 仅对标题作修订\nwrite_roots: [README.md]\n' });
  sb.setScenario({ a1: [{ text: plan([own]) }, change, { text: '完成' }], a3: [{ text: verdict(true) }] });
  const pending = await sb.runJson(['-p', '修改标题']);
  expect(pending.code).toBe(4);
  expect(pending.err).toContain('主控（lead）自己做，改文件');
  expect(trace()).toEqual([['a1', 'read-only', undefined]]);
  const planning = sb.calls()[0]!.prompt;
  for (const rule of ['自己的角色 id（lead）', 'writes 为 true', '几十行以内', '已读过要改的代码', '外部工具', '现在不要动手']) expect(planning).toContain(rule);
  expect(planning).not.toContain('不要把主控自己列为步骤');
  expect(planning).not.toContain('这些都交给下面的角色');
  const done = await sb.runJson(['approve', pending.json.job_id]);
  expect(done.code).toBe(0);
  expect(done.json.changed_files).toEqual(['README.md']);
  expect(trace()).toEqual([
    ['a1', 'read-only', undefined], ['a1', 'write', 'a1-s0'], ['a3', 'read-only', undefined], ['a1', 'read-only', 'a1-s0'],
  ]);
  const prompt = sb.calls()[1]!.prompt;
  for (const part of ['计划已确认', '可以修改文件', '只允许改动这些目录：README.md', own.task, own.acceptance]) expect(prompt).toContain(part);
  expect(prompt).not.toContain('仅对标题作修订');
  expect(prompt).not.toContain('可用角色');
});

it.each([
  [true, false, '交给主控自己的步骤必须是要改文件的小改动；只需要阅读和判断的事直接写在思路或答案里'],
  [false, true, '不能交给主控自己'],
] as const)('开关为 %s、主控步骤 writes 为 %s 时要求重出计划', async (enabled, writes, error) => {
  sb = new Sandbox({ git: true, resumable: true, projectYaml: `lead_implements: ${enabled}` });
  sb.setScenario({
    a1: [{ text: plan([{ ...own, writes }]) }, { text: plan([{ ...own, role: 'coder' }]) }, { text: '完成' }],
    a2: [change], a3: [{ text: verdict(true) }],
  });
  const r = await sb.runJson(['-p', '--yes', '修改标题']);
  expect(r.code).toBe(0);
  expect(sb.calls()[1]!.prompt).toContain(error);
  expect(sb.calls()[2]!.name).toBe('a2');
  if (!enabled) {
    expect(sb.calls()[0]!.prompt).toContain('不要把主控自己列为步骤');
    expect(sb.calls()[0]!.prompt).not.toContain('自己的角色 id');
    expect(sb.calls()[0]!.prompt).not.toContain('几十行以内');
  }
});

it('混合计划按顺序执行，主控看到其间的结果和文件，审查避开最近动手的主控', async () => {
  sb = new Sandbox({ git: true, resumable: true, roles: DEFAULT_TEST_ROLES.replace('candidates: [a3, a2]', 'candidates: [a1, a3]') });
  sb.setScenario({
    a1: [{ text: plan([{ ...own, role: 'coder' }, own, { role: 'reviewer', task: '核对标题' }]) }, change, { text: '完成' }],
    a2: [{ text: '执行者已修正索引', files: [{ path: '索引.md', content: '标题' }] }],
    a3: [{ text: verdict(true) }],
  });
  expect((await sb.runJson(['-p', '--yes', '修改标题'])).code).toBe(0);
  expect(trace()).toEqual([
    ['a1', 'read-only', undefined], ['a2', 'write', undefined], ['a1', 'write', 'a1-s0'],
    ['a3', 'read-only', undefined], ['a1', 'read-only', 'a1-s0'],
  ]);
  expect(sb.calls()[2]!.prompt).toContain('执行者已修正索引');
  expect(sb.calls()[2]!.prompt).toContain('- 索引.md');
});

it('审查只有主控用过的 AI 可选时照常审查并点明重合的角色', async () => {
  sb = new Sandbox({ git: true, roles: DEFAULT_TEST_ROLES.replace('candidates: [a3, a2]', 'candidates: [a1]') });
  sb.setScenario({ a1: [{ text: plan([own]) }, change, { text: verdict(true) }, { text: '完成' }] });
  const r = await sb.runJson(['-p', '--yes', '修改标题']);
  expect(r.code).toBe(0);
  expect(r.json.steps[2]).toMatchObject({ kind: 'review', agent: 'a1' });
  expect(r.json.warnings.join(' ')).toContain('与lead由同一家 AI（a1）');
});

it('主控续接返工，下一任务仍按计划指纹接收精简说明', async () => {
  sb = new Sandbox({ git: true, resumable: true });
  sb.setScenario({
    a1: [{ text: plan([own]) }, change, { text: '已纠正', files: [{ path: 'README.md', content: '# 正确标题' }] }, { text: '完成' }, { text: plan([]) }],
    a3: [{ text: verdict(false, ['拼写有误']) }, { text: verdict(true) }],
  });
  const { engine } = await createApp({ cwd: sb.project, env: sb.env() });
  const first = await engine.submit({ task: '改标题', origin, autoApprove: true });
  expect(first.status).toBe('done');
  expect(first.steps[3]).toMatchObject({ kind: 'rework', role: 'lead', access: 'write', resumed: true });
  expect(trace()[3]).toEqual(['a1', 'write', 'a1-s0']);
  expect(sb.calls()[3]!.prompt).toContain('拼写有误');
  expect(fs.readFileSync(path.join(sb.project, 'README.md'), 'utf8')).toBe('# 正确标题');
  await engine.submit({ task: '再看一下', origin, sessions: first.sessions });
  expect(trace().at(-1)).toEqual(['a1', 'read-only', 'a1-s0']);
  const next = sb.calls().at(-1)!.prompt;
  expect(next).toContain('小改动可以按之前的规则留给自己');
  expect(next).not.toContain('# 可用角色');
  expect(next).not.toContain('# 分派规则');
});

it('计划后主控换人，新的担当者收到可写的完整任务说明', async () => {
  sb = new Sandbox({ git: true, resumable: true, roles: DEFAULT_TEST_ROLES.replace('[a1]', '[a1, a2]'), projectYaml: 'preamble: 标题约定' });
  sb.setScenario({ a1: [{ text: plan([own]) }], a2: [change, { text: '完成' }], a3: [{ text: verdict(true) }] });
  const { engine } = await createApp({ cwd: sb.project, env: sb.env() });
  const first = await engine.submit({ task: '改标题', origin, context: '之前的结论' });
  engine.setRole('lead', 'a2', false);
  expect((await engine.approve(first.id)).status).toBe('done');
  expect(trace()[1]).toEqual(['a2', 'write', undefined]);
  const prompt = sb.calls()[1]!.prompt;
  for (const part of ['可以修改文件', '标题约定', '之前的结论', own.task, own.acceptance]) expect(prompt).toContain(part);
  expect(prompt).not.toContain('计划已确认');
});

it('出计划时改文件仍记录为只读越权', async () => {
  sb = new Sandbox({ git: true });
  sb.setScenario({ a1: [{ ...change, text: plan([]) }] });
  const r = await sb.runJson(['-p', '看看标题']);
  expect(r.json.changed_files).toEqual(['README.md']);
  expect(r.json.warnings.join(' ')).toContain('只读角色 lead（a1）改动了文件');
});

it('批准前关闭开关，整份计划在执行前停止', async () => {
  sb = new Sandbox({ git: true, resumable: true });
  sb.setScenario({ a1: [{ text: plan([{ ...own, role: 'coder' }, own]) }] });
  const pending = await sb.runJson(['-p', '修改标题']);
  fs.writeFileSync(path.join(sb.project, '.dario', 'project.yaml'), 'lead_implements: false');
  const stopped = await sb.runJson(['approve', pending.json.job_id]);
  expect(stopped.code).toBe(1);
  expect(stopped.json.conclusion).toContain('项目已关闭 lead_implements');
  expect(sb.calls()).toHaveLength(1);
});

it('主控返工达到配置的轮数上限后停止', async () => {
  sb = new Sandbox({ git: true, resumable: true, projectYaml: 'max_rework_rounds: 1' });
  sb.setScenario({
    a1: [{ text: plan([own]) }, change, { text: '已返工' }],
    a3: [{ text: verdict(false, ['标题不对']) }],
  });
  const failed = await sb.runJson(['-p', '--yes', '修改标题']);
  expect(failed.code).toBe(1);
  expect(failed.json.conclusion).toContain('已返工 1 轮，达到上限');
  expect(trace().map(call => call[1])).toEqual(['read-only', 'write', 'read-only', 'write', 'read-only']);
});

it.each([true, false])('主控会话失效或工具不支持续接时发完整任务说明（支持续接：%s）', async resumable => {
  sb = new Sandbox({ git: true, resumable, projectYaml: 'preamble: 遵循标题约定' });
  sb.setScenario({
    a1: [{ text: plan([own]) }, ...(resumable ? [{ sessionLost: true }] : []), change, { text: '完成' }],
    a3: [{ text: verdict(true) }],
  });
  const r = await sb.runJson(['-p', '--yes', '修改标题']);
  expect(r.code).toBe(0);
  const index = resumable ? 2 : 1;
  if (resumable) expect(trace()[1]).toEqual(['a1', 'write', 'a1-s0']);
  expect(trace()[index]).toEqual(['a1', 'write', undefined]);
  const prompt = sb.calls()[index]!.prompt;
  for (const part of ['可以修改文件', '遵循标题约定', own.task, own.acceptance]) expect(prompt).toContain(part);
});

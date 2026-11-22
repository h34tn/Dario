import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plan, Sandbox, verdict } from './helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox({ git: true });
});
afterEach(() => sb?.cleanup());

const names = (): string[] => sb.calls().map((c) => `${c.name}:${c.access}`);

describe('主控分派', () => {
  it('只读计划直接执行并由主控汇总', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'reviewer', task: '看一下 README 写了什么' }]) }, { text: '最终结论：README 没问题' }],
      a3: [{ text: 'README 只有一个标题' }],
    });
    const r = await sb.runJson(['看看 README']);
    expect(r.code).toBe(0);
    expect(r.json.mode).toBe('lead');
    expect(r.json.conclusion).toBe('最终结论：README 没问题');
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'review', 'summary']);
    expect(names()).toEqual(['a1:read-only', 'a3:read-only', 'a1:read-only']);
    // 主控收到了分派规则和可用角色
    const planPrompt = sb.calls()[0]!.prompt;
    expect(planPrompt).toContain('分派规则');
    expect(planPrompt).toContain('coder（实现）');
    expect(planPrompt).not.toContain('- lead');
  });

  it('主控可以直接回答，不分派', async () => {
    sb.setScenario({ a1: [{ text: '```json\n{"summary":"直接回答","answer":"答案是 42","steps":[]}\n```' }] });
    const r = await sb.runJson(['一个问题']);
    expect(r.code).toBe(0);
    expect(r.json.conclusion).toBe('答案是 42');
    expect(names()).toEqual(['a1:read-only']);
  });

  it('含改文件步骤的计划没有 --yes 时停在等待确认，approve 后继续', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '新建 src/x.txt', writes: true }]) }, { text: '汇总：已新建文件' }],
      a2: [{ text: '已新建', files: [{ path: 'src/x.txt', content: 'x' }] }],
      a3: [{ text: verdict(true) }],
    });
    const first = await sb.runJson(['-p', '新建一个文件']);
    expect(first.code).toBe(4);
    expect(first.json.status).toBe('awaiting_approval');
    expect(first.json.plan.steps).toEqual([{ role: 'coder', task: '新建 src/x.txt', writes: true, files: null, refs: null }]);
    expect(names()).toEqual(['a1:read-only']);
    expect(fs.existsSync(path.join(sb.project, 'src', 'x.txt'))).toBe(false);

    const second = await sb.runJson(['approve', first.json.job_id]);
    expect(second.code).toBe(0);
    expect(second.json.job_id).toBe(first.json.job_id);
    expect(second.json.status).toBe('done');
    expect(second.json.changed_files).toEqual(['src/x.txt']);
    expect(second.json.conclusion).toBe('汇总：已新建文件');
    // 计划里没有审查步骤，改了文件后自动追加了一步审查
    expect(second.json.steps.map((s: any) => `${s.kind}:${s.agent}`)).toEqual(['plan:a1', 'step:a2', 'review:a3', 'summary:a1']);
  });

  it('--yes 免确认直接执行', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '新建文件', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: 'ok', files: [{ path: 'y.txt', content: 'y' }] }],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '新建一个文件']);
    expect(r.code).toBe(0);
    expect(r.json.changed_files).toEqual(['y.txt']);
  });

  it('不能批准不在等待确认的任务', async () => {
    sb.setScenario({ a2: [{ text: 'ok' }] });
    const done = await sb.runJson(['--to', 'coder', '任务']);
    const r = await sb.cli(['approve', done.json.job_id]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('不在等待确认');
  });

  it('计划格式错误时让主控重出一次，仍不对则失败且不执行', async () => {
    sb.setScenario({ a1: [{ text: '我觉得应该先这样再那样（没有 JSON）' }, { text: plan([{ role: '不存在的角色', task: 'x' }]) }] });
    const r = await sb.runJson(['任务']);
    expect(r.code).toBe(1);
    expect(r.json.status).toBe('failed');
    expect(r.json.conclusion).toContain('没有给出合格的计划');
    expect(names()).toEqual(['a1:read-only', 'a1:read-only']);
    // 第二次的任务说明里带上了第一次的问题
    expect(sb.calls()[1]!.prompt).toContain('没有找到 JSON 计划');
  });

  it('第一次格式错误、第二次正确时照常执行', async () => {
    sb.setScenario({
      a1: [{ text: '没有 JSON' }, { text: plan([{ role: 'reviewer', task: '看看' }]) }, { text: '汇总' }],
      a3: [{ text: '看完了' }],
    });
    const r = await sb.runJson(['任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'plan', 'review', 'summary']);
  });

  it('只读角色不能被安排改文件的步骤', async () => {
    sb.setScenario({ a1: [{ text: plan([{ role: 'reviewer', task: '改文件', writes: true }]) }] });
    const r = await sb.runJson(['任务']);
    expect(r.code).toBe(1);
    expect(r.json.conclusion).toContain('只读');
  });

  it('后一步的任务说明里带有前一步的结论', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'reviewer', task: '第一步' }, { role: 'coder', task: '第二步' }]) }, { text: '汇总' }],
      a3: [{ text: '第一步的发现：关键信息 XYZ' }],
      a2: [{ text: '第二步完成' }],
    });
    const r = await sb.runJson(['任务']);
    expect(r.code).toBe(0);
    const second = sb.calls().find((c) => c.name === 'a2')!;
    expect(second.prompt).toContain('关键信息 XYZ');
    expect(second.prompt).toContain('第二步');
  });
});

describe('审查与返工', () => {
  const writePlan = plan([{ role: 'coder', task: '实现功能', writes: true }]);

  it('审查不通过时交回原执行者返工，再次审查通过', async () => {
    sb.setScenario({
      a1: [{ text: writePlan }, { text: '汇总：完成' }],
      a2: [
        { text: '第一版', files: [{ path: 'f.txt', content: 'v1' }] },
        { text: '改好了', files: [{ path: 'f.txt', content: 'v2-fixed' }] },
      ],
      a3: [{ text: verdict(false, ['f.txt 里缺少校验']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '实现功能']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => `${s.kind}:${s.agent}`)).toEqual(['plan:a1', 'step:a2', 'review:a3', 'rework:a2', 'review:a3', 'summary:a1']);
    const rework = sb.calls().filter((c) => c.name === 'a2')[1]!;
    expect(rework.prompt).toContain('f.txt 里缺少校验');
    expect(rework.prompt).toContain('实现功能');
    expect(fs.readFileSync(path.join(sb.project, 'f.txt'), 'utf8')).toBe('v2-fixed');
  });

  it('返工达到上限后停止并报告，退出码 1', async () => {
    sb.setScenario({
      a1: [{ text: writePlan }],
      a2: [{ text: '改了', files: [{ path: 'f.txt', content: 'v' }] }],
      a3: [{ text: verdict(false, ['还是不对']) }],
    });
    const r = await sb.runJson(['-p', '--yes', '实现功能']);
    expect(r.code).toBe(1);
    expect(r.json.status).toBe('failed');
    expect(r.json.unfinished).toContain('达到上限');
    expect(r.json.unfinished).toContain('还是不对');
    // 默认上限 2 轮：1 次执行 + 2 次返工，3 次审查
    expect(sb.calls().filter((c) => c.name === 'a2')).toHaveLength(3);
    expect(sb.calls().filter((c) => c.name === 'a3')).toHaveLength(3);
  });

  it('计划里已有审查步骤时不重复追加', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现', writes: true }, { role: 'reviewer', task: '重点看边界情况' }]) }, { text: '汇总' }],
      a2: [{ text: 'ok', files: [{ path: 'g.txt', content: '1' }] }],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '实现']);
    expect(r.code).toBe(0);
    expect(r.json.steps.filter((s: any) => s.kind === 'review')).toHaveLength(1);
    expect(sb.calls().find((c) => c.name === 'a3')!.prompt).toContain('重点看边界情况');
  });

  it('没有改文件时不追加审查', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '只是跑个检查', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: '检查通过，没有改动' }],
    });
    const r = await sb.runJson(['-p', '--yes', '跑检查']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'summary']);
  });

  it('审查没有给出明确结论时不返工，但会提示', async () => {
    sb.setScenario({
      a1: [{ text: writePlan }, { text: '汇总' }],
      a2: [{ text: 'ok', files: [{ path: 'h.txt', content: '1' }] }],
      a3: [{ text: '看起来还行吧' }],
    });
    const r = await sb.runJson(['-p', '--yes', '实现']);
    expect(r.code).toBe(0);
    expect(r.json.warnings.join('\n')).toContain('没有给出明确');
  });

  it('must_differ_from：有两家可用时审查与实现不是同一家', async () => {
    // reviewer 的首选 a3 与 coder 的执行者相同，应当避开
    sb.writeRoles(`
roles:
  lead: { candidates: [a1], access: read-only }
  coder: { candidates: [a3, a2], access: write }
  reviewer: { candidates: [a3, a2], access: read-only, must_differ_from: coder }
`);
    sb.setScenario({
      a1: [{ text: writePlan }, { text: '汇总' }],
      a3: [{ text: 'a3 实现', files: [{ path: 'i.txt', content: '1' }] }],
      a2: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '实现']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => `${s.kind}:${s.agent}`)).toEqual(['plan:a1', 'step:a3', 'review:a2', 'summary:a1']);
  });

  it('must_differ_from：只剩一家时照常执行并注明', async () => {
    sb.writeRoles(`
roles:
  lead: { candidates: [a1], access: read-only }
  coder: { candidates: [a2], access: write }
  reviewer: { candidates: [a2], access: read-only, must_differ_from: coder }
`);
    sb.setScenario({
      a1: [{ text: writePlan }, { text: '汇总' }],
      a2: [{ text: 'a2 实现', files: [{ path: 'j.txt', content: '1' }] }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '实现']);
    expect(r.code).toBe(0);
    expect(r.json.warnings.join('\n')).toContain('同一家');
  });

  it('执行中途某一步失败时停止，后面的步骤不执行', async () => {
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '第一步', writes: true }, { role: 'coder', task: '第二步', writes: true }]) }],
      a2: [{ exit: 1, stderr: 'SyntaxError: unexpected token', text: '做不下去' }],
      a3: [{ text: '不该被调用' }],
    });
    const r = await sb.runJson(['-p', '--yes', '两步任务']);
    expect(r.code).toBe(1);
    expect(r.json.unfinished).toContain('第 2 步');
    expect(sb.calls().filter((c) => c.name === 'a2')).toHaveLength(1);
  });

  it('主控不可用时计划阶段换到下一家候选', async () => {
    sb.writeRoles(`
roles:
  lead: { candidates: [a1, a2], access: read-only }
  reviewer: { candidates: [a3], access: read-only }
`);
    sb.setScenario({
      a1: [{ exit: 1, stderr: 'overloaded_error' }],
      a2: [{ text: plan([{ role: 'reviewer', task: '看看' }]) }, { text: 'a2 的汇总' }],
      a3: [{ text: '看完了' }],
    });
    const r = await sb.runJson(['任务']);
    expect(r.code).toBe(0);
    expect(r.json.fallback_happened).toBe(true);
    expect(r.json.conclusion).toBe('a2 的汇总');
  });
});

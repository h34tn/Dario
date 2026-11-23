import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseVerdict, verdictPasses } from '../src/core/plan.js';
import { countChangedLines } from '../src/core/workspace.js';
import { gitInit, plan, Sandbox, sh, verdict } from './helpers.js';

/** 审查结论，带建议。 */
function review(pass: boolean, issues: string[], suggestions: string[]): string {
  return `审查意见略。\n\n\`\`\`json\n${JSON.stringify({ verdict: pass ? 'pass' : 'fail', issues, suggestions })}\n\`\`\``;
}

describe('改动行数', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('已跟踪的文件按增加加删除算，新文件按行数算，二进制文件不算；不是 git 仓库时统计不出来', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-lines-'));
    gitInit(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n3\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'init']);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\nzwei\n3\n4\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'new.txt'), 'x\ny\nz');
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
    // a.txt：改一行（增 1 删 1）、加一行；new.txt：3 行
    expect(await countChangedLines(dir, ['a.txt', 'sub/new.txt', 'bin.dat'])).toBe(6);
    expect(await countChangedLines(dir, [])).toBe(0);
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-plain-'));
    try {
      expect(await countChangedLines(plainDir, ['a.txt'])).toBeUndefined();
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

describe('审查结论里的建议', () => {
  it('解析：没写 suggestions 时为空数组', () => {
    expect(parseVerdict(verdict(true))).toEqual({ verdict: 'pass', issues: [], suggestions: [] });
    expect(parseVerdict(review(false, ['a'], ['b']))).toEqual({ verdict: 'fail', issues: ['a'], suggestions: ['b'] });
  });

  it('算不算通过：判了 pass 却列了问题的按不通过；只有建议的 fail 按通过', () => {
    const passes = (text: string): boolean => verdictPasses(parseVerdict(text)!);
    expect(passes(review(true, [], []))).toBe(true);
    expect(passes(review(true, [], ['b']))).toBe(true);
    expect(passes(review(false, [], ['b']))).toBe(true);
    expect(passes(review(true, ['a'], []))).toBe(false);
    expect(passes(review(false, ['a'], ['b']))).toBe(false);
    expect(passes(review(false, [], []))).toBe(false);
  });
});

describe('自相矛盾的审查结论', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('判了 pass 却列了必须修改的问题：照样返工', async () => {
    sb = new Sandbox({ git: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '加一个文件', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: '写好了', files: [{ path: 'x.txt', content: '1\n' }] }, { text: '改好了', files: [{ path: 'x.txt', content: '2\n' }] }],
      a3: [{ text: review(true, ['x.txt 的内容不对'], []) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review', 'rework', 'review', 'summary']);
    expect(sb.calls().filter((c) => c.name === 'a2')[1]!.prompt).toContain('x.txt 的内容不对');
  });
});

describe('审查的取舍', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `第 ${i + 1} 行`).join('\n') + '\n';

  it('改动不超过 review_skip_max_lines 时跳过自动审查，并在注意事项里写明', async () => {
    sb = new Sandbox({ git: true, projectYaml: 'review_skip_max_lines: 5\n' });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '加一个小文件', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: '写好了', files: [{ path: 'src/x.txt', content: lines(3) }] }],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'summary']);
    expect(r.json.warnings).toContain('改动共 3 行，不超过 review_skip_max_lines（5），跳过了自动审查。');
  });

  it('超过门槛、改了允许范围之外的文件、或门槛为 0（默认）时照常审查', async () => {
    for (const [yaml, file, n] of [
      ['review_skip_max_lines: 5\n', 'src/x.txt', 6],
      ['review_skip_max_lines: 50\nwrite_roots: [src]\n', 'other/x.txt', 1],
      ['', 'src/x.txt', 1],
    ] as const) {
      sb = new Sandbox({ git: true, projectYaml: yaml || undefined });
      sb.setScenario({
        a1: [{ text: plan([{ role: 'coder', task: '加文件', writes: true }]) }, { text: '汇总' }],
        a2: [{ text: '写好了', files: [{ path: file, content: lines(n) }] }],
        a3: [{ text: verdict(true) }],
      });
      const r = await sb.runJson(['-p', '--yes', '任务']);
      expect(r.json.steps.map((s: any) => s.kind)).toContain('review');
      sb.cleanup();
    }
  });

  it('只有建议、没有必须修改的问题：不返工，建议写进注意事项交给发起人', async () => {
    sb = new Sandbox({ git: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: '写好了', files: [{ path: 'src/x.txt', content: 'x' }] }],
      a3: [{ text: review(false, [], ['边界 59 分 59.5 秒的显示可以再斟酌']) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review', 'summary']);
    expect(r.json.warnings.join('\n')).toContain('审查的建议（没有要求返工，由你决定）：\n    1. 边界 59 分 59.5 秒的显示可以再斟酌');
  });

  it('有必须修改的问题时照常返工，建议同样写进注意事项', async () => {
    sb = new Sandbox({ git: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: '写好了', files: [{ path: 'src/x.txt', content: 'x' }] }, { text: '改好了', files: [{ path: 'src/x.txt', content: 'y' }] }],
      a3: [{ text: review(false, ['少了校验'], ['命名可以更清楚']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review', 'rework', 'review', 'summary']);
    expect(r.json.warnings.join('\n')).toContain('命名可以更清楚');
  });
});

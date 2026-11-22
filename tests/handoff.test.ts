import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffText, normalizeRefs, parseRef, readRefs } from '../src/core/handoff.js';
import { parsePlan } from '../src/core/plan.js';
import { gitInit, plan, Sandbox, sh, verdict } from './helpers.js';

const numbered = (n: number, tag = '行'): string => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

describe('代码位置的写法', () => {
  it('文件、文件:行、文件:起-止，起止写反了也认；路径整理成相对、正斜杠', () => {
    expect(parseRef('src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(parseRef('./src\\a.ts:12')).toEqual({ path: 'src/a.ts', start: 12, end: 12 });
    expect(parseRef('src/a.ts:30-10')).toEqual({ path: 'src/a.ts', start: 10, end: 30 });
    expect(parseRef(' :12 ')).toBeUndefined();
    expect(normalizeRefs(['src/a.ts:1-5', './src/a.ts:1-5', '', 'b.md:3-3'])).toEqual(['src/a.ts:1-5', 'b.md:3']);
  });

  it('计划解析时保留 refs，只读步骤也可以有', () => {
    const roles = { resolve: (r: string) => r, ids: () => ['lead', 'coder', 'tester'], get: (id: string) => ({ access: id === 'tester' ? 'read-only' : 'write' }) } as any;
    const parsed = parsePlan(plan([{ role: 'coder', task: '改', writes: true, refs: ['./src/a.ts:3-1'] }, { role: 'tester', task: '测', refs: ['tests/a.test.ts'] }]), {
      roles,
      leadRole: 'lead',
      leadImplements: true,
      maxPlanSteps: 8,
    });
    expect('plan' in parsed && parsed.plan.steps.map((s) => s.refs)).toEqual([['src/a.ts:1-3'], ['tests/a.test.ts']]);
  });
});

describe('读出主控标出的代码', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-refs-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), numbered(50));
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('按行号取出当前内容，标明位置；读不出来的列出来', () => {
    const text = readRefs(dir, ['src/a.ts:10-12', 'src/a.ts:7', 'nope.ts', 'bin.dat', '../outside.ts', 'src/a.ts:80-90'], 20000)!;
    expect(text).toContain('## src/a.ts 第 10-12 行\n```\n行 10\n行 11\n行 12\n```');
    expect(text).toContain('## src/a.ts 第 7 行\n```\n行 7\n```');
    expect(text).not.toContain('行 13');
    expect(text).toContain('读不出来（文件不存在、行号超出范围、二进制文件或在项目目录之外）：nope.ts、bin.dat、../outside.ts、src/a.ts:80-90');
  });

  it('前面的步骤改过的文件注明行号可能偏移；内容里有反引号时围栏加长', () => {
    fs.writeFileSync(path.join(dir, 'src', 'b.md'), 'x\n```js\ny\n```\n');
    const text = readRefs(dir, ['src/b.md', 'src/a.ts:1-2'], 20000, ['src/a.ts'])!;
    expect(text).toContain('## src/b.md 全文\n````\nx\n```js\ny\n```\n````');
    expect(text).toContain('## src/a.ts 第 1-2 行（前面的步骤改过这个文件，行号可能已有偏移');
  });

  it('超出长度上限：剩下的地方够就截断附上开头，不够只列名字；上限为 0 不附', () => {
    fs.writeFileSync(path.join(dir, 'big.txt'), numbered(2000, '长内容'));
    const text = readRefs(dir, ['src/a.ts:1-3', 'big.txt', 'src/a.ts:40-41'], 3000)!;
    expect(text).toContain('行 1\n行 2\n行 3');
    expect(text).toContain('（超出长度上限，后面的内容没有附上，请自己打开文件看）');
    expect(text).toContain('超出长度上限没有附上：src/a.ts:40-41');
    expect(text.length).toBeLessThan(3600);
    expect(readRefs(dir, ['src/a.ts:1-3'], 0)).toBeUndefined();
    expect(readRefs(dir, [], 20000)).toBeUndefined();
  });
});

describe('给审查的 diff', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-diff-'));
    gitInit(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n3\n');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('已跟踪文件的改动和删除、未跟踪的新文件、二进制文件都列出', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\nzwei\n3\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'new.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
    const d = (await diffText(dir, ['a.txt', 'gone.txt', 'sub/new.txt', 'bin.dat'], 20000))!;
    expect(d.omitted).toEqual([]);
    expect(d.text.startsWith('```diff\n')).toBe(true);
    expect(d.text).toContain('-2\n+zwei');
    expect(d.text).toContain('-bye');
    expect(d.text).toContain('+++ b/sub/new.txt\n@@ -0,0 +1,2 @@\n+x\n+y');
    expect(d.text).toContain('（二进制文件，3 字节）');
  });

  it('超出长度上限：放得下的文件完整附上，第一个放不下的附开头，其余只列名字', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\nzwei\n3\n');
    fs.writeFileSync(path.join(dir, 'big.txt'), numbered(3000));
    fs.writeFileSync(path.join(dir, 'z.txt'), 'z\n');
    const d = (await diffText(dir, ['a.txt', 'big.txt', 'z.txt'], 4000))!;
    expect(d.text).toContain('+zwei');
    expect(d.text).toContain('+行 1\n');
    expect(d.text).toContain('（这个文件的 diff 超出长度上限，后面没有附上）');
    expect(d.text).not.toContain('+z\n');
    expect(d.omitted).toEqual(['big.txt', 'z.txt']);
    expect(d.text.length).toBeLessThan(4100);
  });

  it('没有改动、上限为 0、不是 git 仓库时不附', async () => {
    expect(await diffText(dir, ['a.txt'], 20000)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    expect(await diffText(dir, ['a.txt'], 0)).toBeUndefined();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dario-plain-'));
    try {
      fs.writeFileSync(path.join(plain, 'a.txt'), 'x\n');
      expect(await diffText(plain, ['a.txt'], 20000)).toBeUndefined();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('交接时附上上下文', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('执行者拿到主控标出的代码，审查拿到 diff 并被告知不必逐个重读', async () => {
    sb = new Sandbox({ git: true });
    fs.mkdirSync(path.join(sb.project, 'src'));
    fs.writeFileSync(path.join(sb.project, 'src', 'calc.ts'), numbered(30, 'const v'));
    sh(sb.project, 'git', ['add', '-A']);
    sh(sb.project, 'git', ['commit', '-q', '-m', 'calc']);
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '把第 5 行改掉', writes: true, refs: ['src/calc.ts:4-6'] }]) }, { text: '汇总' }],
      a2: [{ text: '改好了', files: [{ path: 'src/calc.ts', content: numbered(30, 'const v').replace('const v 5\n', 'const v 五\n') }] }],
      a3: [{ text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    expect(r.json.plan.steps[0].refs).toEqual(['src/calc.ts:4-6']);
    const [lead, coder, reviewer] = sb.calls();
    expect(lead!.prompt).toContain('- refs 列出你已经读过');
    expect(coder!.prompt).toContain('# 主控标出的相关代码');
    expect(coder!.prompt).toContain('## src/calc.ts 第 4-6 行\n```\nconst v 4\nconst v 5\nconst v 6\n```');
    // 代码接在任务后面、验收标准之前，任务说明本身不变
    expect(coder!.prompt.indexOf('# 任务\n把第 5 行改掉')).toBeLessThan(coder!.prompt.indexOf('# 主控标出的相关代码'));
    expect(reviewer!.prompt).toContain('# 改动的 diff');
    expect(reviewer!.prompt).toContain('-const v 5\n+const v 五');
    expect(reviewer!.prompt).toContain('不必为了确认改了什么逐个重读');
    expect(reviewer!.prompt).not.toContain('请实际阅读改动的文件');
  });

  it('handoff_max_chars 为 0 时照旧：不附代码和 diff，审查自己读文件', async () => {
    sb = new Sandbox({ git: true, projectYaml: 'handoff_max_chars: 0\n' });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '改 README', writes: true, refs: ['README.md:1'] }]) }, { text: '汇总' }],
      a2: [{ text: '改好了', files: [{ path: 'README.md', content: '# 新标题\n' }] }],
      a3: [{ text: verdict(true) }],
    });
    await sb.runJson(['-p', '--yes', '任务']);
    const [lead, coder, reviewer] = sb.calls();
    // 不附也就不要求主控写 refs
    expect(lead!.prompt).not.toContain('refs');
    expect(coder!.prompt).not.toContain('主控标出的相关代码');
    expect(reviewer!.prompt).not.toContain('改动的 diff');
    expect(reviewer!.prompt).toContain('请实际阅读改动的文件');
  });

  it('开工前就有未提交改动的文件，diff 里说明不全是这次任务改的', async () => {
    sb = new Sandbox({ git: true });
    fs.writeFileSync(path.join(sb.project, 'README.md'), '# 测试项目\n用户自己先改了一行\n');
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '改 README', writes: true }]) }, { text: '汇总' }],
      a2: [{ text: '改好了', files: [{ path: 'README.md', content: '# 测试项目\n用户自己先改了一行\n任务加的一行\n' }] }],
      a3: [{ text: verdict(true) }],
    });
    await sb.runJson(['-p', '--yes', '任务']);
    const reviewer = sb.calls()[2]!;
    expect(reviewer.prompt).toContain('其中 README.md 在任务开始前就有未提交的改动');
  });

  it('返工后续接审查会话：只附它上次审查之后改过的文件的 diff', async () => {
    sb = new Sandbox({ git: true, resumable: true });
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现', writes: true }]) }, { text: '汇总' }],
      a2: [
        { text: '写好了', files: [{ path: 'src/a.txt', content: 'a1\n' }, { path: 'src/b.txt', content: 'b1\n' }] },
        { text: '改好了', files: [{ path: 'src/b.txt', content: 'b2\n' }] },
      ],
      a3: [{ text: verdict(false, ['b 不对']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.json.steps.map((s: any) => s.kind)).toEqual(['plan', 'step', 'review', 'rework', 'review', 'summary']);
    const reviews = sb.calls().filter((c) => c.name === 'a3');
    expect(reviews[0]!.prompt).toContain('+a1');
    expect(reviews[1]!.prompt).toContain('# 这些文件现在的 diff');
    expect(reviews[1]!.prompt).toContain('+b2');
    expect(reviews[1]!.prompt).not.toContain('+a1');
  });
});

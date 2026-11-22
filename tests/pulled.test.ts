import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { plan, Sandbox, sh, verdict } from './helpers.js';

const TITLE = '开工前从远端拉取的更新';

/** 给沙箱的项目接上一个远端，再由"同事"往远端推一个改了 src/new.txt 的提交。 */
function remoteAdvances(sb: Sandbox): void {
  const origin = path.join(sb.dir, 'origin.git');
  const theirs = path.join(sb.dir, 'theirs');
  fs.mkdirSync(origin);
  sh(origin, 'git', ['init', '-q', '--bare', '-b', 'main']);
  sh(sb.project, 'git', ['remote', 'add', 'origin', origin]);
  sh(sb.project, 'git', ['push', '-q', '-u', 'origin', 'main']);
  sh(sb.dir, 'git', ['clone', '-q', origin, theirs]);
  sh(theirs, 'git', ['config', 'user.name', 'theirs']);
  sh(theirs, 'git', ['config', 'user.email', 'theirs@example.com']);
  sh(theirs, 'git', ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(theirs, 'src'));
  fs.writeFileSync(path.join(theirs, 'src', 'new.txt'), '同事的改动\n');
  sh(theirs, 'git', ['add', '-A']);
  sh(theirs, 'git', ['commit', '-q', '-m', 'feat: 同事的改动']);
  sh(theirs, 'git', ['push', '-q']);
}

describe('开工前拉下来的文件告诉各角色', () => {
  let sb: Sandbox;
  afterEach(() => sb?.cleanup());

  it('每个角色在本任务里第一次上场时收到清单，同一任务里续接时不再重复', async () => {
    sb = new Sandbox({ git: true, resumable: true, projectYaml: 'sync_before_task: pull\n' });
    remoteAdvances(sb);
    sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '实现', writes: true }]) }, { text: '汇总' }],
      a2: [
        { text: '第一版', files: [{ path: 'f.txt', content: 'v1' }] },
        { text: '改好了', files: [{ path: 'f.txt', content: 'v2' }] },
      ],
      a3: [{ text: verdict(false, ['缺少校验']) }, { text: verdict(true) }],
    });
    const r = await sb.runJson(['-p', '--yes', '任务']);
    expect(r.code).toBe(0);
    // Windows 上检出可能把换行转成 CRLF，只比内容
    expect(fs.readFileSync(path.join(sb.project, 'src', 'new.txt'), 'utf8').trim()).toBe('同事的改动');

    const calls = sb.calls().map((c) => `${c.name}:${c.prompt.includes(TITLE) && c.prompt.includes('- src/new.txt') ? '有清单' : '无'}`);
    // 计划、执行、第一次审查是各自的第一次上场；返工、再审、汇总都是续接
    expect(calls).toEqual(['a1:有清单', 'a2:有清单', 'a3:有清单', 'a2:无', 'a3:无', 'a1:无']);
    expect(sb.calls()[1]!.prompt).toContain('从 origin/main 拉取了 1 个提交');
    expect(sb.calls()[1]!.prompt).toContain('先让它们完成刷新或重新编译');
  });

  it('没有拉到新提交时不出现这一节', async () => {
    sb = new Sandbox({ git: true, projectYaml: 'sync_before_task: pull\n' });
    remoteAdvances(sb);
    sh(sb.project, 'git', ['pull', '-q', '--rebase']);
    sb.setScenario({ a2: [{ text: '做完了' }] });
    const r = await sb.runJson(['--to', 'coder', '任务']);
    expect(r.code).toBe(0);
    expect(sb.calls()[0]!.prompt).not.toContain(TITLE);
  });
});

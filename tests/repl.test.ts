import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runRepl } from '../src/cli/repl.js';
import { createApp } from '../src/compose.js';
import { plan, Sandbox, verdict } from './helpers.js';

let sb: Sandbox;
afterEach(() => sb?.cleanup());

/** 把几行输入喂给交互方式，返回它输出的全部内容。 */
async function session(lines: string[]): Promise<string> {
  const app = await createApp({ cwd: sb.project, env: sb.env() });
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const out: string[] = [];
  const done = runRepl(app.engine, (line) => out.push(line), { input, output });
  input.end(`${lines.join('\n')}\n`);
  expect(await done).toBe(0);
  return out.join('\n');
}

describe('交互方式', () => {
  it('指令与任务都能用，/exit 退出', async () => {
    sb = new Sandbox();
    sb.setScenario({ a2: [{ text: '任务做完了' }] });
    const text = await session(['/roles', '/nonsense', '/to 实现 做点事', '/status', '/exit', '/to 实现 不该执行']);
    expect(text).toContain('实现（coder）');
    expect(text).toContain('不认识的指令');
    expect(text).toContain('任务做完了');
    expect(text).toMatch(/J0001 完成/);
    expect(sb.calls()).toHaveLength(1);
  });

  it('逐行交互的 /agents 在每家 AI 的行末显示额度', async () => {
    const disabled = { enabled: false };
    sb = new Sandbox({ agentsExtra: { agents: {
      claude: disabled, codex: disabled, codebuddy: disabled, deepseek: disabled, a2: { free: true },
    } } });
    const text = await session(['/agents']);
    expect(text).toMatch(/^a1.* · 额度未知$/m);
    expect(text).toMatch(/^a2.* · 额度 0%（免费）$/m);
  });

  it('输入流结束时正常退出', async () => {
    sb = new Sandbox();
    expect(await session(['/help'])).toContain('/to <角色> <任务>');
  });

  it('含改文件的计划当场询问，回答 y 才执行', async () => {
    sb = new Sandbox({ git: true });
    const scenario = {
      a1: [{ text: plan([{ role: 'coder', task: '新建 z.txt', writes: true }]) }, { text: '汇总：好了' }],
      a2: [{ text: 'ok', files: [{ path: 'z.txt', content: 'z' }] }],
      a3: [{ text: verdict(true) }],
    };
    sb.setScenario(scenario);
    const declined = await session(['新建一个文件', 'n']);
    expect(declined).toContain('这份计划会改动文件');
    expect(declined).toContain('已取消');
    expect(sb.calls().map((c) => c.name)).toEqual(['a1']);

    sb.setScenario(scenario);
    const accepted = await session(['新建一个文件', 'y']);
    expect(accepted).toContain('汇总：好了');
    expect(sb.calls().map((c) => c.name)).toEqual(['a1', 'a2', 'a3', 'a1']);
  });

  it('换人指令立即生效', async () => {
    sb = new Sandbox();
    sb.setScenario({ a3: [{ text: 'a3 做的' }] });
    const text = await session(['/role coder a3', '/to coder 任务', '/role coder reset']);
    expect(text).toContain('临时改由 a3');
    expect(text).toContain('a3 做的');
    expect(text).toContain('已恢复为角色表里的顺序');
  });
});

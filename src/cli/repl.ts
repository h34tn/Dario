import os from 'node:os';
import readline from 'node:readline';
import { HELP_TEXT, parseCommand } from '../core/commands.js';
import type { Engine } from '../core/engine.js';
import { describePlan } from '../core/orchestrator.js';
import { formatFallbackQuestion, formatJob, formatRoles } from '../core/report.js';
import { STATUS_LABEL, type FallbackQuestion } from '../core/types.js';
import { DarioError, ellipsis } from '../core/util.js';

export interface ReplStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** 逐行交互：直接输入文字是下达任务，以 / 开头是指令。指令与其他渠道相同。 */
export async function runRepl(
  engine: Engine,
  out: (line: string) => void,
  streams: ReplStreams = { input: process.stdin, output: process.stdout },
): Promise<number> {
  const rl = readline.createInterface({ input: streams.input, output: streams.output });
  // 用行迭代器读取：输入流关闭时自然结束，不会卡在等待输入上
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });
  const readLine = async (prompt: string): Promise<string | undefined> => {
    rl.setPrompt(prompt);
    // 输入来自管道且已读完时接口已关闭，剩下的行仍在迭代器里，不能再显示提示符
    if (!closed) rl.prompt();
    const next = await lines.next();
    return next.done ? undefined : next.value;
  };

  const off = engine.onProgress((e) => {
    if (e.kind === 'activity' || e.kind === 'usage') return;
    if (e.kind === 'plan') out(`[${e.jobId}] 计划：\n${e.text}`);
    else out(`[${e.jobId}] ${e.text}`);
  });
  const confirmFallback = async (q: FallbackQuestion): Promise<boolean> => {
    out(`[${q.jobId}] ${formatFallbackQuestion(q)[0]}`);
    const answer = ((await readLine(`${formatFallbackQuestion(q)[1]}(y/N) `)) ?? '').trim().toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === '确认';
  };
  const origin = { channel: 'terminal', senderId: os.userInfo().username };
  out('Dario 交互方式。直接输入任务，或输入 /help 查看指令，/exit 退出。');

  try {
    for (;;) {
      const raw = await readLine('dario> ');
      if (raw === undefined) break;
      const line = raw.trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      try {
        const cmd = parseCommand(line);
        switch (cmd.kind) {
          case 'invalid':
            out(cmd.message);
            break;
          case 'help':
            out(`${HELP_TEXT}\n/exit                  退出`);
            break;
          case 'roles':
            out(formatRoles(await engine.rolesView(), engine.roles.fallback));
            break;
          case 'agents':
            for (const a of await engine.agentsView()) {
              const st = !a.enabled ? '已停用' : !a.installed ? '未安装' : a.unavailable ? `暂时不可用（${a.unavailable}）` : '可用';
              out(`${a.id}${a.model ? `（${a.model}）` : ''}：${st}${a.version ? ` · ${a.version}` : ''}`);
            }
            break;
          case 'role':
            out(cmd.reset ? engine.resetRole(cmd.role) : engine.setRole(cmd.role, cmd.agent!, cmd.save));
            break;
          case 'health':
            out('正在检查，会实际调用一次 AI…');
            for (const r of await engine.health(cmd.agent)) out(`${r.agent}：${r.ok ? '可用' : '不可用'} — ${r.detail}`);
            break;
          case 'status':
            if (cmd.jobId) out(formatJob(engine.job(cmd.jobId)));
            else for (const j of engine.jobs(10)) out(`${j.id} ${STATUS_LABEL[j.status]} · ${ellipsis(j.task, 50)}`);
            break;
          case 'cancel':
            if (!cmd.jobId) out('用法：/cancel <任务号>');
            else out(`[${engine.cancel(cmd.jobId).id}] 已取消。`);
            break;
          case 'approve':
            if (!cmd.jobId) out('用法：/approve <任务号>');
            else out(formatJob(await engine.approve(cmd.jobId, { confirmFallback })));
            break;
          case 'pause':
          case 'resume':
            out('这个指令只在常驻运行的渠道里有意义。');
            break;
          case 'task': {
            const job = await engine.submit({
              task: cmd.text,
              role: cmd.role,
              origin,
              confirmFallback,
              confirm: async (j) => {
                out(`[${j.id}] 这份计划会改动文件：\n${j.plan ? describePlan(j.plan, engine.roles) : ''}`);
                const answer = ((await readLine('执行吗？(y/N) ')) ?? '').trim().toLowerCase();
                return answer === 'y' || answer === 'yes' || answer === '确认';
              },
            });
            out(formatJob(job));
            break;
          }
        }
      } catch (e) {
        if (e instanceof DarioError) out(e.message);
        else out(`出错：${(e as Error).message}`);
      }
    }
  } finally {
    off();
    rl.close();
  }
  return 0;
}

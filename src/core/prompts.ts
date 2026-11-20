import type { ProjectConfig, RoleDef } from './config.js';
import type { RoleBook } from './roles.js';
import type { Access, Job, StepRecord } from './types.js';
import { truncate } from './util.js';

const CONTEXT_CHARS = 4000;

function rules(access: Access, project: ProjectConfig): string {
  const lines = ['- 不要执行 git commit、git push，不要切换或新建分支。'];
  if (access === 'write') {
    lines.push('- 只修改完成任务所必需的文件。');
    if (project.settings.writeRoots.length > 0) {
      lines.push(`- 只允许改动这些目录：${project.settings.writeRoots.join('、')}。`);
    }
    lines.push('- 完成后在回复末尾列出：改动文件清单（没有则写"无"）、存疑点（没有则写"无"）。');
  } else {
    lines.push('- 你处于只读方式：不要创建、修改或删除任何文件。');
  }
  const extra = project.settings.preamble.trim();
  return extra ? `${lines.join('\n')}\n${extra}` : lines.join('\n');
}

function roleHeader(role: RoleDef, access: Access): string {
  const name = role.alias[0] ? `「${role.alias[0]}」（${role.id}）` : `「${role.id}」`;
  const desc = role.description ? `\n${role.description}` : '';
  return `你现在担任${name}这个角色，权限：${access === 'write' ? '可以修改文件' : '只读'}。${desc}`;
}

function section(title: string, body: string | undefined): string {
  return body && body.trim() ? `\n\n# ${title}\n${body.trim()}` : '';
}

/** 已完成各步的摘要，附在后续步骤的任务说明里。 */
export function priorSteps(job: Job): string {
  const done = job.steps.filter((s) => s.kind !== 'plan' && s.outcome === 'ok');
  if (done.length === 0) return '';
  return done
    .map((s) => `## 第 ${s.index + 1} 步（${s.role}，由 ${s.agent} 完成）\n${truncate(s.text, CONTEXT_CHARS)}`)
    .join('\n\n');
}

export function stepPrompt(project: ProjectConfig, role: RoleDef, access: Access, task: string, context?: string, acceptance?: string): string {
  return (
    `# 你的角色\n${roleHeader(role, access)}` +
    section('工作规则', rules(access, project)) +
    section('上文', context) +
    section('任务', task) +
    section('验收标准', acceptance)
  );
}

export function planPrompt(project: ProjectConfig, roles: RoleBook, task: string, context?: string, feedback?: string): string {
  const available = roles
    .ids()
    .filter((id) => id !== project.settings.leadRole)
    .map((id) => {
      const r = roles.get(id);
      const alias = r.alias.length ? `（${r.alias.join('、')}）` : '';
      return `- ${id}${alias}：${r.access === 'write' ? '可写' : '只读'}。${r.description ?? ''}`;
    })
    .join('\n');
  const format = [
    '先用几句话说明思路，然后在回复的**最后**输出一个 JSON 代码块，格式如下：',
    '```json',
    '{"summary":"一句话概括计划","answer":null,"steps":[{"role":"角色 id","task":"交给该角色的完整任务说明","writes":true,"acceptance":"验收标准"}]}',
    '```',
    '规则：',
    '- 如果任务只是提问、不需要分派给别人，把答案写在 answer 里，steps 留空数组。',
    '- role 必须是"可用角色"里的 id；writes 为 true 的步骤只能交给可写的角色。',
    `- 步骤不超过 ${project.settings.maxPlanSteps} 个，不要把主控自己列为步骤。`,
    '- 每一步的 task 必须自包含：写清背景、要做什么、涉及哪些文件。执行者看不到本次对话，也看不到其他步骤的说明。',
    '- writes 表示这一步是否会创建、修改或删除文件，请如实填写。',
  ].join('\n');
  return (
    `# 你的角色\n你是主控。阅读任务和项目，判断如何完成，并输出一份计划。` +
    `你现在处于只读方式：不要修改任何文件，也不要自己去完成需要改文件的工作。` +
    section('可用角色', available) +
    section('分派规则', project.dispatchRules) +
    section('输出格式', format) +
    section('上文', context) +
    section('任务', task) +
    section('上一次输出的问题（请修正后重新输出完整计划）', feedback)
  );
}

export function reviewPrompt(project: ProjectConfig, role: RoleDef, job: Job, extraTask?: string): string {
  const files = job.changedFiles.length ? job.changedFiles.map((f) => `- ${f}`).join('\n') : '（未能自动检测，请用 git status 与 git diff 查看）';
  const format = [
    '先写审查意见，然后在回复的**最后**输出一个 JSON 代码块给出结论：',
    '```json',
    '{"verdict":"pass","issues":[]}',
    '```',
    'verdict 只能是 pass（可以接受）或 fail（必须修改）。fail 时在 issues 里逐条写明要改什么，每条都要具体到文件和问题。',
    '只因为会导致错误结果、违反任务要求或明显缺陷才判 fail；风格偏好写进意见但不要因此判 fail。',
  ].join('\n');
  return (
    `# 你的角色\n${roleHeader(role, 'read-only')}` +
    section('工作规则', rules('read-only', project)) +
    section('原始任务', job.task) +
    section('已完成的工作', priorSteps(job)) +
    section('本次改动的文件', files) +
    section('审查要求', extraTask ?? '审查上面的改动是否正确、完整地完成了原始任务。请实际阅读改动的文件。') +
    section('输出格式', format)
  );
}

export function reworkPrompt(project: ProjectConfig, role: RoleDef, originalTask: string, issues: string[], reviewText: string): string {
  const list = issues.length ? issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : truncate(reviewText, CONTEXT_CHARS);
  return (
    `# 你的角色\n${roleHeader(role, 'write')}` +
    section('工作规则', rules('write', project)) +
    section('原任务', originalTask) +
    section('审查没有通过，需要修改的问题', list) +
    section('任务', '逐条修正上面的问题。只改与这些问题有关的内容，不要顺带做别的改动。')
  );
}

export function summaryPrompt(job: Job, steps: StepRecord[]): string {
  const body = steps
    .filter((s) => s.kind !== 'plan')
    .map((s) => {
      const who = s.agent ? `由 ${s.agent} 完成` : '未能执行';
      const state = s.outcome === 'ok' ? '' : `（结果：${s.outcome}${s.reason ? `，${s.reason}` : ''}）`;
      return `## 第 ${s.index + 1} 步 ${s.kind}（${s.role}，${who}）${state}\n${truncate(s.text, CONTEXT_CHARS)}`;
    })
    .join('\n\n');
  return (
    `# 你的角色\n你是主控。下面是你之前安排的各个步骤的执行结果。你处于只读方式，不要修改任何文件。` +
    section('原始任务', job.task) +
    section('各步结果', body) +
    section('改动的文件', job.changedFiles.map((f) => `- ${f}`).join('\n')) +
    section(
      '任务',
      '给发起人写一段最终结论：任务是否完成、做了什么、有哪些遗留问题或需要人确认的地方。直接写结论，不要复述过程，不要输出 JSON。',
    )
  );
}

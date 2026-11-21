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

/** 已完成各步的摘要，附在后续步骤的任务说明里。after 给出时只取下标在它之后的步骤。 */
export function priorSteps(job: Job, after = -1): string {
  const done = job.steps.filter((s) => s.index > after && s.kind !== 'plan' && s.outcome === 'ok');
  if (done.length === 0) return '';
  return done
    .map((s) => `## 第 ${s.index + 1} 步（${s.role}，由 ${s.agent} 完成）\n${truncate(s.text, CONTEXT_CHARS)}`)
    .join('\n\n');
}

/**
 * 续接用的增量说明：下面几个 xxxFollowUp 与同名的 xxxPrompt 一一对应，发给已经做过本任务前几轮的同一个会话。
 * 会话里已有的内容（原始任务、它自己做过的事）不再重复；它上次发言之后别人做了什么、改了哪些文件必须补上。
 * 角色、权限和工作规则每次都重申：会话历史可能被工具压缩，这几行不能丢。
 */
function continueHeader(role: RoleDef, access: Access, what: string): string {
  const name = role.alias[0] ? `「${role.alias[0]}」（${role.id}）` : `「${role.id}」`;
  return `# 你的角色\n你继续担任${name}这个角色，权限：${access === 'write' ? '可以修改文件' : '只读'}。${what}之前的对话仍然有效。`;
}

/**
 * 发给从上一个任务带过来的会话：它熟悉项目，但不知道这个新任务，所以完整的任务说明照发，只在前面交代一句。
 * 完整说明里的角色、规则和输出格式不省：这些篇幅很小，而会话历史随时可能被工具压缩。
 */
export function carriedPrompt(full: string): string {
  return (
    '# 续接说明\n这是同一次会话里的新任务。之前的对话仍然有效，你对这个项目已有的了解可以直接用。' +
    '距离你上次工作，项目里的文件可能已经被其他角色或用户改动，用到时请重新读取，不要依赖记忆里的内容。' +
    '下面是新任务的完整说明，角色、权限和规则以这里为准。\n\n' +
    full
  );
}

/** 某一步之后被改动的文件。会话记得的是旧内容，必须提醒它重新读取。 */
function staleFiles(job: Job, after: number): string | undefined {
  const files = [...new Set(job.steps.filter((s) => s.index > after).flatMap((s) => s.changedFiles))].sort();
  if (files.length === 0) return undefined;
  return `${files.map((f) => `- ${f}`).join('\n')}\n这些文件的内容已经和你记得的不一样，用到时请重新读取。`;
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

/** after 是这个会话最近一次工作的步骤下标。 */
export function stepFollowUp(project: ProjectConfig, role: RoleDef, access: Access, task: string, job: Job, after: number, acceptance?: string): string {
  return (
    continueHeader(role, access, '这是同一个任务里交给你的下一步，') +
    section('工作规则', rules(access, project)) +
    section('你上次工作之后其他步骤的结果', priorSteps(job, after)) +
    section('你上次工作之后被改动的文件', staleFiles(job, after)) +
    section('任务', task) +
    section('验收标准', acceptance)
  );
}

export function planFollowUp(feedback: string): string {
  return (
    `# 你的角色\n你仍然是主控，仍处于只读方式。你上一次输出的计划不合格，需要重出。之前的对话仍然有效。` +
    section('上一次输出的问题', feedback) +
    section('任务', '修正上面的问题，重新输出完整计划：先用几句话说明思路，然后在回复的**最后**输出一个 JSON 代码块，字段与规则同之前说明的输出格式。')
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

const UNDETECTED_FILES = '（未能自动检测，请用 git status 与 git diff 查看）';

const REVIEW_FORMAT = [
  '先写审查意见，然后在回复的**最后**输出一个 JSON 代码块给出结论：',
  '```json',
  '{"verdict":"pass","issues":[]}',
  '```',
  'verdict 只能是 pass（可以接受）或 fail（必须修改）。fail 时在 issues 里逐条写明要改什么，每条都要具体到文件和问题。',
  '只因为会导致错误结果、违反任务要求或明显缺陷才判 fail；风格偏好写进意见但不要因此判 fail。',
].join('\n');

export function reviewPrompt(project: ProjectConfig, role: RoleDef, job: Job, extraTask?: string): string {
  const files = job.changedFiles.length ? job.changedFiles.map((f) => `- ${f}`).join('\n') : UNDETECTED_FILES;
  return (
    `# 你的角色\n${roleHeader(role, 'read-only')}` +
    section('工作规则', rules('read-only', project)) +
    section('原始任务', job.task) +
    section('已完成的工作', priorSteps(job)) +
    section('本次改动的文件', files) +
    section('审查要求', extraTask ?? '审查上面的改动是否正确、完整地完成了原始任务。请实际阅读改动的文件。') +
    section('输出格式', REVIEW_FORMAT)
  );
}

/** after 是这个会话上一次审查的步骤下标。 */
export function reviewFollowUp(project: ProjectConfig, role: RoleDef, job: Job, after: number, extraTask?: string): string {
  const recheck = '审查你上次审查之后的改动是否正确、完整地完成了原始任务；你上一轮提出过问题的，逐条确认是否已经解决，并确认修改没有引入新的问题。请实际阅读改动的文件。';
  return (
    continueHeader(role, 'read-only', '这是同一个任务的又一轮审查，') +
    section('工作规则', rules('read-only', project)) +
    section('你上次审查之后完成的工作', priorSteps(job, after)) +
    section('你上次审查之后被改动的文件', staleFiles(job, after) ?? UNDETECTED_FILES) +
    section('审查要求', extraTask ? `${extraTask}\n${recheck}` : recheck) +
    section('输出格式', REVIEW_FORMAT)
  );
}

function issueList(issues: string[], reviewText: string): string {
  return issues.length ? issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : truncate(reviewText, CONTEXT_CHARS);
}

const REWORK_TASK = '逐条修正上面的问题。只改与这些问题有关的内容，不要顺带做别的改动。';

export function reworkPrompt(project: ProjectConfig, role: RoleDef, originalTask: string, issues: string[], reviewText: string): string {
  return (
    `# 你的角色\n${roleHeader(role, 'write')}` +
    section('工作规则', rules('write', project)) +
    section('原任务', originalTask) +
    section('审查没有通过，需要修改的问题', issueList(issues, reviewText)) +
    section('任务', REWORK_TASK)
  );
}

/** after 是这个会话最近一次工作的步骤下标。原任务已经在会话里，不再重复。 */
export function reworkFollowUp(project: ProjectConfig, role: RoleDef, job: Job, after: number, issues: string[], reviewText: string): string {
  return (
    continueHeader(role, 'write', '你之前完成的工作没有通过审查，需要返工，') +
    section('工作规则', rules('write', project)) +
    section('审查没有通过，需要修改的问题', issueList(issues, reviewText)) +
    section('你上次工作之后被改动的文件', staleFiles(job, after)) +
    section('任务', REWORK_TASK)
  );
}

function stepResults(steps: StepRecord[]): string {
  return steps
    .filter((s) => s.kind !== 'plan')
    .map((s) => {
      const who = s.agent ? `由 ${s.agent} 完成` : '未能执行';
      const state = s.outcome === 'ok' ? '' : `（结果：${s.outcome}${s.reason ? `，${s.reason}` : ''}）`;
      return `## 第 ${s.index + 1} 步 ${s.kind}（${s.role}，${who}）${state}\n${truncate(s.text, CONTEXT_CHARS)}`;
    })
    .join('\n\n');
}

const SUMMARY_TASK = '给发起人写一段最终结论：任务是否完成、做了什么、有哪些遗留问题或需要人确认的地方。直接写结论，不要复述过程，不要输出 JSON。';

export function summaryPrompt(job: Job, steps: StepRecord[]): string {
  return (
    `# 你的角色\n你是主控。下面是你之前安排的各个步骤的执行结果。你处于只读方式，不要修改任何文件。` +
    section('原始任务', job.task) +
    section('各步结果', stepResults(steps)) +
    section('改动的文件', job.changedFiles.map((f) => `- ${f}`).join('\n')) +
    section('任务', SUMMARY_TASK)
  );
}

/** 发给出计划的那个会话：原始任务和计划它都记得，只补各步的执行结果。 */
export function summaryFollowUp(job: Job, steps: StepRecord[]): string {
  return (
    `# 你的角色\n你仍然是主控。你出的计划已经执行结束，下面是各步的执行结果。你处于只读方式，不要修改任何文件，也不要再输出计划。之前的对话仍然有效。` +
    section('各步结果', stepResults(steps)) +
    section('改动的文件', job.changedFiles.map((f) => `- ${f}`).join('\n')) +
    section('任务', SUMMARY_TASK)
  );
}

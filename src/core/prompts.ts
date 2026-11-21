import type { ProjectConfig, RoleDef } from './config.js';
import type { RoleBook } from './roles.js';
import type { Access, Job, StepRecord } from './types.js';
import { shortHash, truncate } from './util.js';

const CONTEXT_CHARS = 4000;

/** 角色因为必需的工具或服务用不了而停下时，在回复最后单独一行写的标记。编排器据此停止任务并告知发起人。 */
export const BLOCKED_MARK = 'DARIO_BLOCKED';

/** 取出回复里的受阻说明；没有标记时返回 undefined。多处出现时取最后一处。 */
export function parseBlocked(text: string): string | undefined {
  const hits = [...text.matchAll(/^[ \t>*`-]*DARIO_BLOCKED[:：][ \t]*(.*)$/gm)];
  const last = hits.at(-1);
  if (!last) return undefined;
  return last[1]!.replace(/[`*]+$/, '').trim() || '没有写明原因';
}

function rules(access: Access, project: ProjectConfig, includePreamble = true): string {
  const lines = [
    '- 不要执行 git commit、git push，不要切换或新建分支。',
    `- 完成任务必需的工具或服务（例如某个 MCP 服务）连不上、用不了时，先多试几次：隔几秒重试，确认服务是否在运行，换同一服务里能达到目的的其他工具。各种办法都试过仍然不行就停下，不要改用别的途径凑出结果，也不要继续做依赖它的工作；说明哪个工具或服务用不了、试过什么，并在回复的最后单独写一行 \`${BLOCKED_MARK}: <一句话原因>\`。任务不依赖它、或者只是多了一个用不上的服务时，不要写这一行。`,
  ];
  if (access === 'write') {
    lines.push('- 这一步由你自己做完：需要运行命令、调用工具、操作编辑器的就去做，不要把其中一部分留给人，也不要只给出让人照着做的步骤。');
    lines.push('- 某个工具或命令被拒绝时，换一种能达到同样目的的正当做法；确实做不了，在结果里写明被拒绝的是什么、原话是什么，不要想办法绕过限制。');
    lines.push('- 只修改完成任务所必需的文件。');
    if (project.settings.writeRoots.length > 0) {
      lines.push(`- 只允许改动这些目录：${project.settings.writeRoots.join('、')}。`);
    }
    lines.push('- 完成后在回复末尾列出：改动文件清单（没有则写"无"）、存疑点（没有则写"无"）。');
  } else {
    lines.push('- 你处于只读方式：不要创建、修改或删除任何文件。');
  }
  const extra = includePreamble ? project.settings.preamble.trim() : '';
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
 * 角色和权限每次用一句话重申；工作规则与项目约定只在这个会话还没收到过（briefed 为假）时才附上。
 */
function continueHeader(role: RoleDef, access: Access, what: string, briefed = false): string {
  const name = role.alias[0] ? `「${role.alias[0]}」（${role.id}）` : `「${role.id}」`;
  return `# 你的角色\n你继续担任${name}这个角色，权限：${access === 'write' ? '可以修改文件' : '只读'}。${what}之前的对话仍然有效。${briefed ? SAME_RULES : ''}`;
}

/**
 * 固定说明只发一次：角色、工作规则、项目约定、输出格式这些每次都一样的内容，一个会话收到过就不再重复。
 * 下面三个 xxxBrief 给出某类说明里固定部分的指纹，记在会话上（RoleSession.brief）；
 * 续接时指纹与会话上记的相同（briefed）才省略。项目配置改过则指纹不同，照常完整发一次。
 */
const SAME_RULES = '工作规则与项目约定同之前，不再重复。';
const STALE_NOTE = '距离你上次工作，项目里的文件可能已经被其他角色或用户改动，用到时请重新读取，不要依赖记忆里的内容。';
const PLAN_FORMAT_REMINDER =
  '可用角色、项目约定、分派规则和输出格式同之前，不再重复：先用几句话说明思路，回复的**最后**输出同样字段的 JSON 代码块（summary、answer、steps）。';
const REVIEW_FORMAT_REMINDER =
  '输出格式同之前：先写审查意见，回复的**最后**用 JSON 代码块给出结论 `{"verdict":"pass","issues":[]}`，verdict 只能是 pass 或 fail。';

export function stepBrief(project: ProjectConfig, role: RoleDef, access: Access): string {
  return shortHash(`step\n${roleHeader(role, access)}\n${rules(access, project)}`);
}

export function reviewBrief(project: ProjectConfig, role: RoleDef): string {
  return shortHash(`review\n${roleHeader(role, 'read-only')}\n${rules('read-only', project)}\n${REVIEW_FORMAT}`);
}

export function planBrief(project: ProjectConfig, roles: RoleBook): string {
  return shortHash(`plan\n${planPrompt(project, roles, '')}`);
}

function newTaskHeader(role: RoleDef, access: Access): string {
  return continueHeader(role, access, '这是同一次会话里的新任务，', true) + STALE_NOTE;
}

/** 发给从上一个任务带过来、且已经收到过同样固定说明的会话：只交代新任务。 */
export function stepCarried(role: RoleDef, access: Access, task: string, context?: string, acceptance?: string): string {
  return newTaskHeader(role, access) + section('上文', context) + section('任务', task) + section('验收标准', acceptance);
}

export function planCarried(leadImplements: boolean, task: string, context?: string): string {
  return (
    `# 你的角色\n这是同一次会话里的新任务。你仍然是主控，仍处于只读方式，只做阅读和判断，要动手的工作${leadImplements ? '列入计划，小改动可以按之前的规则留给自己' : '分派出去'}。之前的对话仍然有效。${STALE_NOTE}` +
    `\n${PLAN_FORMAT_REMINDER}` +
    section('上文', context) +
    section('任务', task)
  );
}

export function reviewCarried(role: RoleDef, job: Job, extraTask?: string): string {
  const files = job.changedFiles.length ? job.changedFiles.map((f) => `- ${f}`).join('\n') : UNDETECTED_FILES;
  return (
    newTaskHeader(role, 'read-only') +
    section('原始任务', job.task) +
    section('已完成的工作', priorSteps(job)) +
    section('本次改动的文件', files) +
    section('审查要求', extraTask ?? '审查上面的改动是否正确、完整地完成了原始任务。请实际阅读改动的文件。') +
    section('输出格式', REVIEW_FORMAT_REMINDER)
  );
}

/**
 * 发给从上一个任务带过来、但还没收到过这份固定说明的会话（项目配置改过，或它上次是以别的方式上场的）：
 * 完整的任务说明照发，只在前面交代一句。收到过的会话改用上面的 xxxCarried，只交代新任务。
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

function stepUpdate(job: Job, after: number, task: string, acceptance?: string): string {
  return (
    section('你上次工作之后其他步骤的结果', priorSteps(job, after)) +
    section('你上次工作之后被改动的文件', staleFiles(job, after)) +
    section('任务', task) +
    section('验收标准', acceptance)
  );
}

/** after 是这个会话最近一次工作的步骤下标。 */
export function stepFollowUp(project: ProjectConfig, role: RoleDef, access: Access, task: string, job: Job, after: number, acceptance?: string, briefed = false): string {
  return (
    continueHeader(role, access, '这是同一个任务里交给你的下一步，', briefed) +
    (briefed ? '' : section('工作规则', rules(access, project))) +
    stepUpdate(job, after, task, acceptance)
  );
}

export function leadStepFollowUp(project: ProjectConfig, role: RoleDef, task: string, job: Job, after: number, acceptance?: string): string {
  return (
    continueHeader(role, 'write', '你仍然是主控，计划已确认，这一步由你自己完成。') +
    section('工作规则', rules('write', project, false)) +
    stepUpdate(job, after, task, acceptance)
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
  const { leadImplements, leadRole } = project.settings;
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
    '先用几句话说明思路（直接回答问题时这里就写答案），然后在回复的**最后**输出一个 JSON 代码块，格式如下：',
    '```json',
    '{"summary":"一句话概括计划","answer":null,"steps":[{"role":"角色 id","task":"交给该角色的完整任务说明","writes":true,"acceptance":"验收标准"}]}',
    '```',
    '规则：',
    '- 如果任务只是提问、靠阅读就能回答：直接在 JSON 之前把答案完整写出来，JSON 里 steps 留空数组、answer 填 null。答案只写这一遍，不要在 JSON 里再重复。',
    leadImplements
      ? `- 要动手的工作列成步骤。很小的改动可以留给自己：role 写自己的角色 id（${leadRole}），writes 为 true，task 写清要改什么。仅限一两个文件、总共几十行以内，且你已读过要改的代码、知道具体怎么改，无需再大范围了解项目。拿不准、改动面广、要操作编辑器或其他外部工具、要长时间验证，都分派给其他角色。出计划时只读，现在不要动手；计划确认后 Dario 会让你以可写方式接着完成这一步。`
      : '- 任务需要动手时必须分派：把它列成步骤交给可写的角色，在 task 里写清怎么做、怎么验证、结束后把现场还原到什么状态。不要因为你手边有能用的工具就自己做。',
    '- 确实没有哪个角色做得到的事（分派规则明确划在任务范围之外的，或者缺环境、缺账号），不排步骤，在说明里写明是什么、为什么做不了；其余部分照常排完。',
    '- 任务要由这些角色自己做完，人只在全部结束后看最终结果。各步连续自动执行，中间不会停下来等人：不要把任何一步留给人，不要写"需要人处理""由人工完成后再继续"之类的安排。改资产、运行程序、操作编辑器或其他外部工具、验证效果都分派给角色。',
    leadImplements
      ? '- 分派给其他角色时，role 必须是"可用角色"里的 id；writes 为 true 的步骤只能交给其中可写的角色。'
      : '- role 必须是"可用角色"里的 id；writes 为 true 的步骤只能交给可写的角色。',
    `- 步骤不超过 ${project.settings.maxPlanSteps} 个${leadImplements ? '。' : '，不要把主控自己列为步骤。'}`,
    `- 每一步的 task 必须自包含：写清背景、要做什么、涉及哪些文件。${leadImplements ? '其他角色' : '执行者'}看不到本次对话，也看不到其他步骤的说明。`,
    '- writes 表示这一步是否会创建、修改或删除文件，请如实填写。',
  ].join('\n');
  return (
    `# 你的角色\n你是主控。阅读任务和项目，判断如何完成，并输出一份计划。` +
    `你现在处于只读方式，只做阅读和判断：不要修改任何文件，也不要自己动手执行任务。` +
    (leadImplements ? '需要动手的工作列入计划，按下面的规则安排。' : `动手包括改文件、执行命令、操作编辑器或其他外部工具、运行程序验证效果、截图或采集数据；这些都交给下面的角色去做。`) +
    section('可用角色', available) +
    section('项目约定（各角色都要遵守，分派时据此安排）', project.settings.preamble) +
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
export function reviewFollowUp(project: ProjectConfig, role: RoleDef, job: Job, after: number, extraTask?: string, briefed = false): string {
  const recheck = '审查你上次审查之后的改动是否正确、完整地完成了原始任务；你上一轮提出过问题的，逐条确认是否已经解决，并确认修改没有引入新的问题。请实际阅读改动的文件。';
  return (
    continueHeader(role, 'read-only', '这是同一个任务的又一轮审查，', briefed) +
    (briefed ? '' : section('工作规则', rules('read-only', project))) +
    section('你上次审查之后完成的工作', priorSteps(job, after)) +
    section('你上次审查之后被改动的文件', staleFiles(job, after) ?? UNDETECTED_FILES) +
    section('审查要求', extraTask ? `${extraTask}\n${recheck}` : recheck) +
    section('输出格式', briefed ? REVIEW_FORMAT_REMINDER : REVIEW_FORMAT)
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
export function reworkFollowUp(project: ProjectConfig, role: RoleDef, job: Job, after: number, issues: string[], reviewText: string, briefed = false): string {
  return (
    continueHeader(role, 'write', '你之前完成的工作没有通过审查，需要返工，', briefed) +
    (briefed ? '' : section('工作规则', rules('write', project))) +
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

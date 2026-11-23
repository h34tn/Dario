import type { ProjectConfig, RoleDef } from './config.js';
import type { RoleBook } from './roles.js';
import type { Access, Job, PulledUpdate, StepRecord } from './types.js';
import { shortHash, truncate } from './util.js';

const CONTEXT_CHARS = 4000;

/** 角色因为必需的工具或服务用不了而停下时，在回复最后单独一行写的标记。编排器据此停止任务并告知发起人。 */
export const BLOCKED_MARK = 'DARIO_BLOCKED';

/** 取出回复里的受阻说明；没有标记时返回 undefined。多处出现时取最后一处。 */
export function parseBlocked(text: string): string | undefined {
  const hits = [...text.matchAll(/^[ \t>*`-]*DARIO_BLOCKED[:：][ \t]*(.*)$/gm)];
  const last = hits.at(-1);
  if (!last) return undefined;
  // 去掉句末标点：拼进"已停下：……。恢复之后……"时由 Dario 自己加句号
  return last[1]!.replace(/[`*]+$/, '').trim().replace(/[。．.！!；;，,]+$/, '').trim() || '没有写明原因';
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

/** 每个会话在本任务里第一次上场时收到图片对照。 */
export function imageSection(images: Job['images']): string {
  if (!images?.length) return '';
  return section('附带的图片', [
    '发起人的任务附带了下面的图片，文字里的 [Image #N] 指的就是它们。用你查看图片的工具打开文件来看；看不了图片时如实说明，不要凭猜测描述图片内容。',
    ...images.map(image => `- [Image #${image.n}]：${image.path}`),
  ].join('\n'));
}

const PULLED_LIST_MAX = 60;

/**
 * 开工前从远端拉下来的更新。每个会话在本任务里第一次上场时收到；同一任务里续接时它已经知道，不再重复。
 * 已经在运行的程序（打开着的编辑器、常驻的服务）未必加载了新内容，这一点要明说：它们可能在用到一半时才去重新加载。
 */
function pulledSection(pulled: PulledUpdate | undefined): string {
  if (!pulled?.files.length) return '';
  const shown = pulled.files.slice(0, PULLED_LIST_MAX).map((f) => `- ${f}`);
  if (pulled.files.length > PULLED_LIST_MAX) shown.push(`- ……另有 ${pulled.files.length - PULLED_LIST_MAX} 个，用 git diff --name-only ${pulled.from} HEAD 查看`);
  return section('开工前从远端拉取的更新', [
    `这个任务开始前，Dario 从 ${pulled.upstream} 拉取了 ${pulled.commits} 个提交，下面这些文件因此有变化：`,
    ...shown,
    '它们的内容可能和你记得的不一样，用到时请重新读取。',
    '已经在运行的程序（例如打开着的编辑器、常驻的服务）可能还没加载这些新内容，中途才去重新加载会打断正在做的事。要用它们运行或验证之前，先让它们完成刷新或重新编译，确认就绪后再开始。',
  ].join('\n'));
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
  '输出格式同之前：先写审查意见，回复的**最后**用 JSON 代码块给出结论 `{"verdict":"pass","issues":[],"suggestions":[]}`，verdict 只能是 pass 或 fail；issues 只写必须修改的问题，可改可不改或要发起人取舍的写进 suggestions，不触发返工。';

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
export function stepCarried(role: RoleDef, access: Access, task: string, context?: string, acceptance?: string, pulled?: PulledUpdate): string {
  return newTaskHeader(role, access) + section('上文', context) + pulledSection(pulled) + section('任务', task) + section('验收标准', acceptance);
}

export function planCarried(leadImplements: boolean, task: string, context?: string, pulled?: PulledUpdate): string {
  return (
    `# 你的角色\n这是同一次会话里的新任务。你仍然是主控，仍处于只读方式，只做阅读和判断，要动手的工作${leadImplements ? '列入计划，小改动可以按之前的规则留给自己' : '分派出去'}。之前的对话仍然有效。${STALE_NOTE}` +
    `\n${PLAN_FORMAT_REMINDER}` +
    section('上文', context) +
    pulledSection(pulled) +
    section('任务', task)
  );
}

export function reviewCarried(role: RoleDef, job: Job, extraTask?: string, diff?: ChangeDiff): string {
  const files = job.changedFiles.length ? job.changedFiles.map((f) => `- ${f}`).join('\n') : UNDETECTED_FILES;
  return (
    newTaskHeader(role, 'read-only') +
    section('原始任务', job.task) +
    pulledSection(job.pulled) +
    section('已完成的工作', priorSteps(job)) +
    section('本次改动的文件', files) +
    diffSection(diff) +
    section('审查要求', reviewAsk(extraTask, diff)) +
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
export function filesChangedAfter(job: Job, after: number): string[] {
  return [...new Set(job.steps.filter((s) => s.index > after).flatMap((s) => s.changedFiles))].sort();
}

function staleFiles(job: Job, after: number): string | undefined {
  const files = filesChangedAfter(job, after);
  if (files.length === 0) return undefined;
  return `${files.map((f) => `- ${f}`).join('\n')}\n这些文件的内容已经和你记得的不一样，用到时请重新读取。`;
}

export function stepPrompt(project: ProjectConfig, role: RoleDef, access: Access, task: string, context?: string, acceptance?: string, pulled?: PulledUpdate): string {
  return (
    `# 你的角色\n${roleHeader(role, access)}` +
    section('工作规则', rules(access, project)) +
    section('上文', context) +
    pulledSection(pulled) +
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

export function planPrompt(project: ProjectConfig, roles: RoleBook, task: string, context?: string, feedback?: string, pulled?: PulledUpdate): string {
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
  // 交接上下文关掉时不要求写 refs：写了也不会附上
  const handoff = project.settings.handoffMaxChars > 0;
  const format = [
    '先用几句话说明思路（直接回答问题时这里就写答案），然后在回复的**最后**输出一个 JSON 代码块，格式如下：',
    '```json',
    `{"summary":"一句话概括计划","answer":null,"steps":[{"role":"角色 id","task":"交给该角色的完整任务说明","writes":true,"acceptance":"验收标准","files":["预计改动的文件、目录或 glob"]${handoff ? ',"refs":["src/a.ts:120-160"]' : ''}}]}`,
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
    ...(project.settings.finish.mode !== 'none'
      ? [`- 审查通过后 Dario 会安排收尾：由你按项目的收尾说明提交${project.settings.finish.mode === 'push' ? '、与远端同步，再由 Dario 核对后推送' : ''}。不要把提交、推送列为步骤。`]
      : []),
    `- 步骤不超过 ${project.settings.maxPlanSteps} 个${leadImplements ? '。' : '，不要把主控自己列为步骤。'}`,
    `- 每一步的 task 必须自包含：写清背景、要做什么、涉及哪些文件。${leadImplements ? '其他角色' : '执行者'}看不到本次对话，也看不到其他步骤的说明。`,
    '- writes 表示这一步是否会创建、修改或删除文件，请如实填写。',
    '- writes 为 true 的步骤在 files 里列出预计改动的文件、目录或 glob（相对项目根目录，可用 * 和 **），跟着一起改的测试和文档也列上；拿不准具体文件就写到目录。这是估计，用来对照实际改动、提醒发起人，不限制执行。只读步骤不写 files。',
    ...(handoff
      ? ['- refs 列出你已经读过、这一步动手时要看的代码位置，写成"文件:起始行-结束行"（相对项目根目录，行号是你读到的），只列关键片段，不要整个文件。Dario 派活时会读出这些行附给接手的角色，所以不必把代码抄进 task，task 里说清要改哪里、怎么改即可。没读过具体代码的步骤不写 refs。']
      : []),
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
    pulledSection(pulled) +
    section('任务', task) +
    section('上一次输出的问题（请修正后重新输出完整计划）', feedback)
  );
}

/** 计划给这一步的预计范围，附在任务说明后面。 */
export function withScope(task: string, files: string[] | undefined): string {
  if (!files?.length) return task;
  return `${task}\n\n预计改动的范围（出计划时的估计）：${files.join('、')}。确实需要改动范围之外的文件时可以改，在结果里写明改了哪些、为什么。`;
}

/** 主控标出的代码（handoff.readRefs 读出的内容）接在任务说明后面，自成一节。 */
export function withRefs(task: string, refs: string | undefined): string {
  return refs ? `${task}${section('主控标出的相关代码', refs)}` : task;
}

const PRIOR_DIFF = '前面的步骤已经改了下面这些文件。先据此弄清已经做了什么（包括已经补了哪些测试），在这个基础上接着做，不必重做已经完成的部分；需要更多上下文时再打开文件。';

/** 前面步骤的改动接在任务说明后面，接手的角色不必为了弄清前面改了什么逐个翻文件。 */
export function withChanges(task: string, diff: ChangeDiff | undefined): string {
  return diff ? `${task}${diffSection(diff, '前面步骤的改动', PRIOR_DIFF)}` : task;
}

const UNDETECTED_FILES = '（未能自动检测，请用 git status 与 git diff 查看）';

const REVIEW_FORMAT = [
  '先写审查意见，然后在回复的**最后**输出一个 JSON 代码块给出结论：',
  '```json',
  '{"verdict":"pass","issues":[],"suggestions":[]}',
  '```',
  'verdict 只能是 pass（可以接受）或 fail（必须修改）。fail 时在 issues 里逐条写明要改什么，每条都要具体到文件和问题。',
  '只因为会导致错误结果、违反任务要求或明显缺陷才判 fail；风格偏好写进意见但不要因此判 fail。',
  'issues 只写必须修改的问题。可改可不改的、任务说明有歧义需要发起人取舍的、属于任务范围之外的，写进 suggestions：它们会原样交给发起人决定，不会触发返工，也不要因为它们判 fail。',
].join('\n');

const READ_FILES = '请实际阅读改动的文件。';
const READ_DIFF = '改动的 diff 已经附在上面，先据此审查；判断对不对需要更多上下文时再打开相关文件，不必为了确认改了什么逐个重读。';

/** 附给审查或后续步骤的 diff：Dario 在派活这一刻取的，相对 HEAD。 */
export interface ChangeDiff {
  text: string;
  /** 超出长度上限、没有附上（或只附了一部分）的文件。 */
  omitted: string[];
  /** 改动的文件里，任务开始前就有未提交改动的。 */
  preexisting: string[];
  /** 改动的文件里，任务停下之后、续接之前被改过的。 */
  external?: string[];
}

function diffSection(diff: ChangeDiff | undefined, title = '改动的 diff', lead?: string): string {
  if (!diff) return '';
  const notes = [...(lead ? [lead] : []), '相对最近一次提交（HEAD）的改动，没被 git 跟踪的新文件按全文列出。'];
  if (diff.preexisting.length) notes.push(`其中 ${diff.preexisting.join('、')} 在任务开始前就有未提交的改动，diff 里也包含那部分，不全是这次任务改的。`);
  if (diff.external?.length) notes.push(`其中 ${diff.external.join('、')} 在任务停下之后、续接之前被改过（可能是没做完的那一轮留下的，也可能是发起人或别人改的），不全是这次任务改的。`);
  if (diff.omitted.length) notes.push(`超出长度上限，这些文件的 diff 没有附上或没有附全：${diff.omitted.join('、')}。请用 git diff HEAD -- <文件> 查看。`);
  return section(title, `${notes.join('\n')}\n\n${diff.text}`.trim());
}

function reviewAsk(extraTask: string | undefined, diff: ChangeDiff | undefined): string {
  const read = diff ? READ_DIFF : READ_FILES;
  return extraTask ? `${extraTask}\n${read}` : `审查上面的改动是否正确、完整地完成了原始任务。${read}`;
}

export function reviewPrompt(project: ProjectConfig, role: RoleDef, job: Job, extraTask?: string, diff?: ChangeDiff): string {
  const files = job.changedFiles.length ? job.changedFiles.map((f) => `- ${f}`).join('\n') : UNDETECTED_FILES;
  return (
    `# 你的角色\n${roleHeader(role, 'read-only')}` +
    section('工作规则', rules('read-only', project)) +
    section('原始任务', job.task) +
    pulledSection(job.pulled) +
    section('已完成的工作', priorSteps(job)) +
    section('本次改动的文件', files) +
    diffSection(diff) +
    section('审查要求', reviewAsk(extraTask, diff)) +
    section('输出格式', REVIEW_FORMAT)
  );
}

/** after 是这个会话上一次审查的步骤下标。 */
export function reviewFollowUp(project: ProjectConfig, role: RoleDef, job: Job, after: number, extraTask?: string, briefed = false, diff?: ChangeDiff): string {
  const recheck = `审查你上次审查之后的改动是否正确、完整地完成了原始任务；你上一轮提出过问题的，逐条确认是否已经解决，并确认修改没有引入新的问题。${diff ? READ_DIFF : READ_FILES}`;
  return (
    continueHeader(role, 'read-only', '这是同一个任务的又一轮审查，', briefed) +
    (briefed ? '' : section('工作规则', rules('read-only', project))) +
    section('你上次审查之后完成的工作', priorSteps(job, after)) +
    section('你上次审查之后被改动的文件', staleFiles(job, after) ?? UNDETECTED_FILES) +
    diffSection(diff, '这些文件现在的 diff') +
    section('审查要求', extraTask ? `${extraTask}\n${recheck}` : recheck) +
    section('输出格式', briefed ? REVIEW_FORMAT_REMINDER : REVIEW_FORMAT)
  );
}

function issueList(issues: string[], reviewText: string): string {
  return issues.length ? issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : truncate(reviewText, CONTEXT_CHARS);
}

// 返工后再审，审的是这一轮交出来的结果：改动让之前的验证不再成立时，必须在本轮重新验证，
// 否则审查只能再判一次"没有验证"，白白多出一轮返工
const REWORK_TASK =
  '逐条修正上面的问题。只改与这些问题有关的内容，不要顺带做别的改动。' +
  '修改之后，之前做过的测试、测量、截图等验证如果因为这次修改不再成立，在本轮重新做完并给出新结果，不要留给下一轮审查去发现；重新验证不算"别的改动"。';

export interface ConsultBrief {
  stepNumber: number;
  roleLabel: string;
  agent: string;
  task: string;
  alert: string;
  elapsed: string;
  recent: string[];
  edited: string[];
  tokens?: string;
}

/** 请主控判断一次监控告警。主控只读，判断期间干活的一方还在运行。 */
export function consultPrompt(project: ProjectConfig, b: ConsultBrief): string {
  const format = [
    '在回复的**最后**输出一个 JSON 代码块：',
    '```json',
    '{"action":"continue","message":"给干活一方的话，或判断理由","snooze_minutes":10}',
    '```',
    '- continue：情况正常或还值得再等，让它接着做。snooze_minutes 是这条规则静默多少分钟。',
    '- correct：方向不对或卡住了。Dario 会中断它，接着它的会话把 message 发过去，它照着调整后继续完成原任务。message 要具体，说清该停下什么、改做什么。',
    '- stop：继续下去没有意义或有害。Dario 会中止这一步，任务停下，message 写明原因。',
    '拿不准时选 continue。',
  ].join('\n');
  return (
    `# 你的角色\n你是主控，正在监督第 ${b.stepNumber} 步的执行。这一步由${b.roleLabel}（${b.agent}）在做，监控规则发现了一个情况，需要你判断怎么处理。` +
    '你现在只读：不要修改任何文件，也不要自己去做这一步的工作。需要时可以读文件、看 git 状态来了解现场。' +
    section('项目约定', project.settings.preamble) +
    section('这一步的任务', b.task) +
    section('监控发现的情况', b.alert) +
    section('现场', [
      `已运行 ${b.elapsed}${b.tokens ? `，用量 ${b.tokens}` : ''}。`,
      b.edited.length ? `运行中看到的改动：${b.edited.join('、')}` : '运行中还没有看到改动。',
    ].join('\n')) +
    section('最近的活动（从早到晚）', b.recent.length ? b.recent.map((r) => `- ${r}`).join('\n') : '（没有）') +
    section('输出格式', format)
  );
}

/** 主控要求纠偏：续接干活一方的会话时发的话。 */
export function correctionPrompt(message: string): string {
  return (
    `# 主控提醒\n你上一轮的运行被 Dario 中断了，原因是主控看了你的进展后要求调整：\n\n${message}\n\n` +
    '先看一下当前改动的状态（被中断时可能有文件只写了一半），再按上面的提醒接着完成原来的任务。'
  );
}

/** 续接时附在接手那一步说明后面的一节，见 resumeSection。 */
export interface ResumeBrief {
  /** 停下的那一步的记录；Dario 中断时那一轮没来得及记下，为空。 */
  failed?: StepRecord;
  /** 任务是因为 Dario 退出而中断的。 */
  interrupted: boolean;
  /** 任务是被取消的。 */
  cancelled: boolean;
  /** 接着的是停下那一轮的会话：它的输出它自己记得，不再附上。 */
  sameSession: boolean;
  /** 审查已经返工到上限，发起人决定再给一轮。 */
  extraRound: boolean;
  /** 任务停下之后有变化的文件；不是 git 仓库、无法比对时为 undefined。 */
  changed?: string[];
  changedDiff?: ChangeDiff;
  note?: string;
}

const LAST_OUTPUT_CHARS = 1500;
const PARTIAL_WORK = '工作区里可能留着上次改了一半的文件：先检查现状，在此基础上接着做，不要从头重写。';

/** 续接没做完的任务时，告诉接手的角色这一步之前停在了哪里、停下之后发生了什么。 */
export function resumeSection(b: ResumeBrief): string {
  const lines = ['这个任务之前停下了，发起人让你从停下的地方接着做。'];
  const f = b.failed;
  if (f?.blocked) {
    lines.push(
      `上次执行这一步时，必需的工具或服务用不了而停下：${f.blocked}。发起人已经处理了这个问题。先确认它现在能用，再从停下的地方接着做，已经做完的部分不要重做；仍然用不了就照工作规则停下并标记。`,
    );
  } else if (f && f.outcome !== 'all_unavailable') {
    const why = f.outcome === 'timeout' ? '超时' : b.cancelled ? '被取消' : '没有做完';
    lines.push(`这一步上次${why}${f.reason ? `：${f.reason}` : ''}。${PARTIAL_WORK}`);
  } else if (!f && b.interrupted) {
    lines.push(`这一步上次执行到一半时 Dario 退出了，没有做完。${PARTIAL_WORK}`);
  }
  if (b.extraRound) lines.push('审查已经返工到上限，发起人决定再给一轮。');
  if (b.changed === undefined) lines.push('目录不是 git 仓库，无法确认任务停下之后哪些文件被改过，用到时请重新读取。');
  const last = f && !f.blocked && !b.sameSession && f.text.trim() ? truncate(f.text, LAST_OUTPUT_CHARS) : undefined;
  const changed = b.changed?.length
    ? `${b.changed.map((file) => `- ${file}`).join('\n')}\n可能是上次没做完的那一轮留下的，也可能是发起人或别人改的，用到时请重新读取。`
    : undefined;
  return (
    section('接着做', lines.join('\n')) +
    section('上次停下前的最后输出', last) +
    section('任务停下之后有变化的文件', changed) +
    diffSection(b.changedDiff, '这些文件的 diff') +
    section('发起人的补充说明', b.note)
  );
}

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

export function summaryPrompt(job: Job, steps: StepRecord[], finish?: string): string {
  return (
    `# 你的角色\n你是主控。下面是你之前安排的各个步骤的执行结果。你处于只读方式，不要修改任何文件。` +
    section('原始任务', job.task) +
    section('各步结果', stepResults(steps)) +
    section('改动的文件', job.changedFiles.map((f) => `- ${f}`).join('\n')) +
    section('收尾', finish) +
    section('任务', SUMMARY_TASK)
  );
}

/** 发给出计划的那个会话：原始任务和计划它都记得，只补各步的执行结果。 */
export function summaryFollowUp(job: Job, steps: StepRecord[], finish?: string): string {
  return (
    `# 你的角色\n你仍然是主控。你出的计划已经执行结束，下面是各步的执行结果。你处于只读方式，不要修改任何文件，也不要再输出计划。之前的对话仍然有效。` +
    section('各步结果', stepResults(steps)) +
    section('改动的文件', job.changedFiles.map((f) => `- ${f}`).join('\n')) +
    section('收尾', finish) +
    section('任务', SUMMARY_TASK)
  );
}

/** 交给主控收尾（提交与同步）那一轮的说明。 */
export interface FinishBrief {
  mode: 'commit' | 'push';
  /** 推送的目标，例如 origin/main；只提交时为空。 */
  target?: string;
  /** 本任务改动、审查过的文件，要提交的就是这些。 */
  files: string[];
  /** 工作区里其他有未提交改动的文件，不是本任务的。 */
  others: string[];
  /** 这是第几轮。 */
  round: number;
  /** 又回到主控这里的原因：推送被拒、核对发现 HEAD 落后、复审没通过等。 */
  again?: string;
  /** 复审没通过时要修改的问题；issues 为空时用审查的原文。 */
  issues?: string[];
  issuesText?: string;
}

function finishRules(b: FinishBrief): string {
  const lines = [
    '- 只提交"要提交的文件"。"其他有未提交改动的文件"不是本任务的：不要提交，不要丢弃，也不要修改。',
    '- 按"项目的收尾说明"分组提交、写提交信息；说明里没写的，按改动的性质分成合理的几个提交，提交信息写清做了什么。',
  ];
  if (b.mode === 'push') {
    lines.push(
      `- 提交之后 git fetch，HEAD 落后于 ${b.target} 时 rebase 到它上面（工作区里还有其他未提交改动时加 --autostash）。有冲突由你自己解决，解决之后按收尾说明做必要的验证。`,
    );
  }
  lines.push(
    `- 不要推送：${b.mode === 'push' ? '推送由 Dario 在核对之后完成，' : ''}这一轮里执行 git push 会被拦截并中断。`,
    '- 不要改写远端已有的提交，不要强制操作，不要用 --no-verify 之类跳过钩子，不要动已有的 git stash 记录。',
    '- 要提交的内容已经审查过。除解决冲突外不要再改它们；确实需要改的，在回复里写明改了什么、为什么，Dario 会把差别交给审核者复审。',
    `- 做不成（例如钩子或检查一直不通过、冲突解决不了）时停下，说明原因，并在回复的最后单独写一行 \`${BLOCKED_MARK}: <一句话原因>\`。`,
    `- 完成后在回复里说明：分了哪几个提交${b.mode === 'push' ? '、是否同步了远端、冲突怎么解决的' : ''}、按收尾说明跑了哪些检查、结果如何。`,
  );
  return lines.join('\n');
}

function finishBody(project: ProjectConfig, b: FinishBrief): string {
  const what = b.mode === 'push' ? `提交并与 ${b.target} 同步，之后由 Dario 核对、推送` : '提交，不推送';
  return (
    section('这一轮要做的事', `计划已经执行完，改动审查通过。现在由你收尾：${what}。这是第 ${b.round} 轮。${b.again ? `\n${b.again}` : ''}`) +
    section('复审没有通过，需要修改的问题', b.issues?.length ? b.issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : b.issuesText) +
    section('收尾规则', finishRules(b)) +
    section('项目约定', project.settings.preamble) +
    section('项目的收尾说明', project.settings.finish.instructions) +
    section('要提交的文件', b.files.map((f) => `- ${f}`).join('\n')) +
    section('其他有未提交改动的文件（不是本任务的）', b.others.map((f) => `- ${f}`).join('\n'))
  );
}

/** 新开会话时的完整说明：带上原始任务和各步结果，据此分组。 */
export function finishPrompt(project: ProjectConfig, job: Job, b: FinishBrief): string {
  return `# 你的角色\n你是主控，这一步你可以执行 git 提交。` + section('原始任务', job.task) + section('各步结果', priorSteps(job)) + finishBody(project, b);
}

/** 续接主控的会话：任务和计划它都记得。 */
export function finishFollowUp(project: ProjectConfig, b: FinishBrief): string {
  return `# 你的角色\n你仍然是主控，之前的对话仍然有效。这一步你可以执行 git 提交。${STALE_NOTE}` + finishBody(project, b);
}

/** 收尾核对发现提交和审过的内容对不上时，交给审核者只审这部分差别。resumed 表示续接审查的会话。 */
export function finishReviewPrompt(project: ProjectConfig, role: RoleDef, job: Job, diff: string, resumed: boolean): string {
  const ask =
    '本任务的改动已经审查通过。主控收尾时与远端同步、解决冲突，或者在收尾中做了修改，下面这些文件提交里的改动因此和审过的不一样。' +
    '对比"审过时的改动"和"现在提交里的改动"，只审两者的差别：冲突解决得对不对，有没有丢掉或改坏审过的内容，额外的改动是否必要且正确。没有变化的部分不必重审。';
  const head = resumed
    ? continueHeader(role, 'read-only', '这是同一个任务里收尾时的复审，')
    : `# 你的角色\n${roleHeader(role, 'read-only')}` + section('工作规则', rules('read-only', project)) + section('原始任务', job.task);
  return head + section('对不上的文件', diff) + section('审查要求', ask) + section('输出格式', REVIEW_FORMAT);
}

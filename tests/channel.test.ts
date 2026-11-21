import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/compose.js';
import type { ChannelPort, InboundMessage } from '../src/core/ports.js';
import { ChannelRouter, type RouterOptions } from '../src/core/router.js';
import { PUSH_DISABLED_URL } from '../src/core/workspace.js';
import { DEFAULT_TEST_ROLES, gitInit, isAlive, plan, Sandbox, sh, verdict } from './helpers.js';

class FakeChannel implements ChannelPort {
  readonly id = 'feishu';
  replies: Array<{ messageId: string; text: string; key: string }> = [];
  private onMessage?: (m: InboundMessage) => void;
  private n = 0;

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }

  async stop(): Promise<void> {}

  async reply(to: { conversation: string; messageId: string }, text: string, key: string): Promise<void> {
    this.replies.push({ messageId: to.messageId, text, key });
  }

  /** 模拟收到一条消息，返回消息编号。 */
  send(text: string, opts: { sender?: string; conversation?: string; thread?: string; id?: string; direct?: boolean } = {}): string {
    const id = opts.id ?? `om_${++this.n}`;
    this.onMessage!({
      channel: 'feishu',
      messageId: id,
      conversation: opts.conversation ?? 'oc_allowed',
      threadKey: opts.thread ?? id,
      senderId: opts.sender ?? 'ou_member',
      text,
      isDirect: opts.direct ?? false,
    });
    return id;
  }

  texts(): string {
    return this.replies.map((r) => r.text).join('\n---\n');
  }
}

interface Rig {
  sb: Sandbox;
  clone: string;
  origin: string;
  app: App;
  channel: FakeChannel;
  router: ChannelRouter;
}

const SECRET = 'feishu-app-secret-value-123';

async function makeRig(opts: { projectYaml?: string; router?: Partial<RouterOptions>; roles?: string } = {}): Promise<Rig> {
  const sb = new Sandbox();
  const origin = path.join(sb.dir, 'origin.git');
  const seed = path.join(sb.dir, 'seed');
  const clone = path.join(sb.dir, 'clone');
  fs.mkdirSync(origin);
  sh(origin, 'git', ['init', '-q', '--bare', '-b', 'main']);
  fs.mkdirSync(path.join(seed, '.dario'), { recursive: true });
  gitInit(seed);
  fs.writeFileSync(path.join(seed, '.dario', 'roles.yaml'), opts.roles ?? DEFAULT_TEST_ROLES);
  if (opts.projectYaml) fs.writeFileSync(path.join(seed, '.dario', 'project.yaml'), opts.projectYaml);
  fs.writeFileSync(path.join(seed, 'README.md'), '# 远端仓库\n');
  sh(seed, 'git', ['add', '-A']);
  sh(seed, 'git', ['commit', '-q', '-m', 'chore: 初始化']);
  sh(seed, 'git', ['remote', 'add', 'origin', origin]);
  sh(seed, 'git', ['push', '-q', 'origin', 'main']);
  sh(sb.dir, 'git', ['clone', '-q', origin, clone]);
  sh(clone, 'git', ['config', 'user.name', 'tester']);
  sh(clone, 'git', ['config', 'user.email', 'tester@example.com']);
  sh(clone, 'git', ['config', 'commit.gpgsign', 'false']);

  const rig = { sb, clone, origin } as Rig;
  await boot(rig, opts.router);
  return rig;
}

/** 启动（或重新启动）引擎与路由，模拟 dario serve 的一次运行。 */
async function boot(rig: Rig, routerOpts: Partial<RouterOptions> = {}): Promise<void> {
  rig.app = await createApp({
    cwd: rig.clone,
    env: rig.sb.env(),
    projectRoot: rig.clone,
    strategy: 'isolated',
    isolated: { forbiddenPaths: [] },
  });
  rig.channel = new FakeChannel();
  rig.router = new ChannelRouter(
    rig.app.engine,
    rig.channel,
    { members: ['ou_member', 'ou_member2'], admins: ['ou_admin'] },
    {
      conversations: ['oc_allowed'],
      rateLimitPerMinute: 50,
      maxQueue: 10,
      autoApprove: false,
      replyMaxChars: 6000,
      secrets: [SECRET],
      sendIntervalMs: 0,
      ...routerOpts,
    },
  );
  await rig.router.start();
}

let rig: Rig;
afterEach(() => rig?.sb.cleanup());

describe('鉴权与去重', () => {
  beforeEach(async () => {
    rig = await makeRig();
  });

  it('名单外的成员或会话：没有任何回复，日志有记录', async () => {
    rig.channel.send('/to coder 干活', { sender: 'ou_stranger' });
    rig.channel.send('/to coder 干活', { conversation: 'oc_other' });
    await rig.router.idle();
    expect(rig.channel.replies).toHaveLength(0);
    expect(rig.sb.calls()).toHaveLength(0);
    const rejected = rig.app.state.readAudit().filter((e) => e.event === 'message_rejected');
    expect(rejected.map((e) => e.reason)).toEqual(['发送人不在名单内', '会话不在名单内']);
  });

  it('名单内的成员可以私聊，不受会话名单限制', async () => {
    rig.sb.setScenario({ a3: [{ text: '看完了' }] });
    rig.channel.send('/to reviewer 看看', { conversation: 'oc_private', direct: true });
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('看完了');
  });

  it('同一条消息重复推送只产生一个任务', async () => {
    rig.sb.setScenario({ a3: [{ text: '看完了' }] });
    rig.channel.send('/to reviewer 看看', { id: 'om_dup' });
    rig.channel.send('/to reviewer 看看', { id: 'om_dup' });
    rig.channel.send('/to reviewer 看看', { id: 'om_dup' });
    await rig.router.idle();
    expect(rig.sb.calls()).toHaveLength(1);
    expect(rig.app.engine.jobs().length).toBe(1);
    // 重启后去重记录仍在
    await boot(rig);
    rig.channel.send('/to reviewer 看看', { id: 'om_dup' });
    await rig.router.idle();
    expect(rig.sb.calls()).toHaveLength(1);
  });

  it('事件处理立即返回，与任务耗时无关', async () => {
    rig.sb.setScenario({ a3: [{ text: '慢慢看完了', delayMs: 1500 }] });
    const t0 = Date.now();
    rig.channel.send('/to reviewer 看看');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(300);
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('慢慢看完了');
  });

  it('成员可查询角色的型号；查询失败返回工具原因，写设置需要管理员权限', async () => {
    rig.channel.send('/model 实现');
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('没能取到型号清单：插件没有提供型号清单');
    rig.channel.send('/model 实现 --reset');
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('需要管理员权限');
  });

  it('非管理员不能换人，管理员可以', async () => {
    rig.channel.send('/role coder a3');
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('需要管理员权限');
    expect(rig.app.state.getOverrides(rig.clone)).toEqual({});

    rig.channel.send('/role coder a3', { sender: 'ou_admin' });
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('临时改由 a3');
    rig.channel.send('/roles');
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('已临时指定 a3');
  });

  it('每人每分钟的任务数有上限', async () => {
    rig.sb.cleanup();
    rig = await makeRig({ router: { rateLimitPerMinute: 2 } });
    rig.sb.setScenario({ a3: [{ text: '好' }] });
    for (let i = 0; i < 3; i++) rig.channel.send('/to reviewer 看看');
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('下达得太快了');
    expect(rig.sb.calls()).toHaveLength(2);
  });
});

describe('隔离执行', () => {
  it('产出在任务分支上，主干不动，推送不出去', async () => {
    rig = await makeRig();
    rig.sb.setScenario({ a2: [{ text: '已新建 src/a.txt', files: [{ path: 'src/a.txt', content: 'hello' }] }] });
    rig.channel.send('/to coder 新建一个文件');
    await rig.router.idle();

    const job = rig.app.engine.jobs()[0]!;
    expect(job.status).toBe('done');
    const branch = `dario/${job.id}`;
    expect(job.result?.branch).toBe(branch);
    expect(rig.channel.texts()).toContain(`产出所在分支：${branch}`);
    // 快照提交在任务分支上，提交信息符合约定
    expect(sh(rig.clone, 'git', ['log', '-1', '--format=%s', branch]).trim()).toBe(`chore(dario): 任务 ${job.id} 产出快照`);
    expect(sh(rig.clone, 'git', ['show', '--stat', '--format=', branch])).toContain('src/a.txt');
    expect(sh(rig.clone, 'git', ['status', '--porcelain']).trim()).toBe('');
    // 远端主干和本地跟踪的主干都没有这个文件
    expect(sh(rig.clone, 'git', ['ls-tree', '-r', '--name-only', 'origin/main'])).not.toContain('src/a.txt');
    expect(sh(rig.origin, 'git', ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('src/a.txt');
    // 推送地址已被禁用，实际推送会失败
    expect(sh(rig.clone, 'git', ['remote', 'get-url', '--push', 'origin']).trim()).toBe(PUSH_DISABLED_URL);
    expect(() => sh(rig.clone, 'git', ['push', 'origin', branch])).toThrow();
    expect(sh(rig.origin, 'git', ['branch', '--list', 'dario/*']).trim()).toBe('');
  });

  it('每个任务从远端最新的主干开始', async () => {
    rig = await makeRig();
    // 另一个人往远端主干推了新提交
    const other = path.join(rig.sb.dir, 'other');
    sh(rig.sb.dir, 'git', ['clone', '-q', rig.origin, other]);
    sh(other, 'git', ['config', 'user.name', 'x']);
    sh(other, 'git', ['config', 'user.email', 'x@example.com']);
    fs.writeFileSync(path.join(other, 'NEW.md'), 'new');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-q', '-m', 'docs: 新文件']);
    sh(other, 'git', ['push', '-q', 'origin', 'main']);

    rig.sb.setScenario({ a2: [{ text: 'ok', files: [{ path: 'b.txt', content: 'b' }] }] });
    rig.channel.send('/to coder 干活');
    await rig.router.idle();
    const job = rig.app.engine.jobs()[0]!;
    expect(sh(rig.clone, 'git', ['ls-tree', '-r', '--name-only', `dario/${job.id}`])).toContain('NEW.md');
  });

  it('没有改动的任务不留下空分支', async () => {
    rig = await makeRig();
    rig.sb.setScenario({ a3: [{ text: '看完了，没问题' }] });
    rig.channel.send('/to reviewer 看看');
    await rig.router.idle();
    expect(sh(rig.clone, 'git', ['branch', '--list', 'dario/*']).trim()).toBe('');
    expect(rig.app.engine.jobs()[0]!.result?.branch).toBeUndefined();
  });

  it('改动越界：标为越界，不出快照，之后的任务被拒绝', async () => {
    rig = await makeRig({ projectYaml: 'write_roots: [src]\n' });
    rig.sb.setScenario({ a2: [{ text: 'ok', files: [{ path: 'outside.txt', content: 'x' }] }] });
    rig.channel.send('/to coder 干活');
    await rig.router.idle();
    const job = rig.app.engine.jobs()[0]!;
    expect(job.status).toBe('out_of_scope');
    expect(rig.channel.texts()).toContain('越界');
    expect(rig.channel.texts()).toContain('outside.txt');
    // 没有快照提交，改动原样留在工作区
    expect(sh(rig.clone, 'git', ['log', '-1', '--format=%s']).trim()).toBe('chore: 初始化');
    expect(sh(rig.clone, 'git', ['status', '--porcelain'])).toContain('outside.txt');

    rig.sb.setScenario({ a2: [{ text: '不该被调用' }] });
    rig.channel.send('/to coder 再干一个');
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('未处理的改动');
    expect(rig.sb.calls()).toHaveLength(0);
  });

  it('被配置为禁止的目录不能用于隔离执行', async () => {
    rig = await makeRig();
    const app = await createApp({
      cwd: rig.clone,
      env: rig.sb.env(),
      projectRoot: rig.clone,
      strategy: 'isolated',
      isolated: { forbiddenPaths: [rig.clone] },
    });
    await expect(app.engine.assertWorkspaceUsable()).rejects.toThrow(/禁止用于隔离执行/);
  });
});

describe('计划的确认', () => {
  beforeEach(async () => {
    rig = await makeRig();
    rig.sb.setScenario({
      a1: [{ text: plan([{ role: 'coder', task: '新建 c.txt', writes: true }]) }, { text: '汇总：已完成' }],
      a2: [{ text: 'ok', files: [{ path: 'c.txt', content: 'c' }] }],
      a3: [{ text: verdict(true) }],
    });
  });

  it('含改文件的计划等待确认，发起人在话题里回复"确认"后执行', async () => {
    const root = rig.channel.send('新建一个文件');
    await rig.router.idle();
    const job = rig.app.engine.jobs()[0]!;
    expect(job.status).toBe('awaiting_approval');
    expect(rig.channel.texts()).toContain('回复"确认"开始执行');
    expect(rig.sb.calls().map((c) => c.name)).toEqual(['a1']);

    rig.channel.send('确认', { thread: root });
    await rig.router.idle();
    const done = rig.app.engine.job(job.id);
    expect(done.status).toBe('done');
    expect(done.result?.conclusion).toBe('汇总：已完成');
    expect(done.result?.branch).toBe(`dario/${job.id}`);
    expect(rig.channel.texts()).toContain('汇总：已完成');
  });

  it('其他成员不能替发起人确认，管理员可以', async () => {
    const root = rig.channel.send('新建一个文件');
    await rig.router.idle();
    rig.channel.send('确认', { thread: root, sender: 'ou_member2' });
    await rig.router.idle();
    expect(rig.channel.texts()).toContain('只有发起人或管理员可以批准');
    expect(rig.app.engine.jobs()[0]!.status).toBe('awaiting_approval');

    rig.channel.send('确认', { thread: root, sender: 'ou_admin' });
    await rig.router.idle();
    expect(rig.app.engine.jobs()[0]!.status).toBe('done');
  });

  it('回复"取消"放弃计划', async () => {
    const root = rig.channel.send('新建一个文件');
    await rig.router.idle();
    rig.channel.send('取消', { thread: root });
    await rig.router.idle();
    expect(rig.app.engine.jobs()[0]!.status).toBe('cancelled');
    expect(rig.sb.calls().map((c) => c.name)).toEqual(['a1']);
  });
});

describe('回复与恢复', () => {
  it('回复里的密钥被遮盖，超长结果被截断并落盘', async () => {
    rig = await makeRig({ router: { replyMaxChars: 300 } });
    const long = '很长的内容。'.repeat(200);
    rig.sb.setScenario({
      a3: [{ text: `key 是 sk-abcdefghijklmnopqrstuvwxyz123456，应用密钥 ${SECRET}，password=hunter2hunter2\n${long}` }],
    });
    rig.channel.send('/to reviewer 看看');
    await rig.router.idle();
    const final = rig.channel.replies.at(-1)!.text;
    expect(final).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(final).not.toContain(SECRET);
    expect(final).not.toContain('hunter2hunter2');
    expect(final).toContain('[已遮盖]');
    expect(final).toContain('内容过长已截断');
    const saved = /保存在本机 (.+?)）/.exec(final)![1]!;
    expect(fs.readFileSync(saved, 'utf8')).toContain(long);
    // 落盘的全文同样是遮盖后的
    expect(fs.readFileSync(saved, 'utf8')).not.toContain(SECRET);
  });

  it('同一话题里的后续任务带上上一个任务的结论', async () => {
    rig = await makeRig();
    rig.sb.setScenario({ a3: [{ text: '第一次的结论：模块 A 有问题' }, { text: '第二次看完了' }] });
    const root = rig.channel.send('/to reviewer 看看模块 A');
    await rig.router.idle();
    rig.channel.send('/to reviewer 那模块 B 呢', { thread: root });
    await rig.router.idle();
    expect(rig.sb.calls()[1]!.prompt).toContain('模块 A 有问题');
    // 不同话题不带
    rig.channel.send('/to reviewer 无关的任务');
    await rig.router.idle();
    expect(rig.sb.calls()[2]!.prompt).not.toContain('模块 A 有问题');
  });

  it('重启后把运行中的任务标为中断并报告，不自动重跑', async () => {
    rig = await makeRig();
    const engine = rig.app.engine;
    const job = engine.create({
      task: '跑到一半的任务',
      role: 'coder',
      origin: { channel: 'feishu', conversation: 'oc_allowed', threadKey: 'om_x', messageId: 'om_x', senderId: 'ou_member' },
    });
    job.status = 'running';
    job.ownerPid = 2 ** 22 + 12345; // 不存在的进程
    rig.app.state.saveJob(job);

    await boot(rig);
    await rig.router.idle();
    expect(rig.app.engine.job(job.id).status).toBe('interrupted');
    expect(rig.channel.replies).toHaveLength(1);
    expect(rig.channel.replies[0]!.messageId).toBe('om_x');
    expect(rig.channel.replies[0]!.text).toContain('被中断');
    expect(rig.sb.calls()).toHaveLength(0);
  });

  it('取消运行中的任务会终止 AI 进程树', async () => {
    rig = await makeRig();
    rig.sb.setScenario({ a2: [{ hang: true, spawnChild: true }] });
    const root = rig.channel.send('/to coder 一个跑不完的任务');
    const pidFile = `${rig.sb.scenarioFile}.child.pid`;
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(isAlive(childPid)).toBe(true);

    // 在任务的话题里回复"取消"，取消的是这个正在运行的任务，而不是当成新任务
    rig.channel.send('取消', { thread: root });
    await rig.router.idle();
    expect(rig.app.engine.jobs()).toHaveLength(1);
    const first = rig.app.engine.jobs()[0]!;
    expect(first.status).toBe('cancelled');
    expect(rig.channel.texts()).toContain('已取消');
    await new Promise((r) => setTimeout(r, 500));
    expect(isAlive(childPid)).toBe(false);
  });

  it('/status 与 /help 有回复', async () => {
    rig = await makeRig();
    rig.channel.send('/status');
    rig.channel.send('/help');
    rig.channel.send('/nonsense');
    await rig.router.idle();
    const all = rig.channel.texts();
    expect(all).toContain('还没有任务');
    expect(all).toContain('/to <角色> <任务>');
    expect(all).toContain('不认识的指令');
  });
});

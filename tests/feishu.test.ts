import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { toInbound, type FeishuTransport } from '../src/channels/feishu.js';
import { serve, type ServeHandle } from '../src/compose.js';
import { DEFAULT_TEST_ROLES, gitInit, Sandbox, sh } from './helpers.js';

const BOT = 'ou_bot';

/** 按飞书 SDK 交给处理函数的数据形状构造一条消息事件。 */
function event(over: {
  text?: string;
  type?: string;
  content?: unknown;
  chatType?: string;
  sender?: string;
  senderType?: string;
  mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  id?: string;
  root?: string;
  chat?: string;
}): unknown {
  return {
    event_id: 'ev_1',
    sender: { sender_id: { open_id: over.sender ?? 'ou_member' }, sender_type: over.senderType ?? 'user' },
    message: {
      message_id: over.id ?? 'om_1',
      root_id: over.root,
      chat_id: over.chat ?? 'oc_allowed',
      chat_type: over.chatType ?? 'group',
      message_type: over.type ?? 'text',
      content: JSON.stringify(over.content ?? { text: over.text ?? '' }),
      mentions: over.mentions,
    },
  };
}

const atBot = [{ key: '@_user_1', id: { open_id: BOT }, name: 'Dario' }];

describe('飞书事件转换', () => {
  it('群里 @机器人 的文本消息：去掉 @ 占位符', () => {
    const m = toInbound(event({ text: '@_user_1 /to coder 修一下登录', mentions: atBot }), BOT)!;
    expect(m).toMatchObject({
      channel: 'feishu',
      messageId: 'om_1',
      conversation: 'oc_allowed',
      threadKey: 'om_1',
      senderId: 'ou_member',
      text: '/to coder 修一下登录',
      isDirect: false,
    });
  });

  it('群里没有 @机器人，或 @的是别人：不处理', () => {
    expect(toInbound(event({ text: '大家好' }), BOT)).toBeUndefined();
    const other = [{ key: '@_user_1', id: { open_id: 'ou_someone' }, name: '某人' }];
    expect(toInbound(event({ text: '@_user_1 看一下', mentions: other }), BOT)).toBeUndefined();
  });

  it('取不到机器人自己的标识时，退回到"有 @ 就处理"', () => {
    const other = [{ key: '@_user_1', id: { open_id: 'ou_someone' }, name: '某人' }];
    expect(toInbound(event({ text: '@_user_1 看一下', mentions: other }), undefined)?.text).toBe('看一下');
  });

  it('私聊不需要 @', () => {
    expect(toInbound(event({ text: '看看角色表', chatType: 'p2p' }), BOT)).toMatchObject({ isDirect: true, text: '看看角色表' });
  });

  it('机器人发的消息不处理', () => {
    expect(toInbound(event({ text: '@_user_1 hi', mentions: atBot, senderType: 'app' }), BOT)).toBeUndefined();
  });

  it('话题内的回复使用根消息作为话题标识', () => {
    expect(toInbound(event({ text: '@_user_1 确认', mentions: atBot, id: 'om_9', root: 'om_1' }), BOT)?.threadKey).toBe('om_1');
  });

  it('富文本消息取出纯文字，其他类型得到空文字', () => {
    const post = { title: '', content: [[{ tag: 'at', user_id: BOT }, { tag: 'text', text: ' 第一行' }], [{ tag: 'text', text: '第二行' }]] };
    expect(toInbound(event({ type: 'post', content: post, mentions: atBot }), BOT)?.text).toBe('第一行\n第二行');
    expect(toInbound(event({ type: 'image', content: { image_key: 'x' }, mentions: atBot }), BOT)?.text).toBe('');
  });

  it('SDK 把事件包在 event 字段里时也能识别', () => {
    expect(toInbound({ event: event({ text: 'hi', chatType: 'p2p' }) }, BOT)?.text).toBe('hi');
    expect(toInbound({}, BOT)).toBeUndefined();
    expect(toInbound(null, BOT)).toBeUndefined();
  });
});

class FakeTransport implements FeishuTransport {
  sent: Array<{ messageId: string; text: string; uuid: string }> = [];
  private onEvent?: (data: unknown) => void;
  stopped = false;

  async start(onEvent: (data: unknown) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async reply(messageId: string, text: string, uuid: string): Promise<void> {
    this.sent.push({ messageId, text, uuid });
  }

  async botOpenId(): Promise<string | undefined> {
    return BOT;
  }

  push(data: unknown): void {
    this.onEvent!(data);
  }
}

describe('dario serve（飞书渠道，替换掉真实连接）', () => {
  let sb: Sandbox;
  let handle: ServeHandle | undefined;
  let clone: string;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    sb?.cleanup();
  });

  function setup(channel: Record<string, unknown> = {}, access: Record<string, unknown> = { members: ['ou_member'], admins: ['ou_admin'] }): void {
    sb = new Sandbox();
    const origin = path.join(sb.dir, 'origin.git');
    const seed = path.join(sb.dir, 'seed');
    clone = path.join(sb.dir, 'clone');
    fs.mkdirSync(origin);
    sh(origin, 'git', ['init', '-q', '--bare', '-b', 'main']);
    fs.mkdirSync(path.join(seed, '.dario'), { recursive: true });
    gitInit(seed);
    fs.writeFileSync(path.join(seed, '.dario', 'roles.yaml'), DEFAULT_TEST_ROLES);
    sh(seed, 'git', ['add', '-A']);
    sh(seed, 'git', ['commit', '-q', '-m', 'chore: 初始化']);
    sh(seed, 'git', ['remote', 'add', 'origin', origin]);
    sh(seed, 'git', ['push', '-q', 'origin', 'main']);
    sh(sb.dir, 'git', ['clone', '-q', origin, clone]);
    sh(clone, 'git', ['config', 'user.name', 'tester']);
    sh(clone, 'git', ['config', 'user.email', 'tester@example.com']);
    fs.writeFileSync(
      path.join(sb.home, 'channels.yaml'),
      stringify({ feishu: { enabled: true, project: clone, conversations: ['oc_allowed'], ...channel } }),
    );
    fs.writeFileSync(path.join(sb.home, 'access.yaml'), stringify({ feishu: access }));
  }

  it('收到飞书消息后执行任务，并把结果回复到原消息', async () => {
    setup();
    sb.setScenario({ a3: [{ text: '审查结论：没有问题' }] });
    const transport = new FakeTransport();
    const logs: string[] = [];
    handle = await serve({ env: sb.env(), log: (l) => logs.push(l), transport });
    expect(logs.join('\n')).toContain('飞书渠道已启动');

    transport.push(event({ text: '@_user_1 /to 审查 看看 README', mentions: atBot, id: 'om_task' }));
    transport.push(event({ text: '没有 @ 的闲聊', id: 'om_chat' }));
    transport.push(event({ text: '@_user_1 /to 审查 陌生人的任务', mentions: atBot, id: 'om_x', sender: 'ou_stranger' }));
    await handle.router.idle();

    expect(sb.calls()).toHaveLength(1);
    expect(transport.sent.every((s) => s.messageId === 'om_task')).toBe(true);
    expect(transport.sent[0]!.text).toMatch(/^\[J\d{4}\] 已接收，交给审查（reviewer）/);
    expect(transport.sent.at(-1)!.text).toContain('审查结论：没有问题');
    // 幂等标识各不相同，且不超过飞书的 50 字符上限
    const uuids = transport.sent.map((s) => s.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(uuids.every((u) => u.length > 0 && u.length <= 50)).toBe(true);
    // 任务记录的是隔离执行
    expect(handle.app.engine.jobs()[0]).toMatchObject({ strategy: 'isolated', status: 'done' });
  });

  it('启动前的检查：没有启用、名单为空、克隆不存在、目录被禁止', async () => {
    setup({ enabled: false });
    await expect(serve({ env: sb.env(), log: () => {}, transport: new FakeTransport() })).rejects.toThrow(/没有启用任何渠道/);
    sb.cleanup();

    setup({}, { members: [], admins: [] });
    await expect(serve({ env: sb.env(), log: () => {}, transport: new FakeTransport() })).rejects.toThrow(/名单是空的/);
    sb.cleanup();

    setup({ project: 'Z:/no/such/clone' });
    await expect(serve({ env: sb.env(), log: () => {}, transport: new FakeTransport() })).rejects.toThrow(/隔离克隆不存在/);
    sb.cleanup();

    setup();
    fs.writeFileSync(
      path.join(sb.home, 'channels.yaml'),
      stringify({ feishu: { enabled: true, project: clone, conversations: ['oc_allowed'], forbidden_paths: [clone] } }),
    );
    await expect(serve({ env: sb.env(), log: () => {}, transport: new FakeTransport() })).rejects.toThrow(/禁止用于隔离执行/);
  });

  it('没有飞书凭据时不启动真实连接', async () => {
    setup();
    const env = sb.env();
    delete env.DARIO_FEISHU_APP_ID;
    delete env.DARIO_FEISHU_APP_SECRET;
    await expect(serve({ env, log: () => {} })).rejects.toThrow(/没有找到飞书应用凭据/);
  });

  it('同一时间只能运行一个实例', async () => {
    setup();
    fs.mkdirSync(path.join(sb.home, 'state'), { recursive: true });
    // 用测试进程的父进程冒充"另一个正在运行的实例"
    fs.writeFileSync(path.join(sb.home, 'state', 'serve.lock.json'), JSON.stringify({ pid: process.ppid }));
    await expect(serve({ env: sb.env(), log: () => {}, transport: new FakeTransport() })).rejects.toThrow(/已经有一个 dario serve 在运行/);
  });

  it('停止后释放实例锁并关闭连接', async () => {
    setup();
    const transport = new FakeTransport();
    handle = await serve({ env: sb.env(), log: () => {}, transport });
    const lock = path.join(sb.home, 'state', 'serve.lock.json');
    expect(fs.existsSync(lock)).toBe(true);
    await handle.stop();
    handle = undefined;
    expect(transport.stopped).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

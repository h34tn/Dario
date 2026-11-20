import * as lark from '@larksuiteoapi/node-sdk';
import type { ChannelPort, InboundMessage } from '../core/ports.js';

/**
 * 飞书渠道。与飞书服务器的实际通信收在 FeishuTransport 里，
 * 渠道本身只做"事件 → 统一消息"的转换，便于不连飞书也能测试。
 */
export interface FeishuTransport {
  /** 建立长连接并开始接收 im.message.receive_v1 事件。 */
  start(onEvent: (data: unknown) => void): Promise<void>;
  stop(): Promise<void>;
  /** 在话题内回复一条文本消息。uuid 用于幂等。 */
  reply(messageId: string, text: string, uuid: string): Promise<void>;
  /** 机器人自己的 open_id，用来判断群消息是否 @了它。取不到时返回 undefined。 */
  botOpenId(): Promise<string | undefined>;
}

interface FeishuMention {
  key?: string;
  id?: { open_id?: string };
}

interface FeishuEvent {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  message?: {
    message_id?: string;
    root_id?: string;
    thread_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: FeishuMention[];
  };
}

/** 从富文本消息里取出纯文字。 */
function flattenPost(content: unknown): string {
  const body = (content as { content?: unknown; zh_cn?: { content?: unknown } } | undefined) ?? {};
  const rows = (body.content ?? body.zh_cn?.content) as unknown;
  if (!Array.isArray(rows)) return '';
  return rows
    .map((row) =>
      Array.isArray(row)
        ? row.map((cell: { tag?: string; text?: string }) => (cell?.tag === 'text' || cell?.tag === 'a' ? (cell.text ?? '') : '')).join('')
        : '',
    )
    .join('\n');
}

/**
 * 把飞书事件转成统一消息。返回 undefined 表示这条事件不该被处理
 *（机器人自己发的、群里没有 @机器人的）。
 */
export function toInbound(data: unknown, botOpenId: string | undefined): InboundMessage | undefined {
  const wrapper = data as { event?: FeishuEvent } & FeishuEvent;
  const ev: FeishuEvent = wrapper?.event ?? wrapper;
  const msg = ev?.message;
  const senderId = ev?.sender?.sender_id?.open_id;
  if (!msg?.message_id || !msg.chat_id || !senderId) return undefined;
  if (ev.sender?.sender_type && ev.sender.sender_type !== 'user') return undefined;

  const mentions = msg.mentions ?? [];
  const isDirect = msg.chat_type === 'p2p';
  if (!isDirect) {
    const mentioned = botOpenId ? mentions.some((m) => m.id?.open_id === botOpenId) : mentions.length > 0;
    if (!mentioned) return undefined;
  }

  let text = '';
  try {
    const content: unknown = JSON.parse(msg.content ?? '{}');
    if (msg.message_type === 'text') text = String((content as { text?: unknown }).text ?? '');
    else if (msg.message_type === 'post') text = flattenPost(content);
  } catch {
    text = '';
  }
  // 去掉 @ 占位符（如 @_user_1）
  for (const m of mentions) if (m.key) text = text.split(m.key).join(' ');
  text = text.replace(/@_all/g, ' ').replace(/[ \t]+/g, ' ').trim();

  return {
    channel: 'feishu',
    messageId: msg.message_id,
    conversation: msg.chat_id,
    threadKey: msg.root_id || msg.thread_id || msg.message_id,
    senderId,
    text,
    isDirect,
  };
}

export class FeishuChannel implements ChannelPort {
  readonly id = 'feishu';
  private botId?: string;

  constructor(private readonly transport: FeishuTransport) {}

  async start(onMessage: (message: InboundMessage) => void): Promise<void> {
    this.botId = await this.transport.botOpenId().catch(() => undefined);
    await this.transport.start((data) => {
      // 飞书要求 3 秒内处理完事件：这里只做转换和登记，实际工作在后台进行
      const message = toInbound(data, this.botId);
      if (message) onMessage(message);
    });
  }

  stop(): Promise<void> {
    return this.transport.stop();
  }

  reply(to: { conversation: string; messageId: string }, text: string, key: string): Promise<void> {
    return this.transport.reply(to.messageId, text, key);
  }
}

/** 用飞书官方 SDK 的长连接实现通信。本机主动连出，不监听任何端口。 */
export function createSdkTransport(appId: string, appSecret: string, log: (line: string) => void = () => {}): FeishuTransport {
  const client = new lark.Client({ appId, appSecret });
  const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn });
  return {
    async start(onEvent) {
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data: unknown) => {
          try {
            onEvent(data);
          } catch (e) {
            log(`处理飞书事件时出错：${(e as Error).message}`);
          }
        },
      });
      await ws.start({ eventDispatcher: dispatcher });
    },
    async stop() {
      ws.close({ force: true });
    },
    async reply(messageId, text, uuid) {
      const res = (await client.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
        data: { content: JSON.stringify({ text }), msg_type: 'text', reply_in_thread: true, uuid },
      })) as { code?: number; msg?: string };
      if (res?.code) throw new Error(`飞书回复失败（${res.code}）：${res.msg ?? ''}`);
    },
    async botOpenId() {
      const res = (await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as { bot?: { open_id?: string } };
      return res?.bot?.open_id;
    },
  };
}

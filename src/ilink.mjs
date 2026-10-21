// src/ilink.mjs
import { randomBytes } from 'node:crypto';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IlinkError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'IlinkError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function makeUin(random = randomBytes) {
  const v = random(4).readUInt32BE(0);
  return Buffer.from(String(v), 'utf8').toString('base64');
}

export function createIlink({
  creds,
  fetchImpl = globalThis.fetch,
  logger,
  channelVersion = '1.0.0',
  sleepImpl = sleep,
} = {}) {
  const baseUrl = () => creds?.baseUrl || DEFAULT_BASE;
  let cursor = '';

  async function request(path, { method = 'GET', body, headers = {}, timeoutMs = 20000, signal } = {}) {
    const t = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, t]) : t;

    let res;
    let text;
    try {
      res = await fetchImpl(`${baseUrl()}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(body ? { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${creds?.token}` } : {}),
          'X-WECHAT-UIN': makeUin(),
        },
        ...(body ? { body: JSON.stringify({ ...body, base_info: { channel_version: channelVersion } }) } : {}),
        signal: combined,
      });
      text = await res.text();
    } catch (e) {
      if (signal?.aborted) throw new IlinkError('aborted', '请求被取消', { cause: e });
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new IlinkError('network', `请求超时: ${path}`, { cause: e });
      }
      throw new IlinkError('network', `网络错误: ${path} (${e.message})`, { cause: e });
    }

    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new IlinkError('server', `响应不是 JSON: ${path} (${text.slice(0, 200)})`);
    }

    const ret = json.ret ?? json.errcode;
    if (ret === -14) throw new IlinkError('session-expired', 'session 过期，需要重新扫码', { ret });
    if (res.status === 401 || res.status === 403) {
      throw new IlinkError('auth', `鉴权失败 ${res.status}: ${path}`, { ret });
    }
    if (!res.ok) throw new IlinkError('server', `HTTP 错误 ${res.status}: ${path}`, { ret });
    if (ret !== undefined && ret !== 0) {
      throw new IlinkError('server', `业务错误 ret=${ret}: ${path} ${json.errmsg ?? ''}`, { ret });
    }
    return json;
  }

  // request 层把「本地超时」和「真实传输故障」都归一成 kind='network'，只能靠 cause 名区分。
  // 长轮询被服务端 hold 住时本地超时是正常的，等同于「没有新消息」；而 DNS 失败、连接被拒、
  // TLS 错误等真实故障绝不能这样吞掉——否则上层会零延迟热重试、且不留任何错误日志。
  function isEmptyPoll(e, signal) {
    return e.kind === 'network' && e.cause?.name === 'TimeoutError' && !signal?.aborted;
  }

  // 统一的发消息封装：文本和媒体共用同一个消息信封，避免两处漂移。
  async function postItem({ toUserId, contextToken, item }) {
    const json = await request('/ilink/bot/sendmessage', {
      method: 'POST',
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: `wechat-bridge:${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [item],
        },
      },
    });
    return { messageId: json.message_id ?? null };
  }

  return {
    get creds() {
      return creds;
    },
    get cursor() {
      return cursor;
    },
    set cursor(v) {
      cursor = typeof v === 'string' ? v : '';
    },
    request,
    get: (path, opts = {}) => request(path, { ...opts, method: 'GET' }),
    post: (path, body, opts = {}) => request(path, { ...opts, method: 'POST', body }),
    sleep: sleepImpl,

    async login({ onQr, signal } = {}) {
      for (;;) {
        const qr = await request('/ilink/bot/get_bot_qrcode?bot_type=3', { signal });
        if (qr.ret !== 0 || !qr.qrcode) {
          throw new IlinkError('server', `取二维码失败: ${JSON.stringify(qr).slice(0, 200)}`);
        }
        await onQr?.({ qrcode: qr.qrcode, url: qr.qrcode_img_content });
        logger?.info?.(`已生成登录二维码 qrcode=${qr.qrcode}`);

        for (;;) {
          const st = await request(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, {
            headers: { 'iLink-App-ClientVersion': '1' },
            timeoutMs: 40000,
            signal,
          }).catch((e) => {
            if (isEmptyPoll(e, signal)) return { status: 'wait' };
            throw e;
          });

          if (st.status === 'confirmed') {
            return {
              token: st.bot_token,
              baseUrl: st.baseurl || DEFAULT_BASE,
              accountId: st.ilink_bot_id,
              userId: st.ilink_user_id,
              savedAt: new Date().toISOString(),
            };
          }
          if (st.status === 'expired') break;
          await sleepImpl(1200);
        }
      }
    },

    async poll({ signal, timeoutMs = 40000 } = {}) {
      let json;
      try {
        json = await request('/ilink/bot/getupdates', {
          method: 'POST',
          body: { get_updates_buf: cursor ?? '' },
          timeoutMs,
          signal,
        });
      } catch (e) {
        if (isEmptyPoll(e, signal)) return { msgs: [], cursor: undefined };
        throw e;
      }
      if (json.get_updates_buf) cursor = json.get_updates_buf;
      return { msgs: json.msgs ?? [], cursor: json.get_updates_buf };
    },

    async sendItem({ toUserId, contextToken, item }) {
      return postItem({ toUserId, contextToken, item });
    },

    async sendText({ toUserId, contextToken, text }) {
      return postItem({ toUserId, contextToken, item: { type: 1, text_item: { text } } });
    },

    async sendTyping({ toUserId, contextToken, status }) {
      try {
        const cfg = await request('/ilink/bot/getconfig', {
          method: 'POST',
          body: { ilink_user_id: toUserId, ...(contextToken ? { context_token: contextToken } : {}) },
        });
        if (!cfg.typing_ticket) return;
        await request('/ilink/bot/sendtyping', {
          method: 'POST',
          body: { ilink_user_id: toUserId, typing_ticket: cfg.typing_ticket, status },
        });
      } catch (e) {
        if (e.kind === 'session-expired') throw e;
        logger?.warn?.(`sendTyping 失败（忽略）: ${e.message}`);
      }
    },
  };
}

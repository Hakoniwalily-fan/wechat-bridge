// test/ilink-transport.test.mjs
// Fix round 1 回归：只有「本地超时」可以吞掉，真实传输故障必须抛出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIlink } from '../src/ilink.mjs';

const creds = { token: 'tk', baseUrl: 'https://e.test' };

const QR = { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x?qrcode=qr-1' };

// AbortSignal.timeout 在 fetch 处抛出的就是这种 DOMException
const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

const jsonResponse = (payload) => ({ status: 200, ok: true, text: async () => JSON.stringify(payload) });

test('poll 真实传输故障（非超时）必须抛出', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const ilink = createIlink({ creds, fetchImpl });
  await assert.rejects(() => ilink.poll({}), (e) => {
    assert.equal(e.kind, 'network');
    return true;
  });
});

test('poll 本地超时（DOMException TimeoutError）仍当作空轮询', async () => {
  const fetchImpl = async () => {
    throw timeoutError();
  };
  const ilink = createIlink({ creds, fetchImpl });
  const out = await ilink.poll({});
  assert.deepEqual(out, { msgs: [], cursor: undefined });
});

test('poll 调用方 abort 必须抛出而不是空轮询', async () => {
  const ac = new AbortController();
  const fetchImpl = async () => {
    ac.abort();
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  const ilink = createIlink({ creds, fetchImpl });
  await assert.rejects(() => ilink.poll({ signal: ac.signal }), (e) => {
    assert.equal(e.kind, 'aborted');
    return true;
  });
});

test('login 状态请求真实传输故障必须抛出，不能继续重试', async () => {
  let statusCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('get_bot_qrcode')) return jsonResponse(QR);
    statusCalls += 1;
    // 前两次给「真实故障」，第三次给 confirmed：若实现仍把故障当 wait，
    // 登录会最终成功、断言失败——测试因此必定终止，不会挂死。
    if (statusCalls < 3) throw new TypeError('fetch failed');
    return jsonResponse({ status: 'confirmed', bot_token: 'tk', ilink_bot_id: 'b@im.bot', ilink_user_id: 'u@im.wechat' });
  };
  const ilink = createIlink({ creds, fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(
    () => ilink.login({}),
    (e) => {
      assert.equal(e.kind, 'network');
      assert.equal(statusCalls, 1);
      return true;
    },
  );
});

test('login 状态请求本地超时仍继续等待', async () => {
  let statusCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('get_bot_qrcode')) return jsonResponse(QR);
    statusCalls += 1;
    if (statusCalls === 1) throw timeoutError();
    return jsonResponse({ status: 'confirmed', bot_token: 'tk-t', ilink_bot_id: 'b@im.bot', ilink_user_id: 'u@im.wechat' });
  };
  const ilink = createIlink({ creds, fetchImpl, sleepImpl: async () => {} });
  const seen = [];
  const out = await ilink.login({ onQr: (q) => seen.push(q) });
  assert.equal(out.token, 'tk-t');
  assert.equal(statusCalls, 2);
  assert.equal(seen.length, 1);
});

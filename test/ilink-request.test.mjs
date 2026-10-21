// test/ilink-request.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUin, createIlink, IlinkError } from '../src/ilink.mjs';

function captureFetch(response = { ret: 0 }, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status < 400,
      text: async () => JSON.stringify(response),
      json: async () => response,
    };
  };
  return { fetchImpl, calls };
}

test('makeUin 解出来是十进制数字且每次都变', () => {
  const a = makeUin();
  const b = makeUin();
  const decoded = Buffer.from(a, 'base64').toString('utf8');
  assert.match(decoded, /^\d+$/);
  assert.ok(a !== b);
});

test('业务请求带齐四个头与 base_info', async () => {
  const { fetchImpl, calls } = captureFetch();
  const ilink = createIlink({
    creds: { token: 'tok123', baseUrl: 'https://example.test' },
    fetchImpl,
  });
  await ilink.post('/ilink/bot/getconfig', { ilink_user_id: 'u1' });
  const { url, init } = calls[0];
  assert.equal(url, 'https://example.test/ilink/bot/getconfig');
  assert.equal(init.headers.Authorization, 'Bearer tok123');
  assert.equal(init.headers.AuthorizationType, 'ilink_bot_token');
  assert.match(Buffer.from(init.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  const body = JSON.parse(init.body);
  assert.deepEqual(body.base_info, { channel_version: '1.0.0' });
  assert.equal(body.ilink_user_id, 'u1');
});

test('ret=-14 归一为 session-expired', async () => {
  const { fetchImpl } = captureFetch({ ret: -14, errmsg: 'session timeout' });
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => {
    assert.ok(e instanceof IlinkError);
    assert.equal(e.kind, 'session-expired');
    return true;
  });
});

test('5xx 归一为 server', async () => {
  const { fetchImpl } = captureFetch({}, 502);
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => e.kind === 'server');
});

test('fetch 抛错归一为 network', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => e.kind === 'network');
});

test('401 空 body 归一为 auth，且错误消息不含 token', async () => {
  const { fetchImpl } = captureFetch({}, 401);
  const ilink = createIlink({ creds: { token: 'tok-secret-123', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => {
    assert.ok(e instanceof IlinkError);
    assert.equal(e.kind, 'auth');
    assert.ok(!e.message.includes('tok-secret-123'), '错误消息不得包含 token');
    return true;
  });
});

test('403 空 body 归一为 auth', async () => {
  const { fetchImpl } = captureFetch({}, 403);
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => e.kind === 'auth');
});

test('404 空 body 归一为 server（其余非 2xx）', async () => {
  const { fetchImpl } = captureFetch({}, 404);
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => e.kind === 'server');
});

test('ret=-14 优先于 401：session 过期仍归 session-expired', async () => {
  const { fetchImpl } = captureFetch({ ret: -14 }, 401);
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => e.kind === 'session-expired');
});

test('读 body 时超时归一为 network', async () => {
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    text: async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    },
  });
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => {
    assert.ok(e instanceof IlinkError);
    assert.equal(e.kind, 'network');
    return true;
  });
});

test('读 body 时调用方取消归一为 aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    text: async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    },
  });
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}, { signal: controller.signal }), (e) => e.kind === 'aborted');
});

test('调用方取消时，自定义原因的错误也归一为 aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('用户取消'));
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}, { signal: controller.signal }), (e) => {
    assert.equal(e.kind, 'aborted');
    return true;
  });
});

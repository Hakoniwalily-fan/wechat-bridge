// test/ilink-messaging.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIlink } from '../src/ilink.mjs';

function okFetch(payload = { ret: 0 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
}

const creds = { token: 'tk', baseUrl: 'https://e.test' };

test('poll 回传游标并解析消息', async () => {
  const { fetchImpl, calls } = okFetch({
    ret: 0,
    msgs: [{ message_id: 1, from_user_id: 'u@im.wechat', context_token: 'ct', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    get_updates_buf: 'CURSOR-2',
  });
  const ilink = createIlink({ creds, fetchImpl });
  const out = await ilink.poll({});
  assert.equal(out.msgs.length, 1);
  assert.equal(out.cursor, 'CURSOR-2');
  assert.equal(calls[0].body.get_updates_buf, '');
});

test('poll 本地超时当作空轮询', async () => {
  const fetchImpl = async () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  };
  const ilink = createIlink({ creds, fetchImpl });
  const out = await ilink.poll({});
  assert.deepEqual(out, { msgs: [], cursor: undefined });
});

test('sendText 带 context_token、message_type=2、message_state=2', async () => {
  const { fetchImpl, calls } = okFetch({ message_id: 99 });
  const ilink = createIlink({ creds, fetchImpl });
  const out = await ilink.sendText({ toUserId: 'u@im.wechat', contextToken: 'CT', text: 'hello' });
  assert.equal(out.messageId, 99);
  const msg = calls[0].body.msg;
  assert.equal(msg.to_user_id, 'u@im.wechat');
  assert.equal(msg.context_token, 'CT');
  assert.equal(msg.message_type, 2);
  assert.equal(msg.message_state, 2);
  assert.deepEqual(msg.item_list, [{ type: 1, text_item: { text: 'hello' } }]);
  assert.ok(msg.client_id);
});

test('每次发送的 client_id 都不同', async () => {
  const { fetchImpl, calls } = okFetch({ message_id: 1 });
  const ilink = createIlink({ creds, fetchImpl });
  await ilink.sendText({ toUserId: 'u', contextToken: 'c', text: 'a' });
  await ilink.sendText({ toUserId: 'u', contextToken: 'c', text: 'b' });
  assert.notEqual(calls[0].body.msg.client_id, calls[1].body.msg.client_id);
});

test('sendTyping 失败不抛', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const ilink = createIlink({ creds, fetchImpl });
  await assert.doesNotReject(() => ilink.sendTyping({ toUserId: 'u', contextToken: 'c', status: 1 }));
});

test('游标可通过属性读写', () => {
  const ilink = createIlink({ creds, fetchImpl: async () => ({}) });
  ilink.cursor = 'C1';
  assert.equal(ilink.cursor, 'C1');
});

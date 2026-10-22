// test/integration.test.mjs
// 全链路：真实 http.createServer 假 iLink + 真实 createIlink/createRouter。
// 不碰真实网络、不跑登录、不启 dsh（runner 是假的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createIlink } from '../src/ilink.mjs';
import { createRouter } from '../src/router.mjs';

function startFakeIlink() {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      received.push({ url: req.url, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/ilink/bot/getconfig')) {
        return res.end(JSON.stringify({ ret: 0, typing_ticket: 'tt' }));
      }
      if (req.url.startsWith('/ilink/bot/sendtyping')) {
        return res.end(JSON.stringify({ ret: 0 }));
      }
      if (req.url.startsWith('/ilink/bot/sendmessage')) {
        return res.end(JSON.stringify({ ret: 0, message_id: 777 }));
      }
      return res.end(JSON.stringify({ ret: 0 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        received,
        port: server.address().port,
        // 收尾必须彻底：router 在任务结束时还有一条 fire-and-forget 的 typing 请求，
        // 只 close 不销毁连接会让 --test 挂着不退。
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

test('全链路：消息进来，两条消息出去，头和 context_token 都对', async () => {
  const { received, port, close } = await startFakeIlink();
  try {
    const ilink = createIlink({ creds: { token: 'tok', baseUrl: `http://127.0.0.1:${port}` } });
    const data = new Map();
    const store = {
      read: (k, f) => (data.has(k) ? data.get(k) : f),
      write: (k, v) => data.set(k, v),
    };
    const runnerCalls = [];
    const router = createRouter({
      ilink,
      runner: {
        run: async ({ taskText }) => {
          runnerCalls.push(taskText);
          return {
            sessionId: 's1',
            finalText: '这是回答',
            text: '这是回答',
            totalTokens: 5,
            turns: 1,
            exitCode: 0,
            stderrTail: '',
            timedOut: false,
          };
        },
      },
      store,
      logger: { info() {}, warn() {}, error() {} },
      ownerId: 'u@im.wechat',
      preamble: '',
    });

    await router.handle({
      message_id: 1,
      message_type: 1,
      from_user_id: 'u@im.wechat',
      context_token: 'CT-1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    });
    await router.idle();

    const sends = received.filter((r) => r.url.startsWith('/ilink/bot/sendmessage'));
    // 只剩回答本身，开工回执已去掉
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.msg.item_list[0].text_item.text, '这是回答');

    for (const s of sends) {
      assert.equal(s.body.msg.context_token, 'CT-1');
      assert.equal(s.body.msg.to_user_id, 'u@im.wechat');
      assert.equal(s.headers.authorization, 'Bearer tok');
      assert.equal(s.headers.authorizationtype, 'ilink_bot_token');
      assert.ok(s.headers['x-wechat-uin'], '缺少 X-WECHAT-UIN');
      assert.match(Buffer.from(s.headers['x-wechat-uin'], 'base64').toString('utf8'), /^\d+$/);
      assert.deepEqual(s.body.base_info, { channel_version: '1.0.0' });
    }

    // 回答确实来自 runner，而不是某种兜底文案
    assert.deepEqual(runnerCalls, ['你好']);
  } finally {
    await close();
  }
});

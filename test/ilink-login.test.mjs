// test/ilink-login.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIlink } from '../src/ilink.mjs';

function scriptedFetch(script) {
  let i = 0;
  return async (url) => {
    const step = script[i++] ?? script[script.length - 1];
    return { status: 200, ok: true, text: async () => JSON.stringify(step) };
  };
}

const QR = { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x?qrcode=qr-1' };

test('wait → confirmed 时返回凭证', async () => {
  const fetchImpl = scriptedFetch([
    QR,
    { status: 'wait' },
    { status: 'scaned' },
    {
      status: 'confirmed',
      bot_token: 'tk',
      ilink_bot_id: 'b@im.bot',
      ilink_user_id: 'u@im.wechat',
      baseurl: 'https://ilinkai.weixin.qq.com',
    },
  ]);
  const seen = [];
  const ilink = createIlink({ fetchImpl, sleepImpl: async () => {} });
  const creds = await ilink.login({ onQr: (q) => seen.push(q) });

  assert.equal(creds.token, 'tk');
  assert.equal(creds.accountId, 'b@im.bot');
  assert.equal(creds.userId, 'u@im.wechat');
  assert.equal(creds.baseUrl, 'https://ilinkai.weixin.qq.com');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, QR.qrcode_img_content);
});

test('二维码过期时重新申请', async () => {
  const fetchImpl = scriptedFetch([
    QR,
    { status: 'expired' },
    { ...QR, qrcode: 'qr-2', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/y?qrcode=qr-2' },
    { status: 'confirmed', bot_token: 'tk2', ilink_bot_id: 'b2@im.bot', ilink_user_id: 'u2@im.wechat' },
  ]);
  const seen = [];
  const ilink = createIlink({ fetchImpl, sleepImpl: async () => {} });
  const creds = await ilink.login({ onQr: (q) => seen.push(q) });

  assert.equal(creds.token, 'tk2');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].qrcode, 'qr-2');
});

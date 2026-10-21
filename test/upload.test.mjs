import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSendMarkers, mediaTypeFor, cipherSize, createUploader } from '../src/upload.mjs';

function fakeIlink() {
  const posts = [];
  const items = [];
  return {
    posts,
    items,
    post: async (path, body) => {
      posts.push({ path, body });
      return { upload_param: 'UP PARAM' };
    },
    sendItem: async ({ item }) => {
      items.push(item);
      return { messageId: 99 };
    },
  };
}

function okFetch(header = 'ENC-PARAM') {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, headers: { get: (n) => (n.toLowerCase() === 'x-encrypted-param' ? header : null) } };
  };
  return { fetchImpl, calls };
}

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'up-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

test('parseSendMarkers 抽出路径并去掉标记', () => {
  const out = parseSendMarkers('报告好了。\n[[send: D:\\a\\b.pptx]]\n还需要别的吗？');
  assert.deepEqual(out.paths, ['D:\\a\\b.pptx']);
  assert.equal(out.text, '报告好了。\n\n还需要别的吗？');
  assert.ok(!out.text.includes('[['));
});

test('parseSendMarkers 支持多个、大小写、多余空格', () => {
  const out = parseSendMarkers('[[SEND:  a.txt ]][[ Send : b.png ]] 完事');
  assert.deepEqual(out.paths, ['a.txt', 'b.png']);
  assert.equal(out.text, '完事');
});

test('parseSendMarkers 没有标记时原样返回', () => {
  const out = parseSendMarkers('普通回答');
  assert.deepEqual(out.paths, []);
  assert.equal(out.text, '普通回答');
});

test('mediaTypeFor 按扩展名判图片/文件', () => {
  assert.equal(mediaTypeFor('a.PNG'), 1);
  assert.equal(mediaTypeFor('a.jpeg'), 1);
  assert.equal(mediaTypeFor('a.webp'), 1);
  assert.equal(mediaTypeFor('a.docx'), 3);
  assert.equal(mediaTypeFor('noext'), 3);
});

test('cipherSize 按 PKCS7 向上取整', () => {
  assert.equal(cipherSize(0), 16);
  assert.equal(cipherSize(15), 16);
  assert.equal(cipherSize(16), 32);
  assert.equal(cipherSize(17), 32);
  assert.equal(cipherSize(100), 112);
});

test('sendFile 走完 getuploadurl → 加密上传 → sendmessage，文件消息形状正确', async () => {
  const content = Buffer.from('hello attachment');
  const p = tmpFile('报告.docx', content);
  const ilink = fakeIlink();
  const { fetchImpl, calls } = okFetch();
  const up = createUploader({ ilink, fetchImpl });

  const out = await up.sendFile({ toUserId: 'u@im.wechat', contextToken: 'CT', path: p });

  assert.equal(out.kind, 'file');
  assert.equal(out.bytes, content.length);
  assert.equal(out.name, '报告.docx');

  const [getUrl, send] = ilink.posts;
  assert.equal(getUrl.path, '/ilink/bot/getuploadurl');
  assert.equal(getUrl.body.media_type, 3);
  assert.equal(getUrl.body.to_user_id, 'u@im.wechat');
  assert.equal(getUrl.body.rawsize, content.length);
  assert.equal(getUrl.body.filesize, cipherSize(content.length));
  assert.equal(getUrl.body.no_need_thumb, true);
  assert.equal(getUrl.body.rawfilemd5, createHash('md5').update(content).digest('hex'));
  assert.match(getUrl.body.aeskey, /^[0-9a-f]{32}$/);
  assert.match(getUrl.body.filekey, /^[0-9a-f]{32}$/);
  assert.equal(send, undefined, '本用例中 sendmessage 由 ilink.sendItem 承接');

  // CDN 上传：URL 带参数，body 是能用 aeskey 解开的密文
  assert.match(calls[0].url, /encrypted_query_param=UP%20PARAM/);
  assert.match(calls[0].url, /filekey=/);
  const key = Buffer.from(getUrl.body.aeskey, 'hex');
  const dec = createDecipheriv('aes-128-ecb', key, null);
  const plain = Buffer.concat([dec.update(calls[0].init.body), dec.final()]);
  assert.deepEqual(plain, content);

  const item = ilink.items[0];
  assert.equal(item.type, 4);
  assert.equal(item.file_item.file_name, '报告.docx');
  assert.equal(item.file_item.len, String(content.length));
  assert.equal(item.file_item.media.encrypt_query_param, 'ENC-PARAM');
  assert.equal(item.file_item.media.encrypt_type, 1);
  // 出站 aes_key 必须是 base64(hex 字符串)
  assert.equal(item.file_item.media.aes_key, Buffer.from(getUrl.body.aeskey, 'latin1').toString('base64'));
});

test('sendFile 图片走 image_item 并带 mid_size', async () => {
  const p = tmpFile('shot.png', Buffer.from('PNGDATA'));
  const ilink = fakeIlink();
  const up = createUploader({ ilink, fetchImpl: okFetch().fetchImpl });

  await up.sendFile({ toUserId: 'u', contextToken: 'CT', path: p });

  assert.equal(ilink.posts[0].body.media_type, 1);
  const item = ilink.items[0];
  assert.equal(item.type, 2);
  assert.equal(item.image_item.mid_size, cipherSize(8));
});

test('文件不存在、超限、上传失败、缺响应头都给出可读原因', async () => {
  const ilink = fakeIlink();

  await assert.rejects(
    () => createUploader({ ilink, fetchImpl: okFetch().fetchImpl }).sendFile({ toUserId: 'u', contextToken: 'c', path: join(tmpdir(), 'nope-xyz.bin') }),
    /文件不存在/,
  );

  const big = tmpFile('big.bin', Buffer.alloc(64));
  await assert.rejects(
    () => createUploader({ ilink, fetchImpl: okFetch().fetchImpl, maxBytes: 10 }).sendFile({ toUserId: 'u', contextToken: 'c', path: big }),
    /MB 上限/,
  );

  const p = tmpFile('a.txt', Buffer.from('x'));
  await assert.rejects(
    () => createUploader({ ilink, fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null } }) }).sendFile({ toUserId: 'u', contextToken: 'c', path: p }),
    /HTTP 500/,
  );

  await assert.rejects(
    () => createUploader({ ilink, fetchImpl: okFetch(null).fetchImpl }).sendFile({ toUserId: 'u', contextToken: 'c', path: p }),
    /x-encrypted-param/,
  );
});

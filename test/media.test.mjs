import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mediaKind,
  decodeAesKey,
  decryptEcb,
  safeFileName,
  guessExt,
  createMediaStore,
  DEFAULT_MAX_BYTES,
  pruneInbox,
} from '../src/media.mjs';

const KEY_HEX = '00112233445566778899aabbccddeeff';
const KEY = Buffer.from(KEY_HEX, 'hex');

function encrypt(plain) {
  const c = createCipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([c.update(plain), c.final()]);
}

function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status < 400,
      status,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
  return { fetchImpl, calls };
}

test('mediaKind 映射微信的 item type', () => {
  assert.equal(mediaKind({ type: 2 }), 'image');
  assert.equal(mediaKind({ type: 3 }), 'voice');
  assert.equal(mediaKind({ type: 4 }), 'file');
  assert.equal(mediaKind({ type: 5 }), 'video');
  assert.equal(mediaKind({ type: 1 }), null);
  assert.equal(mediaKind({}), null);
});

test('decodeAesKey 认 base64(16 字节)', () => {
  const media = { aes_key: KEY.toString('base64') };
  assert.deepEqual(decodeAesKey(media), KEY);
});

test('decodeAesKey 认 base64(32 个 hex 字符)', () => {
  const media = { aes_key: Buffer.from(KEY_HEX, 'latin1').toString('base64') };
  assert.deepEqual(decodeAesKey(media), KEY);
});

test('decodeAesKey 认纯 hex，且优先于 media.aes_key', () => {
  assert.deepEqual(decodeAesKey({ aes_key: 'garbage' }, KEY_HEX), KEY);
});

test('decodeAesKey 缺 key 或长度不对时抛错', () => {
  assert.throws(() => decodeAesKey({}), /aes_key/);
  assert.throws(() => decodeAesKey({ aes_key: Buffer.from('short').toString('base64') }), /无法识别/);
});

test('decryptEcb 能还原密文', () => {
  const plain = Buffer.from('hello wechat media', 'utf8');
  assert.deepEqual(decryptEcb(encrypt(plain), KEY), plain);
});

test('safeFileName 挡住路径穿越与非法字符', () => {
  assert.equal(safeFileName('..\\..\\evil.txt'), 'evil.txt');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a/b\\c.txt'), 'c.txt');
  assert.equal(safeFileName('bad:name?.txt'), 'bad_name_.txt');
  assert.equal(safeFileName(''), 'attachment');
  assert.equal(safeFileName('...'), 'attachment');
  assert.equal(safeFileName(null, 'fallback.bin'), 'fallback.bin');
});

test('guessExt 按魔数判类型', () => {
  assert.equal(guessExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(guessExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])), 'png');
  assert.equal(guessExt(Buffer.from('GIF89a')), 'gif');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(guessExt(webp), 'webp');
  assert.equal(guessExt(Buffer.from('plain text')), 'bin');
});

test('saveInbound 下载、解密、落盘，图片按魔数定扩展名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fakejpeg')]);
  const { fetchImpl, calls } = fakeFetch(encrypt(plain));
  const store = createMediaStore({ dir, fetchImpl, now: () => new Date('2026-10-21T03:04:05Z') });

  const out = await store.saveInbound({
    item: { type: 2, image_item: { media: { encrypt_query_param: 'PARAM+/=', aes_key: KEY.toString('base64') } } },
    messageId: 42,
  });

  assert.equal(out.kind, 'image');
  assert.equal(out.bytes, plain.length);
  assert.ok(out.path.includes(join(dir, '2026-10-21')));
  assert.match(out.path, /image-42\.jpg$/);
  assert.deepEqual(readFileSync(out.path), plain);
  assert.match(calls[0].url, /encrypted_query_param=PARAM%2B%2F%3D/);
});

test('saveInbound 对文件名做安全处理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const plain = Buffer.from('PDFDATA');
  const { fetchImpl } = fakeFetch(encrypt(plain));
  const store = createMediaStore({ dir, fetchImpl, now: () => new Date('2026-10-21T03:04:05Z') });

  const out = await store.saveInbound({
    item: {
      type: 4,
      file_item: { file_name: '..\\..\\预算.xlsx', len: String(plain.length), media: { encrypt_query_param: 'p', aes_key: KEY.toString('base64') } },
    },
    messageId: 7,
  });

  assert.equal(out.name, '预算.xlsx');
  assert.equal(out.path, join(dir, '2026-10-21', '预算.xlsx'));
  assert.ok(existsSync(out.path));
});

test('saveInbound 语音带回微信转写并落 silk 文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const plain = Buffer.from('SILKDATA');
  const { fetchImpl } = fakeFetch(encrypt(plain));
  const store = createMediaStore({ dir, fetchImpl, now: () => new Date('2026-10-21T03:04:05Z') });

  const out = await store.saveInbound({
    item: { type: 3, voice_item: { text: '下午三点到', media: { encrypt_query_param: 'p', aes_key: KEY.toString('base64') } } },
    messageId: 9,
  });

  assert.equal(out.kind, 'voice');
  assert.equal(out.text, '下午三点到');
  assert.match(out.path, /voice-9\.silk$/);
});

test('声明大小超限时直接拒绝，不去下载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const { fetchImpl, calls } = fakeFetch(encrypt(Buffer.from('x')));
  const store = createMediaStore({ dir, fetchImpl, maxBytes: 10 });

  await assert.rejects(
    () =>
      store.saveInbound({
        item: { type: 4, file_item: { file_name: 'big.bin', len: '99', media: { encrypt_query_param: 'p', aes_key: KEY.toString('base64') } } },
        messageId: 1,
      }),
    (e) => e.code === 'too-large',
  );
  assert.equal(calls.length, 0);
});

test('下载失败与解密失败给出可读原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const bad = createMediaStore({ dir, fetchImpl: fakeFetch(Buffer.from('x'), { status: 403 }).fetchImpl });
  await assert.rejects(
    () => bad.saveInbound({ item: { type: 2, image_item: { media: { encrypt_query_param: 'p', aes_key: KEY.toString('base64') } } }, messageId: 1 }),
    /HTTP 403/,
  );

  const wrongKey = Buffer.alloc(16, 7);
  const wrong = createMediaStore({ dir, fetchImpl: fakeFetch(encrypt(Buffer.from('data'))).fetchImpl });
  await assert.rejects(
    () =>
      wrong.saveInbound({
        item: { type: 2, image_item: { media: { encrypt_query_param: 'p', aes_key: wrongKey.toString('base64') } } },
        messageId: 1,
      }),
    /解密失败/,
  );
});

test('缺少 CDN 引用时报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const store = createMediaStore({ dir, fetchImpl: async () => ({}) });
  await assert.rejects(() => store.saveInbound({ item: { type: 2, image_item: {} }, messageId: 1 }), /CDN 引用/);
});

test('默认上限是 20 MB', () => {
  assert.equal(DEFAULT_MAX_BYTES, 20 * 1024 * 1024);
});

test('落盘目录按天创建，不会写进目录之外', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const { fetchImpl } = fakeFetch(encrypt(Buffer.from('x')));
  const store = createMediaStore({ dir, fetchImpl, now: () => new Date('2026-10-21T23:59:00Z') });
  const out = await store.saveInbound({
    item: { type: 4, file_item: { file_name: '../../../escape.txt', media: { encrypt_query_param: 'p', aes_key: KEY.toString('base64') } } },
    messageId: 3,
  });
  assert.equal(readdirSync(dir).length, 1);
  assert.ok(out.path.startsWith(dir));
  assert.equal(out.name, 'escape.txt');
});

// ---- 保留期清理 ----

test('pruneInbox 删掉超过保留期的文件，留下新的', async () => {
  const { mkdirSync, writeFileSync, utimesSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'prune-'));
  const old = join(dir, '2026-10-01');
  const fresh = join(dir, '2026-10-21');
  mkdirSync(old);
  mkdirSync(fresh);
  const oldFile = join(old, 'a.jpg');
  const freshFile = join(fresh, 'b.jpg');
  writeFileSync(oldFile, 'x');
  writeFileSync(freshFile, 'y');
  const tenDaysAgo = (Date.now() - 10 * 86400000) / 1000;
  utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

  const out = pruneInbox(dir, { days: 7, now: () => new Date() });

  assert.equal(out.removed, 1);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(freshFile), true);
  assert.equal(existsSync(fresh), true);
});

test('pruneInbox 删空目录，但保留还有文件的目录', async () => {
  const { mkdirSync, writeFileSync, utimesSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'prune-'));
  const a = join(dir, '2026-10-01');
  const b = join(dir, '2026-10-20');
  mkdirSync(a);
  mkdirSync(b);
  const f = join(a, 'old.txt');
  writeFileSync(f, 'x');
  const body = join(b, 'keep.txt');
  writeFileSync(body, 'y');
  const tenDaysAgo = (Date.now() - 10 * 86400000) / 1000;
  utimesSync(f, tenDaysAgo, tenDaysAgo);

  const out = pruneInbox(dir, { days: 7, now: () => new Date() });

  assert.equal(out.removed, 1);
  assert.equal(out.dirs, 1);
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(b), true);
});

test('pruneInbox 对不存在的目录不抛错', () => {
  assert.deepEqual(pruneInbox(join(tmpdir(), 'definitely-missing-dir-xyz'), { days: 7 }), { removed: 0, dirs: 0 });
});

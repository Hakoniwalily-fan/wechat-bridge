// test/qr.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderQr } from '../src/qr.mjs';

test('渲染终端字符画并落 PNG', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qr-'));
  const pngPath = join(dir, 'qr.png');
  const out = await renderQr('https://liteapp.weixin.qq.com/q/abc?qrcode=def', { pngPath });
  assert.ok(out.ascii.length > 50);
  assert.equal(out.pngPath, pngPath);
  assert.ok(statSync(pngPath).size > 0);
});

test('不传 pngPath 时只出字符画', async () => {
  const out = await renderQr('https://example.com/x', {});
  assert.equal(out.pngPath, null);
  assert.ok(out.ascii.length > 50);
});

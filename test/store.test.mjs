// test/store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';

test('读不存在的文件返回 fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = createStore(dir);
  assert.deepEqual(store.read('nope.json', { a: 1 }), { a: 1 });
});

test('写入后能读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = createStore(dir);
  store.write('creds.json', { token: 'x' });
  assert.deepEqual(store.read('creds.json', null), { token: 'x' });
});

test('文件损坏时回退并告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  const warnings = [];
  const store = createStore(dir, { logger: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(store.read('bad.json', { ok: true }), { ok: true });
  assert.equal(warnings.length, 1);
});

test('损坏告警不泄露文件内容（token 明文）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  // Node 的 JSON 语法错误会把出错位置附近的原文片段带进 e.message，
  // 这里把 token 明文和字段名都放进出错片段里
  writeFileSync(join(dir, 'creds.json'), '{"bot_token": ilinkbot_secret123}');
  const warnings = [];
  const store = createStore(dir, { logger: { warn: (m) => warnings.push(m) } });

  assert.deepEqual(store.read('creds.json', { ok: true }), { ok: true });
  assert.equal(warnings.length, 1);
  const w = warnings[0];
  assert.equal(w.includes('ilinkbot_secret123'), false, '告警不得出现 token 明文');
  assert.equal(w.includes('ilinkbot_s'), false, '告警不得出现 token 片段');
  assert.equal(w.includes('bot_token'), false, '告警不得出现字段名');
});

test('写入是原子的，不留 .tmp 残留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = createStore(dir);
  store.write('a.json', { n: 1 });
  store.write('a.json', { n: 2 });
  assert.deepEqual(store.read('a.json', null), { n: 2 });
  assert.deepEqual(readdirSync(dir), ['a.json']);
});

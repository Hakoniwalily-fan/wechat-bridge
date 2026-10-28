import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey, buildChildEnv } from '../src/credentials.mjs';

function storeWith(key) {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  const p = join(dir, '.credentials.yaml');
  writeFileSync(p, `version: 1\nrecords:\n  - kind: grant\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n`, 'utf8');
  return p;
}

test('优先用环境变量里的 key', () => {
  const p = storeWith('sk-fromstore');
  assert.equal(resolveApiKey({ env: { DEEPSEEK_API_KEY: 'sk-fromenv' }, storePath: p }), 'sk-fromenv');
});

test('环境变量没有时从凭证库 refs 里取', () => {
  const p = storeWith('sk-fromstore');
  assert.equal(resolveApiKey({ env: {}, storePath: p }), 'sk-fromstore');
});

test('两处都没有时返回 null', () => {
  const p = storeWith('');
  assert.equal(resolveApiKey({ env: {}, storePath: p }), null);
  assert.equal(resolveApiKey({ env: {}, storePath: join(tmpdir(), 'no-such-cred-file.yaml') }), null);
});

test('空字符串环境变量视为没有', () => {
  const p = storeWith('sk-fromstore');
  assert.equal(resolveApiKey({ env: { DEEPSEEK_API_KEY: '   ' }, storePath: p }), 'sk-fromstore');
});

test('凭证库格式不认识时返回 null，不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  const p = join(dir, 'bad.yaml');
  writeFileSync(p, 'version: 1\nrecords: []\n', 'utf8');
  assert.equal(resolveApiKey({ env: {}, storePath: p }), null);
});

test('buildChildEnv 始终带上权限档位，有 key 时补上 key', () => {
  const p = storeWith('sk-store');
  const { env, hasKey } = buildChildEnv({ base: { PATH: 'x' }, storePath: p });
  assert.equal(env.DSH_PERMISSION_MODE, 'danger-full-access');
  assert.equal(env.PATH, 'x');
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-store');
  assert.equal(hasKey, true);
});

test('buildChildEnv 没有 key 时也返回可用的 env，并如实报告', () => {
  const { env, hasKey } = buildChildEnv({ base: {}, storePath: join(tmpdir(), 'nope.yaml') });
  assert.equal(env.DSH_PERMISSION_MODE, 'danger-full-access');
  assert.equal(hasKey, false);
  assert.equal('DEEPSEEK_API_KEY' in env, false);
});

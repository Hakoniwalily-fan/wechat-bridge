import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, isAlive } from '../src/lock.mjs';

test('空闲时能拿到锁，release 后文件消失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const lock = acquireLock(dir);
  assert.ok(existsSync(lock.file));
  assert.equal(readFileSync(lock.file, 'utf8'), String(process.pid));
  lock.release();
  assert.equal(existsSync(lock.file), false);
});

test('锁被活着的进程持有时拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  writeFileSync(join(dir, 'bridge.lock'), String(process.pid));
  assert.throws(
    () => acquireLock(dir, { self: process.pid + 999999 }),
    (e) => e.code === 'already-running' && e.pid === process.pid,
  );
});

test('持有者已经死了就接管', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  // 用一个几乎不可能存在的 pid
  writeFileSync(join(dir, 'bridge.lock'), '999999999');
  const lock = acquireLock(dir);
  assert.equal(readFileSync(lock.file, 'utf8'), String(process.pid));
  lock.release();
});

test('自己持有自己的锁不会自锁（重入不报错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const a = acquireLock(dir, { self: 4242 });
  const b = acquireLock(dir, { self: 4242 });
  assert.ok(a.file === b.file);
});

test('release 重复调用是安全的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const lock = acquireLock(dir);
  lock.release();
  assert.doesNotThrow(() => lock.release());
});

test('release 不会删掉别人后来写入的锁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const lock = acquireLock(dir, { self: 1111 });
  writeFileSync(lock.file, '2222');
  lock.release();
  assert.equal(readFileSync(lock.file, 'utf8'), '2222');
});

test('isAlive 对当前进程为真，对离谱 pid 为假', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(999999999), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(NaN), false);
});

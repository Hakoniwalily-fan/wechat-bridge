import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, isAlive, bootStamp } from '../src/lock.mjs';

test('空闲时能拿到锁，release 后文件消失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const lock = acquireLock(dir);
  assert.ok(existsSync(lock.file));
  assert.equal(JSON.parse(readFileSync(lock.file, 'utf8')).pid, process.pid);
  lock.release();
  assert.equal(existsSync(lock.file), false);
});

test('锁被同一开机周期的存活进程持有时拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: process.pid, boot: 42 }));
  assert.throws(
    () => acquireLock(dir, { self: process.pid + 999999, boot: 42 }),
    (e) => e.code === 'already-running' && e.pid === process.pid,
  );
});

test('持有者已经死了就接管', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  // 用一个几乎不可能存在的 pid（旧格式也一并覆盖）
  writeFileSync(join(dir, 'bridge.lock'), '999999999');
  const lock = acquireLock(dir);
  assert.equal(JSON.parse(readFileSync(lock.file, 'utf8')).pid, process.pid);
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

// ---- 重启后的 pid 复用 ----

test('bootStamp 在同一开机周期稳定，不同周期不同', () => {
  const a = bootStamp(1_000_000_000_000, 100);
  // 同一开机周期：now 前进了 500s，uptime 也必须前进 500s
  const b = bootStamp(1_000_000_500_000, 600);
  assert.equal(a, b, '同一开机周期内应得到同一个值');
  const c = bootStamp(1_000_000_500_000, 10);
  assert.notEqual(a, c, '重启后 uptime 变小，bootStamp 应变化');
});

test('锁里的 boot 与本次不同时，即使 pid 存活也接管（模拟重启后 pid 复用）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: process.pid, boot: 111 }));
  // process.pid 是活的，但 boot 不匹配 → 必须接管，否则重启后再也起不来
  const lock = acquireLock(dir, { self: process.pid + 1, boot: 222 });
  const holder = JSON.parse(readFileSync(lock.file, 'utf8'));
  assert.equal(holder.pid, process.pid + 1);
  assert.equal(holder.boot, 222);
  lock.release();
});

test('同一 boot 且 pid 存活时拒绝（真正的双实例）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: process.pid, boot: 777 }));
  assert.throws(
    () => acquireLock(dir, { self: process.pid + 1, boot: 777 }),
    (e) => e.code === 'already-running' && e.pid === process.pid,
  );
});

test('同一 boot 但 pid 已死时接管', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: 999999999, boot: 777 }));
  const lock = acquireLock(dir, { self: process.pid, boot: 777 });
  assert.equal(JSON.parse(readFileSync(lock.file, 'utf8')).pid, process.pid);
  lock.release();
});

test('旧格式（纯数字）且 pid 存活时保守拒绝并给出可行指引', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  writeFileSync(join(dir, 'bridge.lock'), String(process.pid));
  assert.throws(
    () => acquireLock(dir, { self: process.pid + 1, boot: 777 }),
    (e) => e.code === 'ambiguous-lock' && /删除 lock/.test(e.message),
  );
});

test('release 只删自己的锁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const lock = acquireLock(dir, { self: 1111, boot: 5 });
  writeFileSync(lock.file, JSON.stringify({ pid: 2222, boot: 5 }));
  lock.release();
  assert.equal(JSON.parse(readFileSync(lock.file, 'utf8')).pid, 2222);
});

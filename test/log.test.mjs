import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, createLogger } from '../src/log.mjs';

test('脱敏 bot_token', () => {
  // 虚构值：形状与真实 bot_token 一致（<botId>@im.bot:<secret>），但内容不可用
  const fake = '0123456789ab@im.bot:000000feedfacecafebeefdeadbeef0000';
  const out = redact(`token=${fake}`);
  assert.ok(!out.includes('feedfacecafebeefdeadbeef0000'));
  assert.ok(!out.includes('0123456789ab@im.bot'));
});

test('脱敏 Bearer', () => {
  assert.equal(redact('Authorization: Bearer abc123def'), 'Authorization: Bearer ***');
});

test('日志按日期落盘并带级别', () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-'));
  const logger = createLogger({ dir, now: () => new Date('2026-10-21T03:04:05Z') });
  logger.info('hello');
  const line = readFileSync(join(dir, 'bridge-2026-10-21.log'), 'utf8');
  assert.ok(line.includes('INFO'));
  assert.ok(line.includes('hello'));
});

// 把 console 暂存起来：既避免测试输出被日志刷屏，也能断言"降级后确实写了控制台"
function captureConsole() {
  const real = { log: console.log, error: console.error };
  const lines = [];
  console.log = (m) => lines.push(m);
  console.error = (m) => lines.push(m);
  return {
    lines,
    restore() {
      console.log = real.log;
      console.error = real.error;
    },
  };
}

test('落盘失败（磁盘满 / 日志文件变成目录）时日志不抛，只降级到控制台', () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-'));
  // 把当天的日志文件先建成目录：appendFileSync 会 EISDIR
  mkdirSync(join(dir, 'bridge-2026-10-21.log'));

  const cap = captureConsole();
  try {
    const logger = createLogger({ dir, now: () => new Date('2026-10-21T03:04:05Z') });
    assert.doesNotThrow(() => logger.error('磁盘满了也要活着'));
    assert.doesNotThrow(() => logger.info('下一条也不许抛'));
    assert.ok(cap.lines.some((l) => l.includes('磁盘满了也要活着')), '降级后必须还有控制台输出');
    assert.ok(cap.lines.some((l) => l.includes('下一条也不许抛')));
  } finally {
    cap.restore();
  }
});

test('状态目录建不出来（路径被文件占住）也不抛', () => {
  const base = mkdtempSync(join(tmpdir(), 'log-'));
  const notADir = join(base, 'not-a-dir');
  writeFileSync(notADir, 'x');

  const cap = captureConsole();
  try {
    const logger = createLogger({ dir: notADir, now: () => new Date('2026-10-21T03:04:05Z') });
    assert.doesNotThrow(() => logger.warn('目录没了也要活着'));
    assert.ok(cap.lines.some((l) => l.includes('目录没了也要活着')));
  } finally {
    cap.restore();
  }
});

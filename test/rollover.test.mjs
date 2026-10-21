import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeRollover } from '../src/router.mjs';

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    read: (k, f) => (data.has(k) ? data.get(k) : f),
    write: (k, v) => data.set(k, v),
    _data: data,
  };
}

function runnerReturning(fn) {
  const runs = [];
  return {
    runs,
    run: async (args) => {
      runs.push(args);
      return fn(args);
    },
  };
}

const USER = 'u@im.wechat';

test('未超阈值不换代', async () => {
  const store = memoryStore({
    'session.json': { [USER]: { sessionId: 's1', turns: 10, totalTokens: 1000 } },
  });
  const runner = runnerReturning(() => ({ finalText: '摘要', sessionId: 's2' }));
  const out = await maybeRollover({ runner, store, userId: USER, limits: { maxTokens: 150000, maxTurns: 40 } });
  assert.equal(out.rolled, false);
  assert.equal(runner.runs.length, 0);
  assert.equal(store.read('session.json', {})[USER].sessionId, 's1');
});

test('token 超阈值触发换代并带上摘要', async () => {
  const store = memoryStore({
    'session.json': { [USER]: { sessionId: 's1', turns: 5, totalTokens: 200000 } },
  });
  const runner = runnerReturning(() => ({ finalText: '这是摘要', sessionId: 's1' }));
  const out = await maybeRollover({ runner, store, userId: USER, limits: { maxTokens: 150000, maxTurns: 40 } });

  assert.equal(out.rolled, true);
  assert.equal(out.summary, '这是摘要');
  const s = store.read('session.json', {})[USER];
  assert.equal(s.sessionId, null);
  assert.equal(s.turns, 0);
  assert.equal(s.totalTokens, 0);
  assert.equal(s.summary, '这是摘要');
});

test('轮次超阈值也触发', async () => {
  const store = memoryStore({
    'session.json': { [USER]: { sessionId: 's1', turns: 41, totalTokens: 10 } },
  });
  const runner = runnerReturning(() => ({ finalText: '摘要', sessionId: 's1' }));
  const out = await maybeRollover({ runner, store, userId: USER, limits: { maxTokens: 150000, maxTurns: 40 } });
  assert.equal(out.rolled, true);
});

test('摘要失败时仍换代，summary 为 null', async () => {
  const store = memoryStore({
    'session.json': { [USER]: { sessionId: 's1', turns: 41, totalTokens: 10 } },
  });
  const runner = runnerReturning(() => {
    throw new Error('模型挂了');
  });
  const out = await maybeRollover({ runner, store, userId: USER, limits: { maxTokens: 150000, maxTurns: 40 } });
  assert.equal(out.rolled, true);
  assert.equal(out.summary, null);
  assert.equal(store.read('session.json', {})[USER].sessionId, null);
});

test('没有会话时不换代', async () => {
  const store = memoryStore({});
  const runner = runnerReturning(() => ({ finalText: 'x' }));
  const out = await maybeRollover({ runner, store, userId: USER, limits: { maxTokens: 1, maxTurns: 1 } });
  assert.equal(out.rolled, false);
});

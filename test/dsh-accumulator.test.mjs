// test/dsh-accumulator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccumulator } from '../src/dsh.mjs';

test('还原真实事件流', () => {
  const acc = createAccumulator();
  const lines = [
    '{"type":"session","sessionId":"session-abc","cwd":"D:\\\\DHS"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    '{"type":"status","phase":"step_start","turn":1,"step":1}',
    '{"type":"thinking","text":""}',
    '{"type":"text","text":"收到"}',
    '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"totalTokens":6638}}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    '{"type":"final","text":"收到"}',
  ];
  for (const l of lines) acc.push(l);

  assert.equal(acc.state.sessionId, 'session-abc');
  assert.equal(acc.state.text, '收到');
  assert.equal(acc.state.finalText, '收到');
  assert.equal(acc.state.totalTokens, 6638);
  assert.equal(acc.state.turns, 1);
});

test('多步累加 token', () => {
  const acc = createAccumulator();
  acc.push('{"type":"status","phase":"step_end","usage":{"totalTokens":100}}');
  acc.push('{"type":"status","phase":"step_end","usage":{"totalTokens":250}}');
  assert.equal(acc.state.totalTokens, 350);
});

test('非 JSON 行不抛，返回 unparsed', () => {
  const acc = createAccumulator();
  const ev = acc.push('not json at all');
  assert.equal(ev.type, 'unparsed');
  assert.ok(ev.raw.includes('not json'));
});

test('空行返回 null', () => {
  const acc = createAccumulator();
  assert.equal(acc.push('   '), null);
});

test('没有 final 时 finalText 保持 null', () => {
  const acc = createAccumulator();
  acc.push('{"type":"text","text":"半截"}');
  assert.equal(acc.state.finalText, null);
  assert.equal(acc.state.text, '半截');
});

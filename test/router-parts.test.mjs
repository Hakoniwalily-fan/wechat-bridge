import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, extractText, createDeduper } from '../src/router.mjs';

test('识别命令与别名', () => {
  assert.deepEqual(parseCommand('/stop'), { name: 'stop', arg: '' });
  assert.deepEqual(parseCommand('/急停'), { name: 'stop', arg: '' });
  assert.deepEqual(parseCommand('  /STATUS  '), { name: 'status', arg: '' });
  assert.deepEqual(parseCommand('/状态'), { name: 'status', arg: '' });
  assert.deepEqual(parseCommand('/new'), { name: 'new', arg: '' });
  assert.deepEqual(parseCommand('/帮助'), { name: 'help', arg: '' });
});

test('普通文本不是命令', () => {
  assert.equal(parseCommand('帮我写个脚本'), null);
  assert.equal(parseCommand('/unknown'), null);
  assert.equal(parseCommand(''), null);
});

test('提取文本消息', () => {
  const msg = { item_list: [{ type: 1, text_item: { text: '你好' } }] };
  assert.deepEqual(extractText(msg), { kind: 'text', text: '你好' });
});

test('非文本消息标记为 unsupported', () => {
  const msg = { item_list: [{ type: 2, image_item: {} }] };
  assert.deepEqual(extractText(msg), { kind: 'unsupported', itemType: 2 });
  assert.deepEqual(extractText({}), { kind: 'unsupported', itemType: null });
});

test('去重只放行一次', () => {
  const d = createDeduper({ size: 3 });
  assert.equal(d.seen(1), false);
  assert.equal(d.seen(1), true);
  assert.equal(d.seen(2), false);
});

test('去重表超过容量后淘汰最旧的', () => {
  const d = createDeduper({ size: 2 });
  d.seen('a');
  d.seen('b');
  d.seen('c');
  assert.equal(d.seen('a'), false);
  assert.equal(d.seen('c'), true);
});

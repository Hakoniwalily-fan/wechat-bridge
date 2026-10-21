import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/chunk.mjs';

test('短文本原样返回', () => {
  assert.deepEqual(chunkText('你好'), ['你好']);
});

test('空值返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(null), []);
});

test('恰好等于上限不切', () => {
  const s = 'a'.repeat(2000);
  assert.equal(chunkText(s).length, 1);
});

test('优先在段落边界切', () => {
  const a = 'a'.repeat(1500);
  const b = 'b'.repeat(1500);
  const out = chunkText(`${a}\n\n${b}`);
  assert.deepEqual(out, [a, b]);
});

test('没有段落边界时退到换行', () => {
  const a = 'a'.repeat(1500);
  const b = 'b'.repeat(1500);
  const out = chunkText(`${a}\n${b}`);
  assert.deepEqual(out, [a, b]);
});

test('超长单行硬切，且每片不超过上限', () => {
  const out = chunkText('x'.repeat(5000));
  assert.equal(out.length, 3);
  for (const piece of out) assert.ok(piece.length <= 2000);
  assert.equal(out.join(''), 'x'.repeat(5000));
});

test('不产生空片', () => {
  const out = chunkText(`${'a'.repeat(2000)}\n\n`);
  assert.equal(out.length, 1);
  assert.ok(out.every((p) => p.length > 0));
});

test('所有分片拼起来等于原文（除被吃掉的切分符）', () => {
  const text = Array.from({ length: 50 }, (_, i) => `第${i}行内容`).join('\n');
  const out = chunkText(text, 100);
  assert.ok(out.every((p) => p.length <= 100));
  assert.equal(out.join('\n'), text);
});

test('limit 为 0 或负数时回退到 2000，不死循环', () => {
  for (const limit of [0, -5]) {
    const out = chunkText('x'.repeat(30), limit);
    assert.ok(out.every((p) => p.length <= 2000));
    assert.equal(out.join(''), 'x'.repeat(30));
  }
});

test('limit 为 null 时与默认值一致', () => {
  assert.deepEqual(chunkText('x'.repeat(30), null), chunkText('x'.repeat(30)));
});

test('limit 为 NaN 时回退到 2000，不会退化成无限长单片', () => {
  const out = chunkText('x'.repeat(5000), NaN);
  assert.equal(out.length, 3);
  for (const piece of out) assert.ok(piece.length <= 2000);
  assert.equal(out.join(''), 'x'.repeat(5000));
});

test('纯空白的中间片不单独成片，但空白一个字都不丢', () => {
  // 1999 个 a + 换行 + 1999 个空格 + 换行 + 1999 个 b：
  // 旧实现在这里会把 1999 个空格当成一片发出去（手机上就是一条空消息）
  const text = 'a'.repeat(1999) + '\n' + ' '.repeat(1999) + '\n' + 'b'.repeat(1999);
  const out = chunkText(text);

  assert.equal(out.length, 3, JSON.stringify(out.map((p) => p.length)));
  for (const piece of out) {
    assert.ok(piece.trim(), `不能发出纯空白片: ${JSON.stringify(piece.slice(0, 20))}`);
    assert.ok(piece.length <= 2000, `分片超长: ${piece.length}`);
  }

  // 空白被攒起来拼到下一片真实内容前面：第 2 片是 1999 个空格 + 1 个 b，
  // 因为预算只剩 2000，多出来的 b 落到第 3 片
  assert.deepEqual(out.map((p) => p.length), [1999, 2000, 1998]);
  assert.ok(out[1].startsWith(' '.repeat(1999)));
  assert.equal(out[1].at(-1), 'b');

  // 唯一丢掉的是被当作切分点的两个换行（原有行为），真实字符一个不少：
  // 1999 个 a + 1999 个空格 + 1999 个 b
  assert.equal(out.join(''), text.replace(/\n/g, ''));
  assert.equal(out.join('').split(' ').length - 1, 1999, '空白必须完整送达');
  assert.equal(out.join('').split('a').length - 1, 1999);
  assert.equal(out.join('').split('b').length - 1, 1999);
});

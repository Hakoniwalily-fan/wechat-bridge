# 微信 ↔ DSH 桥 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机常驻一个桥接服务，把微信消息转成 `dsh headless` 任务执行，并把结果回发微信。

**Architecture:** 单进程 Node ESM 应用。`ilink.mjs` 实现腾讯官方 iLink Bot 协议（长轮询收、`sendmessage` 发），`dsh.mjs` 用 `child_process` 拉起 `dsh --profile headless --json` 并解析 NDJSON 事件流，`router.mjs` 负责命令、串行队列与会话续接。状态与凭证落在 `%USERPROFILE%\.wechat-bridge\`。

**Tech Stack:** Node.js 24（内置 `fetch`、`node:crypto`、`node:test`、`AbortSignal.any`），唯一运行时依赖 `qrcode@1.5.4`。

**Spec:** `docs/superpowers/specs/2026-10-21-wechat-bridge-design.md`

## Global Constraints

- 运行时 Node >= 24（依赖 `AbortSignal.any`、内置 `fetch`、`node --test`）
- 唯一运行时依赖：`qrcode@^1.5.4`；其余一律用 Node 内置模块
- 全部源码为 ESM，扩展名 `.mjs`
- 所有测试用 `node:test` + `node:assert/strict`，不引测试框架
- 工作目录固定 `D:\DHS`；状态目录固定 `%USERPROFILE%\.wechat-bridge\`
- iLink 基座 `https://ilinkai.weixin.qq.com`，业务请求必须带 `base_info: { channel_version }`
- 文本分片上限 2000 字符
- 日志禁止出现明文 `bot_token`，禁止记录消息正文（只记长度与 sha256 前 12 位）
- Windows 下 kill 子进程必须用 `taskkill /T /F /PID`，保证不留孤儿进程
- 每个任务结束时 `git commit` 一次

---

### Task 1: 项目骨架与状态存储

**Files:**
- Create: `package.json`
- Create: `src/store.mjs`
- Create: `test/store.test.mjs`
- Create: `.gitignore`（已存在，确认含 `node_modules/`、`*.log`）

**Interfaces:**
- Consumes: 无
- Produces: `createStore(dir, { logger? })` → `{ dir, pathOf(name), read(name, fallback), write(name, value) }`

- [ ] **Step 1: 写 package.json 并装依赖**

```json
{
  "name": "wechat-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/main.mjs",
    "test": "node --test"
  }
}
```

Run: `npm i qrcode@1.5.4 --registry=https://registry.npmmirror.com --no-audit --no-fund`

- [ ] **Step 2: 写失败的测试**

```js
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

test('写入是原子的，不留 .tmp 残留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const store = createStore(dir);
  store.write('a.json', { n: 1 });
  store.write('a.json', { n: 2 });
  assert.deepEqual(store.read('a.json', null), { n: 2 });
  assert.deepEqual(readdirSync(dir), ['a.json']);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/store.test.mjs`
Expected: FAIL — `Cannot find module '../src/store.mjs'`

- [ ] **Step 4: 实现**

```js
// src/store.mjs
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createStore(dir, { logger } = {}) {
  mkdirSync(dir, { recursive: true });
  const pathOf = (name) => join(dir, name);

  return {
    dir,
    pathOf,
    read(name, fallback) {
      const p = pathOf(name);
      if (!existsSync(p)) return fallback;
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch (e) {
        logger?.warn?.(`状态文件损坏，已回退默认值: ${name} (${e.message})`);
        return fallback;
      }
    },
    write(name, value) {
      const p = pathOf(name);
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      renameSync(tmp, p);
    },
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/store.test.mjs`
Expected: PASS，4 个用例

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/store.mjs test/store.test.mjs
git commit -m "feat: 项目骨架与原子状态存储"
```

---

### Task 2: 文本分片

**Files:**
- Create: `src/chunk.mjs`
- Create: `test/chunk.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `chunkText(text, limit = 2000)` → `string[]`

- [ ] **Step 1: 写失败的测试**

```js
// test/chunk.test.mjs
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/chunk.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```js
// src/chunk.mjs
export function chunkText(text, limit = 2000) {
  const s = String(text ?? '');
  if (!s) return [];
  if (!Number.isFinite(limit) || limit < 1) limit = 2000;

  const out = [];
  let rest = s;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    let skip = 2;
    if (cut <= 0) {
      cut = window.lastIndexOf('\n');
      skip = 1;
    }
    if (cut <= 0) {
      cut = window.lastIndexOf(' ');
      skip = 1;
    }
    if (cut <= 0) {
      cut = limit;
      skip = 0;
    }
    const piece = rest.slice(0, cut);
    if (piece) out.push(piece);
    rest = rest.slice(cut + skip);
  }
  if (rest.trim()) out.push(rest);
  return out;
}
```

> 注：`rest.trim()` 而非 `rest` —— 否则 `'a'×2000 + '\n\n'` 会把只剩分隔符的尾巴也当成一片，与「不产生空片」冲突。`limit` 守卫是必须的：`limit = 0` 时硬切每次前进 0 个字符，循环永不结束。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/chunk.test.mjs`
Expected: PASS，8 个用例

- [ ] **Step 5: 提交**

```bash
git add src/chunk.mjs test/chunk.test.mjs
git commit -m "feat: 2000 字友好分片"
```

---

### Task 3: 脱敏日志

**Files:**
- Create: `src/log.mjs`
- Create: `test/log.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `redact(s)` → `string`；`createLogger({ dir?, now? })` → `{ info, warn, error }`

- [ ] **Step 1: 写失败的测试**

```js
// test/log.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, createLogger } from '../src/log.mjs';

test('脱敏 bot_token', () => {
  const out = redact('token=0123456789ab@im.bot:000000feedfacecafebeefdeadbeef0000');
  assert.ok(!out.includes('feedfacecafebeefdeadbeef0000'));
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/log.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```js
// src/log.mjs
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const RULES = [
  [/ilinkbot_[A-Za-z0-9@:._-]+/g, 'ilinkbot_***'],
  [/[0-9a-f]{6,}@im\.bot:[A-Za-z0-9._-]+/g, '***@im.bot:***'],
  [/Bearer\s+[A-Za-z0-9@:._-]+/g, 'Bearer ***'],
];

export function redact(s) {
  let out = String(s);
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

export function createLogger({ dir, now = () => new Date() } = {}) {
  if (dir) mkdirSync(dir, { recursive: true });

  const write = (level, msg) => {
    const line = `${now().toISOString()} ${level} ${redact(msg)}`;
    if (dir) appendFileSync(join(dir, `bridge-${now().toISOString().slice(0, 10)}.log`), line + '\n');
    (level === 'ERROR' ? console.error : console.log)(line);
  };

  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/log.test.mjs`
Expected: PASS，3 个用例

- [ ] **Step 5: 提交**

```bash
git add src/log.mjs test/log.test.mjs
git commit -m "feat: 带脱敏的按天日志"
```

---

### Task 4: iLink 请求层与错误归一

**Files:**
- Create: `src/ilink.mjs`
- Create: `test/ilink-request.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class IlinkError extends Error`，字段 `kind`（`'session-expired' | 'network' | 'server' | 'auth' | 'aborted'`）、`ret`
  - `makeUin(randomBytes?)` → base64 字符串
  - `createIlink({ creds?, fetchImpl?, logger?, channelVersion?, sleep? })` → 对象，内部 `post(path, body, opts)` / `get(path, opts)` 供后续任务使用

- [ ] **Step 1: 写失败的测试**

```js
// test/ilink-request.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUin, createIlink, IlinkError } from '../src/ilink.mjs';

function captureFetch(response = { ret: 0 }, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status < 400,
      text: async () => JSON.stringify(response),
      json: async () => response,
    };
  };
  return { fetchImpl, calls };
}

test('makeUin 解出来是十进制数字且每次都变', () => {
  const a = makeUin();
  const b = makeUin();
  const decoded = Buffer.from(a, 'base64').toString('utf8');
  assert.match(decoded, /^\d+$/);
  assert.ok(a !== b);
});

test('业务请求带齐四个头与 base_info', async () => {
  const { fetchImpl, calls } = captureFetch();
  const ilink = createIlink({
    creds: { token: 'tok123', baseUrl: 'https://example.test' },
    fetchImpl,
  });
  await ilink.post('/ilink/bot/getconfig', { ilink_user_id: 'u1' });
  const { url, init } = calls[0];
  assert.equal(url, 'https://example.test/ilink/bot/getconfig');
  assert.equal(init.headers.Authorization, 'Bearer tok123');
  assert.equal(init.headers.AuthorizationType, 'ilink_bot_token');
  assert.match(Buffer.from(init.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  const body = JSON.parse(init.body);
  assert.deepEqual(body.base_info, { channel_version: '1.0.0' });
  assert.equal(body.ilink_user_id, 'u1');
});

test('ret=-14 归一为 session-expired', async () => {
  const { fetchImpl } = captureFetch({ ret: -14, errmsg: 'session timeout' });
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => {
    assert.ok(e instanceof IlinkError);
    assert.equal(e.kind, 'session-expired');
    return true;
  });
});

test('5xx 归一为 server', async () => {
  const { fetchImpl } = captureFetch({}, 502);
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => e.kind === 'server');
});

test('fetch 抛错归一为 network', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const ilink = createIlink({ creds: { token: 't', baseUrl: 'https://e.test' }, fetchImpl });
  await assert.rejects(() => ilink.post('/x', {}), (e) => e.kind === 'network');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/ilink-request.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```js
// src/ilink.mjs
import { randomBytes } from 'node:crypto';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IlinkError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'IlinkError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function makeUin(random = randomBytes) {
  const v = random(4).readUInt32BE(0);
  return Buffer.from(String(v), 'utf8').toString('base64');
}

export function createIlink({
  creds,
  fetchImpl = globalThis.fetch,
  logger,
  channelVersion = '1.0.0',
  sleepImpl = sleep,
} = {}) {
  const baseUrl = () => creds?.baseUrl || DEFAULT_BASE;

  async function request(path, { method = 'GET', body, headers = {}, timeoutMs = 20000, signal } = {}) {
    const t = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, t]) : t;

    let res;
    try {
      res = await fetchImpl(`${baseUrl()}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(body ? { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${creds?.token}` } : {}),
          'X-WECHAT-UIN': makeUin(),
        },
        ...(body ? { body: JSON.stringify({ ...body, base_info: { channel_version: channelVersion } }) } : {}),
        signal: combined,
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        if (signal?.aborted) throw new IlinkError('aborted', '请求被取消', { cause: e });
        throw new IlinkError('network', `请求超时: ${path}`, { cause: e });
      }
      throw new IlinkError('network', `网络错误: ${path} (${e.message})`, { cause: e });
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new IlinkError('server', `响应不是 JSON: ${path} (${text.slice(0, 200)})`);
    }

    const ret = json.ret ?? json.errcode;
    if (ret === -14) throw new IlinkError('session-expired', 'session 过期，需要重新扫码', { ret });
    if (res.status >= 500) throw new IlinkError('server', `服务端错误 ${res.status}: ${path}`, { ret });
    if (ret !== undefined && ret !== 0) {
      throw new IlinkError('server', `业务错误 ret=${ret}: ${path} ${json.errmsg ?? ''}`, { ret });
    }
    return json;
  }

  return {
    get creds() {
      return creds;
    },
    request,
    get: (path, opts = {}) => request(path, { ...opts, method: 'GET' }),
    post: (path, body, opts = {}) => request(path, { ...opts, method: 'POST', body }),
    sleep: sleepImpl,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/ilink-request.test.mjs`
Expected: PASS，5 个用例

- [ ] **Step 5: 提交**

```bash
git add src/ilink.mjs test/ilink-request.test.mjs
git commit -m "feat: iLink 请求层与错误归一"
```

---

### Task 5: 二维码渲染

**Files:**
- Create: `src/qr.mjs`
- Create: `test/qr.test.mjs`

**Interfaces:**
- Consumes: `qrcode@1.5.4`
- Produces: `renderQr(url, { pngPath? })` → `Promise<{ pngPath, ascii }>`

- [ ] **Step 1: 写失败的测试**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/qr.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```js
// src/qr.mjs
import QRCode from 'qrcode';

export async function renderQr(url, { pngPath } = {}) {
  if (pngPath) await QRCode.toFile(pngPath, url, { width: 480, margin: 2 });
  const ascii = await QRCode.toString(url, { type: 'terminal', small: true });
  return { pngPath: pngPath ?? null, ascii };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/qr.test.mjs`
Expected: PASS，2 个用例

- [ ] **Step 5: 提交**

```bash
git add src/qr.mjs test/qr.test.mjs
git commit -m "feat: 二维码渲染（终端 + PNG）"
```

---

### Task 6: 扫码登录

**Files:**
- Modify: `src/ilink.mjs`（追加 `login`）
- Create: `test/ilink-login.test.mjs`

**Interfaces:**
- Consumes: Task 4 的 `createIlink`
- Produces: `ilink.login({ onQr, signal })` → `Promise<{ token, baseUrl, accountId, userId, savedAt }>`

- [ ] **Step 1: 写失败的测试**

```js
// test/ilink-login.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIlink } from '../src/ilink.mjs';

function scriptedFetch(script) {
  let i = 0;
  return async (url) => {
    const step = script[i++] ?? script[script.length - 1];
    return { status: 200, ok: true, text: async () => JSON.stringify(step) };
  };
}

const QR = { ret: 0, qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x?qrcode=qr-1' };

test('wait → confirmed 时返回凭证', async () => {
  const fetchImpl = scriptedFetch([
    QR,
    { status: 'wait' },
    { status: 'scaned' },
    {
      status: 'confirmed',
      bot_token: 'tk',
      ilink_bot_id: 'b@im.bot',
      ilink_user_id: 'u@im.wechat',
      baseurl: 'https://ilinkai.weixin.qq.com',
    },
  ]);
  const seen = [];
  const ilink = createIlink({ fetchImpl, sleepImpl: async () => {} });
  const creds = await ilink.login({ onQr: (q) => seen.push(q) });

  assert.equal(creds.token, 'tk');
  assert.equal(creds.accountId, 'b@im.bot');
  assert.equal(creds.userId, 'u@im.wechat');
  assert.equal(creds.baseUrl, 'https://ilinkai.weixin.qq.com');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, QR.qrcode_img_content);
});

test('二维码过期时重新申请', async () => {
  const fetchImpl = scriptedFetch([
    QR,
    { status: 'expired' },
    { ...QR, qrcode: 'qr-2', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/y?qrcode=qr-2' },
    { status: 'confirmed', bot_token: 'tk2', ilink_bot_id: 'b2@im.bot', ilink_user_id: 'u2@im.wechat' },
  ]);
  const seen = [];
  const ilink = createIlink({ fetchImpl, sleepImpl: async () => {} });
  const creds = await ilink.login({ onQr: (q) => seen.push(q) });

  assert.equal(creds.token, 'tk2');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].qrcode, 'qr-2');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/ilink-login.test.mjs`
Expected: FAIL — `ilink.login is not a function`

- [ ] **Step 3: 实现（在 `createIlink` 返回对象中追加 `login`）**

```js
    async login({ onQr, signal } = {}) {
      for (;;) {
        const qr = await request('/ilink/bot/get_bot_qrcode?bot_type=3', { signal });
        if (qr.ret !== 0 || !qr.qrcode) {
          throw new IlinkError('server', `取二维码失败: ${JSON.stringify(qr).slice(0, 200)}`);
        }
        await onQr?.({ qrcode: qr.qrcode, url: qr.qrcode_img_content });
        logger?.info?.(`已生成登录二维码 qrcode=${qr.qrcode}`);

        for (;;) {
          const st = await request(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, {
            headers: { 'iLink-App-ClientVersion': '1' },
            timeoutMs: 40000,
            signal,
          }).catch((e) => {
            // 只有「本地超时」才算继续等待；DNS/连不上/TLS 这类真实故障必须抛出去，
            // 否则登录会在断网时静默地每 1.2 秒重试、没有任何日志。
            if (e.kind === 'network' && e.cause?.name === 'TimeoutError' && !signal?.aborted) {
              return { status: 'wait' };
            }
            throw e;
          });

          if (st.status === 'confirmed') {
            return {
              token: st.bot_token,
              baseUrl: st.baseurl || DEFAULT_BASE,
              accountId: st.ilink_bot_id,
              userId: st.ilink_user_id,
              savedAt: new Date().toISOString(),
            };
          }
          if (st.status === 'expired') break;
          await sleepImpl(1200);
        }
      }
    },
```

**注意**：`creds` 在登录时为 `undefined`，`request` 里有 `body` 才带 `Authorization`，登录接口是 GET 无 body，所以不会带空 token。测试覆盖了这一点。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/ilink-login.test.mjs`
Expected: PASS，2 个用例

- [ ] **Step 5: 提交**

```bash
git add src/ilink.mjs test/ilink-login.test.mjs
git commit -m "feat: iLink 扫码登录"
```

---

### Task 7: 收消息、发消息、typing

**Files:**
- Modify: `src/ilink.mjs`（追加 `poll` / `sendText` / `sendTyping`）
- Create: `test/ilink-messaging.test.mjs`

**Interfaces:**
- Consumes: Task 4 的 `createIlink`
- Produces:
  - `ilink.poll({ signal })` → `Promise<{ msgs, cursor }>`；本地超时返回 `{ msgs: [], cursor: undefined }`
  - `ilink.sendText({ toUserId, contextToken, text })` → `Promise<{ messageId }>`
  - `ilink.sendTyping({ toUserId, contextToken, status })` → `Promise<void>`，失败静默不抛

- [ ] **Step 1: 写失败的测试**

```js
// test/ilink-messaging.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIlink } from '../src/ilink.mjs';

function okFetch(payload = { ret: 0 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
}

const creds = { token: 'tk', baseUrl: 'https://e.test' };

test('poll 回传游标并解析消息', async () => {
  const { fetchImpl, calls } = okFetch({
    ret: 0,
    msgs: [{ message_id: 1, from_user_id: 'u@im.wechat', context_token: 'ct', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    get_updates_buf: 'CURSOR-2',
  });
  const ilink = createIlink({ creds, fetchImpl });
  const out = await ilink.poll({});
  assert.equal(out.msgs.length, 1);
  assert.equal(out.cursor, 'CURSOR-2');
  assert.equal(calls[0].body.get_updates_buf, '');
});

test('poll 本地超时当作空轮询', async () => {
  const fetchImpl = async () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  };
  const ilink = createIlink({ creds, fetchImpl });
  const out = await ilink.poll({});
  assert.deepEqual(out, { msgs: [], cursor: undefined });
});

test('sendText 带 context_token、message_type=2、message_state=2', async () => {
  const { fetchImpl, calls } = okFetch({ message_id: 99 });
  const ilink = createIlink({ creds, fetchImpl });
  const out = await ilink.sendText({ toUserId: 'u@im.wechat', contextToken: 'CT', text: 'hello' });
  assert.equal(out.messageId, 99);
  const msg = calls[0].body.msg;
  assert.equal(msg.to_user_id, 'u@im.wechat');
  assert.equal(msg.context_token, 'CT');
  assert.equal(msg.message_type, 2);
  assert.equal(msg.message_state, 2);
  assert.deepEqual(msg.item_list, [{ type: 1, text_item: { text: 'hello' } }]);
  assert.ok(msg.client_id);
});

test('每次发送的 client_id 都不同', async () => {
  const { fetchImpl, calls } = okFetch({ message_id: 1 });
  const ilink = createIlink({ creds, fetchImpl });
  await ilink.sendText({ toUserId: 'u', contextToken: 'c', text: 'a' });
  await ilink.sendText({ toUserId: 'u', contextToken: 'c', text: 'b' });
  assert.notEqual(calls[0].body.msg.client_id, calls[1].body.msg.client_id);
});

test('sendTyping 失败不抛', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const ilink = createIlink({ creds, fetchImpl });
  await assert.doesNotReject(() => ilink.sendTyping({ toUserId: 'u', contextToken: 'c', status: 1 }));
});

test('游标可通过属性读写', () => {
  const ilink = createIlink({ creds, fetchImpl: async () => ({}) });
  ilink.cursor = 'C1';
  assert.equal(ilink.cursor, 'C1');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/ilink-messaging.test.mjs`
Expected: FAIL — `ilink.poll is not a function`

- [ ] **Step 3: 实现（追加到 `createIlink` 返回对象）**

```js
    async poll({ signal, timeoutMs = 40000 } = {}) {
      let json;
      try {
        json = await request('/ilink/bot/getupdates', {
          method: 'POST',
          body: { get_updates_buf: cursor ?? '' },
          timeoutMs,
          signal,
        });
      } catch (e) {
        // 长轮询被服务端 hold 住时本地超时是正常的，等同于「没有新消息」。
        // 但 DNS 失败、连接被拒、TLS 错误等真实故障不能这样吞掉——否则上层会
        // 立刻重试、永不停歇，也不记错误日志。
        if (e.kind === 'network' && e.cause?.name === 'TimeoutError' && !signal?.aborted) {
          return { msgs: [], cursor: undefined };
        }
        throw e;
      }
      if (json.get_updates_buf) cursor = json.get_updates_buf;
      return { msgs: json.msgs ?? [], cursor: json.get_updates_buf };
    },

    async sendText({ toUserId, contextToken, text }) {
      const json = await request('/ilink/bot/sendmessage', {
        method: 'POST',
        body: {
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: `wechat-bridge:${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: 1, text_item: { text } }],
          },
        },
      });
      return { messageId: json.message_id ?? null };
    },

    async sendTyping({ toUserId, contextToken, status }) {
      try {
        const cfg = await request('/ilink/bot/getconfig', {
          method: 'POST',
          body: { ilink_user_id: toUserId, ...(contextToken ? { context_token: contextToken } : {}) },
        });
        if (!cfg.typing_ticket) return;
        await request('/ilink/bot/sendtyping', {
          method: 'POST',
          body: { ilink_user_id: toUserId, typing_ticket: cfg.typing_ticket, status },
        });
      } catch (e) {
        if (e.kind === 'session-expired') throw e;
        logger?.warn?.(`sendTyping 失败（忽略）: ${e.message}`);
      }
    },
```

在 `createIlink` 顶部（`const baseUrl = ...` 之后）加游标变量：

```js
  let cursor = '';
```

并在 `createIlink` 返回对象里加上游标访问器（与 `request`、`get`、`post` 同级）：

```js
    get cursor() {
      return cursor;
    },
    set cursor(v) {
      cursor = typeof v === 'string' ? v : '';
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/ilink-messaging.test.mjs`
Expected: PASS，5 个用例

- [ ] **Step 5: 提交**

```bash
git add src/ilink.mjs test/ilink-messaging.test.mjs
git commit -m "feat: iLink 收发消息与 typing"
```

---

### Task 8: DSH 事件累积器

**Files:**
- Create: `src/dsh.mjs`
- Create: `test/dsh-accumulator.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `createAccumulator()` → `{ push(line) → event|null, state }`，`state` 字段：`{ sessionId, text, finalText, totalTokens, turns }`

- [ ] **Step 1: 写失败的测试**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-accumulator.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```js
// src/dsh.mjs
export function createAccumulator() {
  const state = {
    sessionId: null,
    text: '',
    finalText: null,
    totalTokens: 0,
    turns: 0,
  };

  function push(line) {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return null;

    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return { type: 'unparsed', raw: trimmed };
    }

    switch (ev.type) {
      case 'session':
        if (ev.sessionId) state.sessionId = ev.sessionId;
        break;
      case 'text':
        state.text += ev.text ?? '';
        break;
      case 'final':
        state.finalText = ev.text ?? '';
        break;
      case 'status':
        if (ev.phase === 'step_end') state.totalTokens += ev.usage?.totalTokens ?? 0;
        if (ev.phase === 'turn_end') state.turns += 1;
        break;
      default:
        break;
    }
    return ev;
  }

  return { push, state };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/dsh-accumulator.test.mjs`
Expected: PASS，5 个用例

- [ ] **Step 5: 提交**

```bash
git add src/dsh.mjs test/dsh-accumulator.test.mjs
git commit -m "feat: DSH NDJSON 事件累积器"
```

---

### Task 9: DSH 子进程执行器

**Files:**
- Modify: `src/dsh.mjs`（追加 `createRunner`、`defaultKillTree`）
- Create: `test-helpers/fake-spawn.mjs`
- Create: `test/dsh-runner.test.mjs`

**Interfaces:**
- Consumes: Task 8 的 `createAccumulator`
- Produces:
  - `defaultKillTree(pid)` → `Promise<void>`
  - `createRunner({ dshBin?, profile?, workspace, spawnImpl?, killTree?, logger?, timeoutMs? })`
  - `runner.run({ taskText, sessionId, onEvent, signal })` → `Promise<{ sessionId, finalText, text, totalTokens, turns, exitCode, stderrTail, timedOut }>`

- [ ] **Step 1: 写测试替身**

```js
// test-helpers/fake-spawn.mjs
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export function createFakeSpawn({ lines = [], stderr = '', exitCode = 0, hang = false, failLaunch = false } = {}) {
  const calls = [];
  const children = [];

  function spawnImpl(bin, args, opts) {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;

    if (failLaunch) {
      // 启动失败：pid 为空，随后异步 emit 'error'，再 emit 'close'
      child.pid = undefined;
      child.kill = () => false;
      children.push(child);
      setImmediate(() => {
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        child.emit('close', -4058);
      });
      return child;
    }

    child.pid = 4000 + calls.length;
    child.kill = () => {
      child.killed = true;
      child.emit('close', null);
      return true;
    };
    children.push(child);

    child.stdin.on('finish', () => {
      if (hang) return;
      for (const line of lines) child.stdout.write(line + '\n');
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', exitCode));
    });

    return child;
  }

  return { spawnImpl, calls, children };
}
```

- [ ] **Step 2: 写失败的测试**

```js
// test/dsh-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/dsh.mjs';
import { createFakeSpawn } from '../test-helpers/fake-spawn.mjs';

const LINES = [
  '{"type":"session","sessionId":"session-1"}',
  '{"type":"text","text":"OK"}',
  '{"type":"status","phase":"step_end","usage":{"totalTokens":42}}',
  '{"type":"final","text":"OK"}',
];

test('任务走 stdin，命令行不带任务文本', async () => {
  const fake = createFakeSpawn({ lines: LINES });
  const runner = createRunner({ workspace: 'D:\\DHS', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  await runner.run({ taskText: '只回复 OK' });

  const { args, opts } = fake.calls[0];
  assert.deepEqual(args.slice(-4), ['--profile', 'headless', '--json', '-']);
  assert.equal(opts.cwd, 'D:\\DHS');
});

test('Windows 上经 cmd.exe 间接启动 dsh.cmd，其他平台直接启动 dsh', async () => {
  const fake = createFakeSpawn({ lines: LINES });
  const runner = createRunner({ workspace: '.', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  await runner.run({ taskText: 'x' });

  const { bin, args } = fake.calls[0];
  if (process.platform === 'win32') {
    assert.match(bin, /cmd\.exe$/i);
    assert.deepEqual(args.slice(0, 3), ['/d', '/c', 'dsh']);
  } else {
    assert.equal(bin, 'dsh');
  }
});

test('带 sessionId 时加 --session-id', async () => {
  const fake = createFakeSpawn({ lines: LINES });
  const runner = createRunner({ workspace: '.', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  await runner.run({ taskText: 'x', sessionId: 'session-old' });
  assert.deepEqual(fake.calls[0].args.slice(-6), [
    '--profile',
    'headless',
    '--json',
    '--session-id',
    'session-old',
    '-',
  ]);
});

test('子进程必须带 DSH_PERMISSION_MODE=danger-full-access 且保留 PATH', async () => {
  const fake = createFakeSpawn({ lines: LINES });
  const runner = createRunner({ workspace: '.', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  await runner.run({ taskText: 'x' });
  const env = fake.calls[0].opts.env;
  assert.equal(env.DSH_PERMISSION_MODE, 'danger-full-access');
  assert.equal(env.PATH, process.env.PATH);
});

test('启动失败时 reject，而不是用未捕获 error 杀死宿主进程', async () => {
  const fake = createFakeSpawn({ failLaunch: true });
  const runner = createRunner({ workspace: '.', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  await assert.rejects(() => runner.run({ taskText: 'x' }), /启动失败/);
});

test('解析出 sessionId / finalText / token', async () => {
  const fake = createFakeSpawn({ lines: LINES });
  const runner = createRunner({ workspace: '.', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  const out = await runner.run({ taskText: 'x' });
  assert.equal(out.sessionId, 'session-1');
  assert.equal(out.finalText, 'OK');
  assert.equal(out.totalTokens, 42);
  assert.equal(out.exitCode, 0);
  assert.equal(out.timedOut, false);
});

test('非零退出时带回 stderr 尾部', async () => {
  const fake = createFakeSpawn({ lines: ['{"type":"session","sessionId":"s"}'], stderr: 'boom: 模型报错', exitCode: 2 });
  const runner = createRunner({ workspace: '.', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  const out = await runner.run({ taskText: 'x' });
  assert.equal(out.exitCode, 2);
  assert.ok(out.stderrTail.includes('boom'));
});

test('onEvent 逐条回调', async () => {
  const fake = createFakeSpawn({ lines: LINES });
  const runner = createRunner({ workspace: '.', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  const seen = [];
  await runner.run({ taskText: 'x', onEvent: (e) => seen.push(e.type) });
  assert.deepEqual(seen, ['session', 'text', 'status', 'final']);
});

test('中止时 kill 进程树并标记 timedOut', async () => {
  const fake = createFakeSpawn({ hang: true });
  const killed = [];
  const runner = createRunner({
    workspace: '.',
    spawnImpl: fake.spawnImpl,
    // 替身必须同时关闭子进程，否则 runner 会一直等 'close' 事件
    killTree: async (pid) => {
      killed.push(pid);
      fake.children[0].kill();
    },
  });
  const ac = new AbortController();
  const p = runner.run({ taskText: 'x', signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  const out = await p;
  assert.equal(out.timedOut, true);
  assert.deepEqual(killed, [4001]);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/dsh-runner.test.mjs`
Expected: FAIL — `createRunner is not a function`

- [ ] **Step 4: 实现（追加到 `src/dsh.mjs`）**

> **实测结论（不要删掉 `env`）**：headless profile 的 `settings` 插件是禁用的，`settings.yaml` 里的 `permission.defaultPreset` 不生效，所以它默认跑在 `workspace-write` 沙箱里。本机上该沙箱给 `D:\DHS` 授予写权限时会失败（`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DHS)`），而提权到 `danger-full-access` 又需要审批通道——headless 没有审批通道，于是任何命令都执行不了，桥只能聊天。
> 设 `DSH_PERMISSION_MODE=danger-full-access` 后实测正常（`pwd`、`node -v` 均返回）。这个环境变量同时把 approval 策略切成 `never`，与规格 §9「完全授权 + 急停」一致。

**先把 `import { spawn } from 'node:child_process';` 加到 `src/dsh.mjs` 最顶部**（ESM import 必须在顶层，不要留在下面的追加块里），然后把以下内容追加到文件末尾：

```js
export async function defaultKillTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const p = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
      p.on('close', resolve);
      p.on('error', resolve);
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

const STDERR_KEEP = 8000;

// Windows 上 `dsh` 只有 dsh.cmd：Node 24 拒绝 spawn *.cmd（EINVAL），
// spawn('dsh') 又会 ENOENT（libuv 不按 PATHEXT 解析）。所以经 cmd.exe 间接启动。
export function resolveLauncher({ platform = process.platform, comspec = process.env.ComSpec } = {}) {
  if (platform === 'win32') return { bin: comspec || 'cmd.exe', prefix: ['/d', '/c', 'dsh'] };
  return { bin: 'dsh', prefix: [] };
}

export function createRunner({
  dshBin,
  dshArgsPrefix,
  profile = 'headless',
  workspace,
  spawnImpl = spawn,
  killTree = defaultKillTree,
  logger,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  const launcher = dshBin ? { bin: dshBin, prefix: dshArgsPrefix ?? [] } : resolveLauncher();

  async function run({ taskText, sessionId, onEvent, signal } = {}) {
    const args = [...launcher.prefix, '--profile', profile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-');

    const acc = createAccumulator();
    let stderrTail = '';
    let timedOut = false;

    const child = spawnImpl(launcher.bin, args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access' },
    });

    // 必须立刻挂 error 监听：启动失败时 Node 会把 'error' 当未捕获事件，直接杀死宿主进程
    const launchErrors = [];
    child.on('error', (e) => launchErrors.push(e));

    if (!child.pid) {
      throw new Error(`DSH 进程启动失败: ${launchErrors[0]?.message ?? '子进程没有 pid'}`);
    }

    let buf = '';
    const feed = (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const ev = acc.push(line);
        if (ev && ev.type !== 'unparsed') onEvent?.(ev);
        else if (ev?.type === 'unparsed') logger?.warn?.(`跳过无法解析的行: ${ev.raw.slice(0, 120)}`);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', feed);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-STDERR_KEEP);
    });

    const kill = () => {
      timedOut = true;
      Promise.resolve(killTree(child.pid)).catch(() => {});
    };

    const timer = setTimeout(kill, timeoutMs);

    const onAbort = () => kill();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.stdin.on('error', () => {});
    child.stdin.end(taskText ?? '');

    const exitCode = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
    });

    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);

    // 没有换行结尾的残留片段也要计入
    if (buf.trim()) {
      const tail = acc.push(buf);
      if (tail && tail.type !== 'unparsed') onEvent?.(tail);
    }

    return {
      sessionId: acc.state.sessionId,
      finalText: acc.state.finalText,
      text: acc.state.text,
      totalTokens: acc.state.totalTokens,
      turns: acc.state.turns,
      exitCode,
      stderrTail,
      timedOut,
    };
  }

  return { run };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/dsh-runner.test.mjs`
Expected: PASS，9 个用例

- [ ] **Step 6: 真实验证（不是自动化测试，手工跑一次）**

```powershell
node -e "import('./src/dsh.mjs').then(async ({createRunner}) => { const r = createRunner({ workspace: 'D:\\DHS' }); const out = await r.run({ taskText: '只回复两个字：收到' }); console.log(JSON.stringify(out, null, 2)); })"
```

> 注意反斜杠：`'D:\DHS'` 在 JS 里会被转义成 `D:DHS`，spawn 直接 ENOENT。必须写 `'D:\\DHS'`。

修好启动器后这条命令应当**不借助任何注入**直接跑通。再补一条能证明权限环境变量真的生效的（要跑命令，只有 `danger-full-access` 下才可能成功）：

```powershell
node -e "import('./src/dsh.mjs').then(async ({createRunner}) => { const r = createRunner({ workspace: 'D:\\DHS' }); const out = await r.run({ taskText: '执行 node -v，只回复版本号' }); console.log(out.finalText); })"
```

Expected: 第二条打印 `v24.x.x` 之类的版本号；若打印的是权限/沙箱错误，说明 `DSH_PERMISSION_MODE` 没生效。

Expected: `finalText: "收到"`，`sessionId` 非空，`exitCode: 0`

- [ ] **Step 7: 提交**

```bash
git add src/dsh.mjs test-helpers/fake-spawn.mjs test/dsh-runner.test.mjs
git commit -m "feat: DSH 子进程执行器（NDJSON 流 + 进程树 kill）"
```

---

### Task 10: 命令解析、文本提取、去重

**Files:**
- Create: `src/router.mjs`
- Create: `test/router-parts.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `chunkText`
- Produces:
  - `parseCommand(text)` → `{ name, arg } | null`，`name` ∈ `'stop' | 'status' | 'new' | 'help'`
  - `extractText(msg)` → `{ kind: 'text' | 'unsupported', text? }`
  - `createDeduper({ size? })` → `{ seen(id) → boolean }`

- [ ] **Step 1: 写失败的测试**

```js
// test/router-parts.test.mjs
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/router-parts.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```js
// src/router.mjs
const ALIASES = new Map([
  ['stop', 'stop'],
  ['急停', 'stop'],
  ['status', 'status'],
  ['状态', 'status'],
  ['new', 'new'],
  ['新会话', 'new'],
  ['help', 'help'],
  ['帮助', 'help'],
]);

export function parseCommand(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith('/')) return null;
  const body = s.slice(1).trim();
  const [head, ...rest] = body.split(/\s+/);
  const name = ALIASES.get(head.toLowerCase());
  if (!name) return null;
  return { name, arg: rest.join(' ') };
}

export function extractText(msg) {
  const item = msg?.item_list?.[0];
  if (item?.type === 1 && typeof item.text_item?.text === 'string') {
    return { kind: 'text', text: item.text_item.text };
  }
  return { kind: 'unsupported', itemType: item?.type ?? null };
}

export function createDeduper({ size = 200 } = {}) {
  const ring = new Set();
  const order = [];
  return {
    seen(id) {
      const key = String(id);
      if (ring.has(key)) return true;
      ring.add(key);
      order.push(key);
      while (order.length > size) ring.delete(order.shift());
      return false;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/router-parts.test.mjs`
Expected: PASS，6 个用例

- [ ] **Step 5: 提交**

```bash
git add src/router.mjs test/router-parts.test.mjs
git commit -m "feat: 命令解析、文本提取、消息去重"
```

---

### Task 11: 路由、串行队列与执行流

**Files:**
- Modify: `src/router.mjs`（追加 `createRouter`）
- Create: `test/router.test.mjs`

**Interfaces:**
- Consumes: Task 2 `chunkText`、Task 10 三个辅助函数、Task 9 `runner`
- Produces: `createRouter({ ilink, runner, store, logger, ownerId, workspace, preamble?, limits? })` → `{ handle(msg), stop(), status(), idle() }`

- [ ] **Step 1: 写失败的测试**

```js
// test/router.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.mjs';

const OWNER = 'u@im.wechat';

function fakeIlink() {
  const sent = [];
  return {
    sent,
    sendText: async ({ text, toUserId, contextToken }) => {
      sent.push({ text, toUserId, contextToken });
      return { messageId: sent.length };
    },
    sendTyping: async () => {},
  };
}

function fakeRunner(result) {
  const runs = [];
  return {
    runs,
    run: async ({ taskText, sessionId }) => {
      runs.push({ taskText, sessionId });
      return {
        sessionId: 'session-new',
        finalText: '好的',
        text: '好的',
        totalTokens: 100,
        turns: 1,
        exitCode: 0,
        stderrTail: '',
        timedOut: false,
        ...result,
      };
    },
  };
}

function memoryStore() {
  const data = new Map();
  return {
    read: (k, f) => (data.has(k) ? data.get(k) : f),
    write: (k, v) => data.set(k, v),
  };
}

function msg(text, over = {}) {
  return {
    message_id: Math.random(),
    message_type: 1,
    from_user_id: OWNER,
    context_token: 'CT',
    item_list: [{ type: 1, text_item: { text } }],
    ...over,
  };
}

function build(over = {}) {
  const ilink = fakeIlink();
  const runner = fakeRunner(over.result);
  const store = memoryStore();
  const router = createRouter({
    ilink,
    runner,
    store,
    logger: { info() {}, warn() {}, error() {} },
    ownerId: OWNER,
    workspace: 'D:\\DHS',
    preamble: '[微信通道] ',
  });
  return { ilink, runner, store, router };
}

test('陌生人的消息直接丢弃', async () => {
  const { ilink, router } = build();
  await router.handle(msg('你好', { from_user_id: 'stranger@im.wechat' }));
  await router.idle();
  assert.equal(ilink.sent.length, 0);
});

test('非文本消息回提示', async () => {
  const { ilink, router } = build();
  await router.handle({ ...msg(''), item_list: [{ type: 2, image_item: {} }] });
  await router.idle();
  assert.ok(ilink.sent[0].text.includes('文字'));
});

test('正常任务：注入前缀、跑 runner、回结果、存会话', async () => {
  const { ilink, runner, store, router } = build();
  await router.handle(msg('写个脚本'));
  await router.idle();

  assert.equal(runner.runs.length, 1);
  assert.equal(runner.runs[0].taskText, '[微信通道] 写个脚本');
  assert.equal(runner.runs[0].sessionId, undefined);
  assert.ok(ilink.sent.some((s) => s.text === '好的'));
  assert.equal(ilink.sent.at(-1).contextToken, 'CT');
  assert.equal(store.read('session.json', {})[OWNER].sessionId, 'session-new');
});

test('第二轮带上次的 sessionId', async () => {
  const { runner, router } = build();
  await router.handle(msg('第一句'));
  await router.idle();
  await router.handle(msg('第二句'));
  await router.idle();
  assert.equal(runner.runs[0].sessionId, undefined);
  assert.equal(runner.runs[1].sessionId, 'session-new');
});

test('同一条消息只执行一次', async () => {
  const { runner, router } = build();
  const m = msg('一次');
  await router.handle(m);
  await router.handle(m);
  await router.idle();
  assert.equal(runner.runs.length, 1);
});

test('/help 不发任务', async () => {
  const { ilink, runner, router } = build();
  await router.handle(msg('/help'));
  await router.idle();
  assert.equal(runner.runs.length, 0);
  assert.ok(ilink.sent[0].text.includes('/stop'));
});

test('/status 报会话与 token', async () => {
  const { ilink, router } = build();
  await router.handle(msg('一'));
  await router.idle();
  await router.handle(msg('/status'));
  await router.idle();
  const last = ilink.sent.at(-1).text;
  assert.ok(last.includes('session-new'));
});

test('长结果按 2000 字分片', async () => {
  const { ilink, runner, router } = build({ result: { finalText: 'x'.repeat(4500) } });
  await router.handle(msg('长任务'));
  await router.idle();
  const long = ilink.sent.filter((s) => s.text.startsWith('x'));
  assert.equal(long.length, 3);
  assert.ok(long.every((s) => s.text.length <= 2000));
});

test('runner 非零退出时回 stderr 尾部', async () => {
  const { ilink, router } = build({
    result: { exitCode: 1, finalText: null, text: '', stderrTail: '模型调用失败' },
  });
  await router.handle(msg('跑一下'));
  await router.idle();
  assert.ok(ilink.sent.at(-1).text.includes('模型调用失败'));
});

test('队列满时立刻拒绝第 6 条', async () => {
  const { ilink, runner, router } = build();
  // 让任务永不自然结束，把 worker 占住
  runner.run = ({ signal }) =>
    new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () =>
          resolve({
            sessionId: null,
            finalText: null,
            text: '',
            totalTokens: 0,
            turns: 0,
            exitCode: 0,
            stderrTail: '',
            timedOut: true,
          }),
        { once: true },
      );
    });

  await router.handle(msg('任务0'));           // 占住 worker
  for (let i = 1; i <= 5; i++) await router.handle(msg(`任务${i}`)); // 塞满队列
  await router.handle(msg('任务6'));           // 应被拒

  assert.ok(ilink.sent.at(-1).text.includes('还在忙'));

  router.stop();                                // 清理，避免 pending 定时器挂住测试进程
  await router.idle();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/router.test.mjs`
Expected: FAIL — `createRouter is not a function`

- [ ] **Step 3: 实现（追加到 `src/router.mjs`）**

**先把 `import { chunkText } from './chunk.mjs';` 加到 `src/router.mjs` 最顶部**，再追加以下内容：

```js
const DEFAULT_PREAMBLE =
  '[微信通道·手机端] 你的回复会被分片显示在手机上。结论控制在 2000 字内；如果产出文件或需要用户选形式，先问再动手。\n\n';

const HELP = [
  '可用命令：',
  '/stop 或 /急停 —— 立刻中止当前任务并清空队列',
  '/status 或 /状态 —— 查看当前任务、会话与用量',
  '/new 或 /新会话 —— 强制换一个新会话',
  '/help 或 /帮助 —— 这条消息',
].join('\n');

export function createRouter({
  ilink,
  runner,
  store,
  logger,
  ownerId,
  preamble = DEFAULT_PREAMBLE,
  limits = { queue: 5, timeoutMs: 30 * 60 * 1000 },
} = {}) {
  const deduper = createDeduper({ size: 200 });
  const queue = [];
  let current = null;
  let running = false;
  let stopped = false;

  const saveSession = (userId, patch) => {
    const all = store.read('session.json', {});
    all[userId] = { ...(all[userId] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    store.write('session.json', all);
    return all[userId];
  };

  const currentSession = (userId) => store.read('session.json', {})[userId] ?? null;

  async function send(userId, contextToken, text) {
    for (const piece of chunkText(text)) {
      await ilink.sendText({ toUserId: userId, contextToken, text: piece });
    }
  }

  async function runTask({ text, userId, contextToken }) {
    const session = currentSession(userId);
    const taskText = `${preamble}${text}`;

    current = { userId, startedAt: Date.now() };
    const ac = new AbortController();
    current.abort = () => ac.abort();

    let typingTimer = setInterval(() => {
      void ilink.sendTyping({ toUserId: userId, contextToken, status: 1 }).catch(() => {});
    }, 5000);
    void ilink.sendTyping({ toUserId: userId, contextToken, status: 1 }).catch(() => {});

    // 立刻回执，别让人对着空会话干等
    await send(userId, contextToken, '收到，开始处理…');

    // 45 秒还没出结果时推一条轻进度，每次任务最多一条
    const progressTimer = setTimeout(() => {
      void send(userId, contextToken, '还在处理，稍等…').catch(() => {});
    }, 45000);

    try {
      const out = await runner.run({
        taskText,
        sessionId: session?.sessionId,
        signal: ac.signal,
      });

      if (out.sessionId) {
        saveSession(userId, {
          sessionId: out.sessionId,
          turns: (session?.turns ?? 0) + (out.turns || 1),
          totalTokens: (session?.totalTokens ?? 0) + (out.totalTokens ?? 0),
        });
      }

      if (out.timedOut) {
        await send(userId, contextToken, '任务已中止（超时或被 /stop 打断）。');
        return;
      }

      const answer = out.finalText ?? out.text ?? '';
      if (out.exitCode !== 0 && !answer.trim()) {
        const tail = (out.stderrTail || '').trim().slice(-800);
        await send(userId, contextToken, `任务失败（退出码 ${out.exitCode}）。${tail ? `\n\n${tail}` : ''}`);
        return;
      }
      await send(userId, contextToken, answer.trim() || '任务结束，没有输出。');
    } catch (e) {
      if (ac.signal.aborted) {
        await send(userId, contextToken, '已停止。');
      } else {
        logger?.error(`任务执行异常: ${e.message}`);
        await send(userId, contextToken, `出错了：${e.message}`);
      }
    } finally {
      clearInterval(typingTimer);
      clearTimeout(progressTimer);
      typingTimer = null;
      void ilink.sendTyping({ toUserId: userId, contextToken, status: 2 }).catch(() => {});
      current = null;
    }
  }

  async function worker() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        const job = queue.shift();
        await runTask(job);
      }
    } finally {
      running = false;
    }
  }

  async function handle(msg) {
    if (msg?.message_type !== 1) return;
    if (msg.from_user_id !== ownerId) {
      logger?.warn(`忽略陌生来源消息 from=${msg.from_user_id}`);
      return;
    }
    if (msg.message_id !== undefined && deduper.seen(msg.message_id)) return;

    const extracted = extractText(msg);
    const contextToken = msg.context_token;

    if (extracted.kind === 'unsupported') {
      await send(msg.from_user_id, contextToken, '目前只支持文字消息。');
      return;
    }

    const cmd = parseCommand(extracted.text);
    if (cmd) {
      await handleCommand(cmd, msg.from_user_id, contextToken);
      return;
    }

    if (queue.length >= limits.queue) {
      await send(msg.from_user_id, contextToken, `还在忙，已排队 ${limits.queue} 条，多的先不收了。`);
      return;
    }

    queue.push({ text: extracted.text, userId: msg.from_user_id, contextToken });
    void worker();
  }

  async function handleCommand(cmd, userId, contextToken) {
    switch (cmd.name) {
      case 'stop':
        stop();
        await send(userId, contextToken, '已停止。');
        break;
      case 'status': {
        const s = currentSession(userId);
        const lines = [
          `当前任务：${current ? '执行中' : '空闲'}`,
          `排队：${queue.length} 条`,
          `会话：${s?.sessionId ?? '（尚未创建）'}`,
          `累计轮次：${s?.turns ?? 0}`,
          `累计 token：${s?.totalTokens ?? 0}`,
        ];
        await send(userId, contextToken, lines.join('\n'));
        break;
      }
      case 'new':
        saveSession(userId, { sessionId: null, turns: 0, totalTokens: 0, summary: null });
        await send(userId, contextToken, '已换新会话，之前的上下文不再带过去。');
        break;
      case 'help':
      default:
        await send(userId, contextToken, HELP);
        break;
    }
  }

  function stop() {
    queue.length = 0;
    if (current?.abort) current.abort();
  }

  return {
    handle,
    stop,
    status: () => ({ current, pending: queue.length }),
    idle: async () => {
      while (running || queue.length) await new Promise((r) => setTimeout(r, 5));
    },
  };
}
```

**说明**：`stop()` 不永久停机，只清空队列并中止当前任务；`stopped` 只用于让 worker 循环退出一次。任务开始前先发一条固定回执（不依赖模型），这样即使模型要跑几分钟，你也不会对着空会话干等。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/router.test.mjs`
Expected: PASS，11 个用例

- [ ] **Step 5: 全量回归**

Run: `node --test`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/router.mjs test/router.test.mjs
git commit -m "feat: 路由、串行队列与任务执行流"
```

---

### Task 12: 会话自动换代

**Files:**
- Modify: `src/router.mjs`（追加 `maybeRollover`）
- Create: `test/rollover.test.mjs`

**Interfaces:**
- Consumes: Task 11 的 `createRouter` 内部状态
- Produces: `maybeRollover({ runner, store, userId, logger, limits })` → `Promise<{ rolled: boolean, summary: string | null }>`

- [ ] **Step 1: 写失败的测试**

```js
// test/rollover.test.mjs
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/rollover.test.mjs`
Expected: FAIL — `maybeRollover is not a function`

- [ ] **Step 3: 实现（追加到 `src/router.mjs` 顶层导出）**

```js
const SUMMARY_PROMPT =
  '把目前为止的关键信息、结论和未完成事项压成 300 字以内的中文摘要，供下一个会话接手使用。只输出摘要本身。';

export async function maybeRollover({
  runner,
  store,
  userId,
  logger,
  limits = { maxTokens: 150000, maxTurns: 40 },
} = {}) {
  const all = store.read('session.json', {});
  const session = all[userId];
  if (!session?.sessionId) return { rolled: false, summary: null };

  const overTokens = (session.totalTokens ?? 0) > limits.maxTokens;
  const overTurns = (session.turns ?? 0) > limits.maxTurns;
  if (!overTokens && !overTurns) return { rolled: false, summary: null };

  let summary = null;
  try {
    const out = await runner.run({ taskText: SUMMARY_PROMPT, sessionId: session.sessionId });
    summary = (out.finalText ?? out.text ?? '').trim() || null;
  } catch (e) {
    logger?.warn?.(`生成摘要失败，直接换代: ${e.message}`);
  }

  all[userId] = {
    ...session,
    sessionId: null,
    turns: 0,
    totalTokens: 0,
    summary,
    updatedAt: new Date().toISOString(),
  };
  store.write('session.json', all);
  return { rolled: true, summary };
}
```

- [ ] **Step 4: 把换代接进 `runTask`**

在 `runTask` 开头、取 `session` 之前插入：

```js
    const roll = await maybeRollover({ runner, store, userId, logger, limits: { maxTokens: 150000, maxTurns: 40 } });
    if (roll.rolled) {
      const note = roll.summary
        ? '上下文换新了，前面的事我记得（摘要已带过去）。'
        : '上下文换新了，但摘要没生成成功，前面的事可能要你提一句。';
      await send(userId, contextToken, note);
    }
```

并把 `taskText` 的拼装改为带上摘要：

```js
    const session = currentSession(userId);
    const prefix = session?.summary ? `（前情提要：${session.summary}）\n\n` : '';
    const taskText = `${prefix}${preamble}${text}`;
```

**注意**：`session` 必须在 `maybeRollover` 之后重新读取，否则拿到的是换代前的对象。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/rollover.test.mjs`
Expected: PASS，5 个用例

- [ ] **Step 6: 全量回归**

Run: `node --test`
Expected: 全部 PASS（router.test.mjs 应仍然通过——换代默认不触发）

- [ ] **Step 7: 提交**

```bash
git add src/router.mjs test/rollover.test.mjs
git commit -m "feat: 会话超长自动换代并携带摘要"
```

---

### Task 13: 主程序装配、自启脚本与说明文档

**Files:**
- Create: `src/main.mjs`
- Create: `scripts/install-task.ps1`
- Create: `README.md`

**Interfaces:**
- Consumes: 全部前述模块
- Produces: 可 `node src/main.mjs` 启动的常驻进程

- [ ] **Step 1: 实现主程序**

```js
// src/main.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { createLogger } from './log.mjs';
import { createIlink } from './ilink.mjs';
import { createRunner } from './dsh.mjs';
import { createRouter } from './router.mjs';
import { renderQr } from './qr.mjs';

const STATE_DIR = join(homedir(), '.wechat-bridge');
const WORKSPACE = process.env.BRIDGE_WORKSPACE || 'D:\\DHS';
const CHANNEL_VERSION = '1.0.0';
const QR_PNG = join(STATE_DIR, 'qr.png');

const store = createStore(STATE_DIR);
const logger = createLogger({ dir: join(STATE_DIR, 'logs') });
const runner = createRunner({ workspace: WORKSPACE, logger });

let ilink;
let stopped = false;
const shutdown = new AbortController();

async function ensureCreds() {
  const saved = store.read('creds.json', null);
  if (saved?.token) {
    logger.info(`已加载凭证 bot=${saved.accountId}`);
    return saved;
  }
  const fresh = await ilink.login({
    signal: shutdown.signal,
    onQr: async ({ url }) => {
      const { ascii } = await renderQr(url, { pngPath: QR_PNG });
      console.log(ascii);
      logger.warn(`需要扫码登录：二维码已写入 ${QR_PNG}`);
    },
  });
  store.write('creds.json', fresh);
  logger.info(`登录成功 bot=${fresh.accountId}`);
  return fresh;
}

async function main() {
  logger.info(`桥启动 workspace=${WORKSPACE} state=${STATE_DIR}`);
  ilink = createIlink({ creds: null, logger, channelVersion: CHANNEL_VERSION });

  let creds = store.read('creds.json', null);
  if (!creds?.token) creds = await ensureCreds();
  ilink = createIlink({ creds, logger, channelVersion: CHANNEL_VERSION });

  const router = createRouter({
    ilink,
    runner,
    store,
    logger,
    ownerId: creds.userId,
    workspace: WORKSPACE,
  });

  const cursorFile = store.read('cursor.json', {});
  ilink.cursor = cursorFile.getUpdatesBuf ?? '';

  let failures = 0;
  while (!stopped) {
    try {
      const { msgs, cursor } = await ilink.poll({ signal: shutdown.signal });
      if (cursor) store.write('cursor.json', { botId: creds.accountId, getUpdatesBuf: cursor });
      failures = 0;
      for (const m of msgs) await router.handle(m);
    } catch (e) {
      if (shutdown.signal.aborted) break;

      if (e.kind === 'session-expired') {
        logger.warn('session 过期，清除凭证并重新扫码');
        store.write('creds.json', null);
        store.write('cursor.json', {});
        creds = await ensureCreds();
        ilink = createIlink({ creds, logger, channelVersion: CHANNEL_VERSION });
        ilink.cursor = '';
        continue;
      }

      failures += 1;
      const waitMs = failures >= 3 ? 30000 : 2000;
      logger.error(`轮询失败(${failures}): ${e.message}；${waitMs}ms 后重试`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  logger.info('桥已退出');
}

process.on('SIGINT', () => {
  stopped = true;
  shutdown.abort();
});
process.on('SIGTERM', () => {
  stopped = true;
  shutdown.abort();
});
process.on('unhandledRejection', (e) => logger.error(`未处理的 Promise 拒绝: ${e?.message ?? e}`));

main().catch((e) => {
  logger.error(`致命错误: ${e.stack ?? e.message}`);
  process.exit(1);
});
```

**说明**：`ilink.cursor` 的 getter/setter 已在 Task 7 实现并测试，本任务不要重复添加，直接使用即可。

- [ ] **Step 2: 写自启脚本**

```powershell
# scripts/install-task.ps1
$ErrorActionPreference = 'Stop'

$bridgeDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$entry = Join-Path $bridgeDir 'src\main.mjs'
$taskName = 'WeChatBridge'

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $bridgeDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "已注册计划任务 $taskName，登录时自动启动。"

# 立刻启动一次
Start-ScheduledTask -TaskName $taskName
Write-Host "已启动。查看状态： Get-ScheduledTask -TaskName $taskName"
```

- [ ] **Step 4: 写 README**

```markdown
# wechat-bridge

把个人微信接成 DeepSeek Harness 的对话入口。微信里发消息 → 本机 `dsh headless` 执行 → 结果回微信。

## 依赖

- Node.js >= 24
- `dsh` 在 PATH 上

## 首次运行

```powershell
npm i
node src/main.mjs
```

终端会打印二维码，微信扫码确认。凭证存到 `%USERPROFILE%\.wechat-bridge\creds.json`，之后不再需要扫码。

## 命令

| 命令 | 说明 |
|---|---|
| `/stop` `/急停` | 中止当前任务并清空队列 |
| `/status` `/状态` | 当前任务、会话、用量 |
| `/new` `/新会话` | 强制换新会话 |
| `/help` `/帮助` | 命令列表 |

## 开机自启

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
```

## 排查

- 二维码在 `%USERPROFILE%\.wechat-bridge\qr.png`
- 日志在 `%USERPROFILE%\.wechat-bridge\logs\bridge-YYYY-MM-DD.log`
- 收到 `-14` 会自动清凭证并要求重新扫码

## 已知限制

- 只支持文字消息（图片/语音/文件见 v2）
- 主动推送受微信 24 小时窗口限制
```

- [ ] **Step 5: 启动冒烟测试（手工）**

```powershell
node src/main.mjs
```

Expected: 日志出现 `桥启动`、`已加载凭证`，不报错。微信发「你好」，收到回复。

- [ ] **Step 6: 提交**

```bash
git add src/main.mjs scripts/install-task.ps1 README.md
git commit -m "feat: 主程序装配、自启脚本与说明文档"
```

---

### Task 14: 全链路集成测试（真实 HTTP）

**Files:**
- Create: `test/integration.test.mjs`

**Interfaces:**
- Consumes: Task 7 的 `createIlink`、Task 11 的 `createRouter`
- Produces: 无需产出，仅测试

- [ ] **Step 1: 写测试**

```js
// test/integration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createIlink } from '../src/ilink.mjs';
import { createRouter } from '../src/router.mjs';

function startFakeIlink() {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      received.push({ url: req.url, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/ilink/bot/getconfig')) {
        return res.end(JSON.stringify({ ret: 0, typing_ticket: 'tt' }));
      }
      if (req.url.startsWith('/ilink/bot/sendtyping')) {
        return res.end(JSON.stringify({ ret: 0 }));
      }
      if (req.url.startsWith('/ilink/bot/sendmessage')) {
        return res.end(JSON.stringify({ ret: 0, message_id: 777 }));
      }
      return res.end(JSON.stringify({ ret: 0 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, port: server.address().port });
    });
  });
}

test('全链路：消息进来，两条消息出去，头和 context_token 都对', async () => {
  const { server, received, port } = await startFakeIlink();
  try {
    const ilink = createIlink({ creds: { token: 'tok', baseUrl: `http://127.0.0.1:${port}` } });
    const data = new Map();
    const store = {
      read: (k, f) => (data.has(k) ? data.get(k) : f),
      write: (k, v) => data.set(k, v),
    };
    const router = createRouter({
      ilink,
      runner: {
        run: async () => ({
          sessionId: 's1',
          finalText: '这是回答',
          text: '这是回答',
          totalTokens: 5,
          turns: 1,
          exitCode: 0,
          stderrTail: '',
          timedOut: false,
        }),
      },
      store,
      logger: { info() {}, warn() {}, error() {} },
      ownerId: 'u@im.wechat',
      preamble: '',
    });

    await router.handle({
      message_id: 1,
      message_type: 1,
      from_user_id: 'u@im.wechat',
      context_token: 'CT-1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    });
    await router.idle();

    const sends = received.filter((r) => r.url.startsWith('/ilink/bot/sendmessage'));
    assert.equal(sends.length, 2);
    assert.equal(sends[0].body.msg.item_list[0].text_item.text, '收到，开始处理…');
    assert.equal(sends[1].body.msg.item_list[0].text_item.text, '这是回答');

    for (const s of sends) {
      assert.equal(s.body.msg.context_token, 'CT-1');
      assert.equal(s.headers.authorization, 'Bearer tok');
      assert.equal(s.headers.authorizationtype, 'ilink_bot_token');
      assert.ok(s.headers['x-wechat-uin']);
      assert.deepEqual(s.body.base_info, { channel_version: '1.0.0' });
    }
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: 运行**

Run: `node --test test/integration.test.mjs`
Expected: PASS，1 个用例

- [ ] **Step 3: 提交**

```bash
git add test/integration.test.mjs
git commit -m "test: 假 iLink 服务全链路集成测试"
```

---

### Task 15: 端到端验收

**Files:**
- Create: `docs/superpowers/plans/acceptance-2026-10-21.md`（记录验收结果）

**Interfaces:**
- Consumes: 已启动的桥
- Produces: 验收记录

- [ ] **Step 1: 逐条验收并记录**

在微信里依次执行：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 发「你好」 | 收到回复，`dsh` 日志里有一次 `session` 事件 |
| 2 | 发「在 D:\DHS 建一个 test-wechat.txt，内容是 hello」 | 文件真实存在且内容为 `hello`，微信收到确认 |
| 3 | 紧接着发「把刚才那个文件读出来」 | 正确读到 `hello`（验证会话连续性） |
| 4 | 发一个长任务后立刻发 `/stop` | 任务中止，收到「已停止」 |
| 5 | 发 `/status` | 显示会话 id 与累计 token |
| 6 | 发 `/help` | 收到命令列表 |
| 7 | 关掉进程再启动 | 不需重新扫码，历史会话仍可续接 |

- [ ] **Step 2: 把结果写进验收文档**

```markdown
# 微信桥端到端验收（2026-10-21）

| # | 项 | 结果 | 备注 |
|---|---|---|---|
| 1 | 你好 | PASS | |
| 2 | 建文件 | PASS | |
| 3 | 会话连续 | PASS | |
| 4 | /stop | PASS | |
| 5 | /status | PASS | |
| 6 | /help | PASS | |
| 7 | 重启免扫码 | PASS | |
```

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/plans/acceptance-2026-10-21.md
git commit -m "docs: 端到端验收记录"
```

---

## 附：任务依赖顺序

```
T1 store ─┬─ T2 chunk ───────────────────┐
          ├─ T3 log ─────────────────────┤
          ├─ T5 qr ──────────────────────┤
          ├─ T4 ilink 请求 ─ T6 登录 ─ T7 收发 ─┤
          ├─ T8 累积器 ─ T9 runner ─────────────┤
          └─ T10 路由零件 ─ T11 router ─ T12 换代 ─ T13 main ─ T14 集成 ─ T15 验收
```

T1–T3 可并行；T4 之后串行；T10 可与 T8/T9 并行。

## 附二：计划文本 vs 最终实现

本计划的代码块是**开工前的设计稿**。实施过程中有若干处被规格与审查推翻，最终以**代码 + 规格 §11**为准：

| 位置 | 计划的写法 | 最终实现 | 原因 |
|---|---|---|---|
| T2 分片 | `if (rest) out.push(rest)` | `if (rest.trim())` | 与计划自己的「不产生空片」测试冲突 |
| T2 分片 | 无 `limit` 守卫 | 非法 `limit` 回退 2000 | `limit=0/null` 会死循环挂死常驻进程 |
| T4 错误归一 | 只有 `-14` 与 `>=500` | 补 401/403→`auth`、`!res.ok`→`server`，读 body 失败也归一 | 接口承诺了 `auth` 却不可达；4xx 被当成功 |
| T7 收发 | 所有 `network` 都当空轮询 | 仅本地超时才吞（`cause.name === 'TimeoutError'`） | 断网会变成零延迟热循环且不打日志 |
| T9 启动 | `spawn('dsh')` | Windows 经 `cmd.exe /d /c dsh` | 本机只有 `dsh.cmd`，Node 24 拒绝直接 spawn |
| T9 启动 | 无 env | 注入 `DSH_PERMISSION_MODE=danger-full-access` | 否则子进程跑不了任何命令 |
| T11 发送 | `send()` 直抛 | `safeSend()` best-effort | 一次发送失败会泄漏定时器、卡死队列 |
| T11 队列 | `void worker()` | `void worker().catch()` + 逐任务 try | 未捕获 rejection 在 Node 24 下杀进程 |
| T12 换代 | 换代在 `current` 之前 | `current`/abort 提到最前，`signal` 传入摘要 | `/stop` 在换代期间是空操作 |
| T13 关停 | 只置标志 | 调 `router.stop()` + 5 秒有界收尾 | 否则子进程活到 30 分钟超时 |
| T13 登录 | 失败即 `exit(1)` | 可重试退避；`aborted` 干净退出 0 | 扫码期间 Ctrl-C 会把守护进程杀掉 |

完整的裁决记录见 `.superpowers/sdd/2026-10-21-wechat-bridge/progress.md`（该目录被 gitignore）。

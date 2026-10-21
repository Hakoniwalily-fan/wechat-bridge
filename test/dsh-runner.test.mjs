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
  // 本机 Windows 环境块里键名是 "Path"（不是 "PATH"）：process.env 读取大小写不敏感，
  // 但 `{ ...process.env }` 展开成普通对象后键名保持原样，env.PATH 会是 undefined。
  // 所以按真实键名取值——语义仍是「PATH 没有被 env 覆盖吞掉，dsh 能被解析到」。
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
  assert.equal(env[pathKey], process.env.PATH);
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

test('已 abort 的 signal 也会 kill，同步关闭的 killTree 不会让 run 挂住', async () => {
  const fake = createFakeSpawn({ hang: true });
  const killed = [];
  const runner = createRunner({
    workspace: '.',
    spawnImpl: fake.spawnImpl,
    // 若 close 监听挂得比 kill 晚，run 会永不 settle。给个短 timeout，
    // 这样即使真的挂住，也不会把整个测试进程拖死。
    timeoutMs: 50,
    killTree: async (pid) => {
      killed.push(pid);
      fake.children[0].kill(); // 同步 emit 'close'
    },
  });
  const ac = new AbortController();
  ac.abort(); // 派发前就已急停
  let hangTimer;
  const hang = new Promise((r) => {
    hangTimer = setTimeout(() => r('HANG'), 1000);
  });
  const out = await Promise.race([runner.run({ taskText: 'x', signal: ac.signal }), hang]);
  clearTimeout(hangTimer);
  assert.notEqual(out, 'HANG', 'run() 没有 settle：close 监听挂得比 kill 晚');
  assert.equal(out.timedOut, true);
  assert.deepEqual(killed, [4001]);
});

test('onEvent 抛异常不会杀死进程，run 照常返回', async () => {
  const fake = createFakeSpawn({ lines: LINES });
  const warns = [];
  const runner = createRunner({
    workspace: '.',
    spawnImpl: fake.spawnImpl,
    killTree: async () => {},
    // 短 timeout：万一回调抛错把 run 卡死，也别让默认 30 分钟的定时器吊住测试进程
    timeoutMs: 50,
    logger: { warn: (m) => warns.push(m) },
  });
  const out = await runner.run({
    taskText: 'x',
    onEvent: () => {
      throw new Error('推送失败');
    },
  });
  assert.equal(out.exitCode, 0);
  assert.equal(out.finalText, 'OK');
  assert.ok(warns.some((m) => m.includes('onEvent')), '应当用 logger.warn 记录回调抛错');
});

test('启动失败的错误带上真实原因，而不是兜底文案', async () => {
  const fake = createFakeSpawn({ failLaunch: true });
  const runner = createRunner({ workspace: '.', spawnImpl: fake.spawnImpl, killTree: async () => {} });
  await assert.rejects(
    () => runner.run({ taskText: 'x' }),
    (e) => {
      assert.match(e.message, /启动失败/);
      assert.match(e.message, /ENOENT/);
      return true;
    },
  );
});

test('kill 之后子进程一直不 close：宽限到点按超时收尾，worker 不会永久卡住', async () => {
  const fake = createFakeSpawn({ hang: true });
  const warns = [];
  const runner = createRunner({
    workspace: '.',
    spawnImpl: fake.spawnImpl,
    // killTree 正常返回，但子进程永远不发 'close'（taskkill 失败 / cmd.exe 不理）
    killTree: async () => {},
    killGraceMs: 25,
    logger: { warn: (m) => warns.push(m) },
  });

  const ac = new AbortController();
  const p = runner.run({ taskText: 'x', signal: ac.signal });
  setTimeout(() => ac.abort(), 5);

  const out = await p;
  assert.equal(out.timedOut, true, '宽限到点必须按超时收尾');
  assert.equal(out.exitCode, -1);
  assert.equal(fake.children[0].killed, false, '这个替身确实没被杀死');
  assert.ok(warns.some((m) => m.includes('仍未退出')), warns.join(' | '));
});

test('宽限期内正常 close 会清掉宽限计时器，不留悬浮定时器', async () => {
  const fake = createFakeSpawn({ hang: true });
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const GRACE_MS = 777;
  const timers = new Map();

  globalThis.setTimeout = (fn, ms, ...rest) => {
    const h = realSetTimeout(fn, ms, ...rest);
    if (ms === GRACE_MS) timers.set(h, { cleared: false });
    return h;
  };
  globalThis.clearTimeout = (h) => {
    const rec = timers.get(h);
    if (rec) rec.cleared = true;
    return realClearTimeout(h);
  };

  try {
    const runner = createRunner({
      workspace: '.',
      spawnImpl: fake.spawnImpl,
      killGraceMs: GRACE_MS,
      // kill 之后 10ms 子进程才真的退出（正常路径）
      killTree: async () => {
        realSetTimeout(() => fake.children[0].kill(), 10);
      },
    });

    const ac = new AbortController();
    const p = runner.run({ taskText: 'x', signal: ac.signal });
    realSetTimeout(() => ac.abort(), 5);

    const out = await p;
    assert.equal(out.timedOut, true);
    assert.equal(out.exitCode, -1, 'close 时 code 为 null，应归一成 -1');

    const grace = [...timers.values()];
    assert.equal(grace.length, 1, '应建立且只建立一个宽限计时器');
    assert.equal(grace[0].cleared, true, '正常 close 后宽限计时器必须被清掉');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

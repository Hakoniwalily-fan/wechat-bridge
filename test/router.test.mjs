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
    logger: over.logger ?? { info() {}, warn() {}, error() {} },
    ownerId: OWNER,
    workspace: 'D:\\DHS',
    preamble: '[微信通道] ',
    mediaStore: over.mediaStore,
    uploader: over.uploader,
  });
  return { ilink, runner, store, router };
}

function fakeMediaStore(saved, { throws } = {}) {
  const calls = [];
  return {
    calls,
    saveInbound: async ({ item, messageId }) => {
      calls.push({ item, messageId });
      if (throws) throw new Error(throws);
      return saved;
    },
  };
}

function mediaMsg(type, sub, over = {}) {
  return {
    message_id: Math.random(),
    message_type: 1,
    from_user_id: OWNER,
    context_token: 'CT',
    item_list: [{ type, ...sub }],
    ...over,
  };
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

test('非零退出但已有半截回答：回答、退出码、stderr 一起发，且不计轮次', async () => {
  const { ilink, store, router } = build({
    result: { exitCode: 2, finalText: '半截回答', stderrTail: 'boom' },
  });
  store.write('session.json', { [OWNER]: { sessionId: 's-old', turns: 5, totalTokens: 10 } });

  await router.handle(msg('跑一半炸了'));
  await router.idle();

  const all = ilink.sent.map((s) => s.text).join('\n---\n');
  assert.ok(all.includes('半截回答'), all);
  assert.ok(all.includes('退出码 2'), all);
  assert.ok(all.includes('boom'), all);

  const s = store.read('session.json', {})[OWNER];
  assert.equal(s.turns, 5, '失败的运行不算一轮对话，turns 不能加');
  assert.equal(s.totalTokens, 110, 'token 是真的花掉了，必须照记');
  assert.equal(s.sessionId, 'session-new');
});

test('finalText 是空串时退回累积 text，而不是"没有输出"', async () => {
  const { ilink, router } = build({ result: { finalText: '', text: '累积出来的回答' } });
  await router.handle(msg('空 final'));
  await router.idle();

  assert.ok(ilink.sent.at(-1).text.includes('累积出来的回答'), ilink.sent.at(-1).text);
  assert.ok(!ilink.sent.some((s) => s.text.includes('没有输出')));
});

test('session 在 dsh 侧不存在：清掉 sessionId、保留统计、并告知用户已重置', async () => {
  const { ilink, runner, store, router } = build({
    result: {
      sessionId: null,
      finalText: null,
      text: '',
      exitCode: 1,
      stderrTail: 'Error: session "s-dead" does not exist; omit --session-id',
    },
  });
  store.write('session.json', {
    [OWNER]: { sessionId: 's-dead', turns: 3, totalTokens: 100, summary: '前情' },
  });

  await router.handle(msg('接着上次'));
  await router.idle();

  const s = store.read('session.json', {})[OWNER];
  assert.equal(s.sessionId, null, '死掉的 sessionId 必须清掉，否则后面每个任务都会失败');
  assert.equal(s.turns, 3, '累计轮次不能被清');
  assert.equal(s.totalTokens, 100, '累计 token 不能被清');
  assert.equal(s.summary, '前情', '摘要不能被清');
  assert.ok(
    ilink.sent.some((m) => m.text.includes('已重置')),
    ilink.sent.map((m) => m.text).join(' | '),
  );

  // 下一条任务不能再拿这个死 id 去试（router 传 null，dsh 只在 sessionId 为真时才加 --session-id）
  runner.runs.length = 0;
  await router.handle(msg('再来一句'));
  await router.idle();
  assert.equal(runner.runs[0].sessionId, null);
  assert.notEqual(runner.runs[0].sessionId, 's-dead');
});

test('无关失败（模型报错）不清 sessionId', async () => {
  const { ilink, store, router } = build({
    result: { sessionId: null, finalText: null, text: '', exitCode: 1, stderrTail: 'dsh: model exploded' },
  });
  store.write('session.json', { [OWNER]: { sessionId: 's-live', turns: 2, totalTokens: 50 } });

  await router.handle(msg('跑一下'));
  await router.idle();

  const s = store.read('session.json', {})[OWNER];
  assert.equal(s.sessionId, 's-live', '别的失败不能误清会话');
  assert.equal(s.turns, 2);
  assert.ok(ilink.sent.at(-1).text.includes('退出码 1'), ilink.sent.at(-1).text);
});

test('会话属于别的工作区（"was recorded in … not …"）也清 sessionId 并告知已重置', async () => {
  // dsh 实测原文：`dsh: session "…" was recorded in "C:\…\wsA", not "C:\…\wsB"`（退出码 1）
  const { ilink, store, router } = build({
    result: {
      sessionId: null,
      finalText: null,
      text: '',
      exitCode: 1,
      stderrTail: 'dsh: session "session-1f56158b" was recorded in "C:\\wsA", not "C:\\wsB"',
    },
  });
  store.write('session.json', { [OWNER]: { sessionId: 'session-1f56158b', turns: 7, totalTokens: 900 } });

  await router.handle(msg('换个工作区接着聊'));
  await router.idle();

  const s = store.read('session.json', {})[OWNER];
  assert.equal(s.sessionId, null);
  assert.equal(s.turns, 7);
  assert.equal(s.totalTokens, 900);
  assert.ok(
    ilink.sent.some((m) => m.text.includes('已重置')),
    ilink.sent.map((m) => m.text).join(' | '),
  );
});

test('模型报错里提到 session 但措辞不对：不清 sessionId', async () => {
  const { store, router } = build({
    result: {
      sessionId: null,
      finalText: null,
      text: '',
      exitCode: 1,
      stderrTail: 'Error: failed to persist session record: EACCES',
    },
  });
  store.write('session.json', { [OWNER]: { sessionId: 's-live', turns: 2, totalTokens: 50 } });

  await router.handle(msg('跑一下'));
  await router.idle();

  assert.equal(store.read('session.json', {})[OWNER].sessionId, 's-live');
});

test('泛化措辞（config session dir … does not exist）不误清 sessionId，也不吞本轮的新 id', async () => {
  // 结构上命中 "session … does not exist"，但里面没有本轮的 session id，和会话失效无关
  const { ilink, store, router } = build({
    result: {
      sessionId: 'session-fresh',
      finalText: null,
      text: '',
      exitCode: 1,
      stderrTail: 'Error: config session dir C:\\Users\\x does not exist',
    },
  });
  store.write('session.json', { [OWNER]: { sessionId: 's-live', turns: 2, totalTokens: 50 } });

  await router.handle(msg('跑一下'));
  await router.idle();

  const s = store.read('session.json', {})[OWNER];
  assert.equal(s.sessionId, 'session-fresh', '健康会话不能误清，本轮拿到的新 id 也要照存');
  assert.equal(s.turns, 2, '失败的运行仍不计轮次');
  assert.ok(
    !ilink.sent.some((m) => m.text.includes('已重置')),
    ilink.sent.map((m) => m.text).join(' | '),
  );
  assert.ok(ilink.sent.at(-1).text.includes('退出码 1'));
});

test('换代那一轮：不先发开工回执，第一条消息是换代提示', async () => {
  const { ilink, runner, store, router } = build();
  store.write('session.json', { [OWNER]: { sessionId: 's1', turns: 41, totalTokens: 10 } });

  const events = [];
  const realSend = ilink.sendText;
  ilink.sendText = async (args) => {
    events.push(`send:${args.text}`);
    return realSend(args);
  };
  runner.run = async ({ taskText }) => {
    events.push(taskText.includes('摘要') ? 'run:summary' : 'run:task');
    return {
      sessionId: 's2',
      finalText: '好的',
      text: '好的',
      totalTokens: 1,
      turns: 1,
      exitCode: 0,
      stderrTail: '',
      timedOut: false,
    };
  };

  try {
    await router.handle(msg('换代任务'));
    await router.idle();

    assert.ok(events.includes('run:summary'), events.join(' | '));
    const beforeSummary = events.slice(0, events.indexOf('run:summary'));
    assert.ok(
      !beforeSummary.some((e) => e.startsWith('send:')),
      `摘要跑完之前不该发任何消息：${events.join(' | ')}`,
    );
    // 换代不再发提示：摘要之后应当连一条消息都没有，直接跑任务并回答案
    const informs = events.filter((e) => e.startsWith('send:') && e.includes('换新'));
    assert.deepEqual(informs, [], `不该再有换代提示：${events.join(' | ')}`);
    const afterSummary = events.slice(events.indexOf('run:summary') + 1);
    assert.ok(afterSummary.includes('run:task'), `摘要后应直接跑任务：${events.join(' | ')}`);
  } finally {
    router.stop();
  }
});

test('陌生来源消息的告警带上期望的 owner id', async () => {
  const warns = [];
  const { router } = build({ logger: { info() {}, warn: (m) => warns.push(m), error() {} } });

  await router.handle(msg('你好', { from_user_id: 'stranger@im.wechat' }));
  await router.idle();

  assert.ok(
    warns.some((m) => m.includes('from=stranger@im.wechat') && m.includes(`expected=${OWNER}`)),
    warns.join(' | '),
  );
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

// 有界等待：条件不满足就快速失败，绝不把测试挂住
async function until(fn, label, ms = 1500) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`等待「${label}」超时`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('发送失败不会卡死队列，下一条任务照跑', async () => {
  const { ilink, runner, router } = build();
  let failing = true;
  ilink.sendText = async ({ text, toUserId, contextToken }) => {
    if (failing) throw new Error('网络断了');
    ilink.sent.push({ text, toUserId, contextToken });
    return { messageId: ilink.sent.length };
  };

  try {
    await router.handle(msg('一'));
    await until(() => runner.runs.length === 1 && router.status().current === null, '第一条任务收尾');

    failing = false;
    await router.handle(msg('二'));
    await until(() => ilink.sent.some((s) => s.text === '好的'), '第二条任务的回复');

    assert.equal(runner.runs.length, 2);
    assert.deepEqual(router.status(), { current: null, pending: 0 });
  } finally {
    router.stop();
  }
});

test('存储异常不会卡死队列，下一条任务照跑', async () => {
  const { ilink, runner, store, router } = build();
  const realRead = store.read;
  let failing = true;
  store.read = (...args) => {
    if (failing) throw new Error('磁盘满了');
    return realRead(...args);
  };

  try {
    await router.handle(msg('一'));
    await until(() => router.status().current === null, '第一条任务收尾');
    assert.equal(runner.runs.length, 0, '第一条在读取会话时就炸了，不该跑 runner');
    assert.ok(ilink.sent.some((s) => s.text.includes('磁盘满了')), '失败要回报给用户');

    failing = false;
    await router.handle(msg('二'));
    await until(() => ilink.sent.some((s) => s.text === '好的'), '第二条任务的回复');
    assert.equal(runner.runs.length, 1);
    assert.deepEqual(router.status(), { current: null, pending: 0 });
  } finally {
    router.stop();
  }
});

test('/stop 落在换代摘要期间：摘要被取消，任务不启动', async () => {
  const { ilink, runner, store, router } = build();
  store.write('session.json', { [OWNER]: { sessionId: 's1', turns: 41, totalTokens: 10 } });

  const runs = [];
  runner.run = ({ taskText, sessionId, signal }) => {
    runs.push({ taskText, sessionId, signal });
    if (runs.length > 1) {
      return Promise.resolve({
        sessionId: 's2',
        finalText: '任务不该跑',
        text: '任务不该跑',
        totalTokens: 1,
        turns: 1,
        exitCode: 0,
        stderrTail: '',
        timedOut: false,
      });
    }
    // 摘要运行：只在中止时结束
    return new Promise((resolve) => {
      const done = () =>
        resolve({ sessionId, finalText: null, text: '', totalTokens: 0, turns: 0, exitCode: 0, stderrTail: '', timedOut: true });
      if (signal?.aborted) done();
      else signal?.addEventListener('abort', done, { once: true });
    });
  };

  try {
    await router.handle(msg('换代任务'));
    await until(() => runs.length === 1, '摘要运行开始');
    assert.ok(runs[0].taskText.includes('摘要'), '第一次运行应是摘要子任务');

    await router.handle(msg('/stop'));
    await until(() => router.status().current === null && router.status().pending === 0, '中止收尾');

    assert.equal(runs.length, 1, '换代被中止后任务不应再启动');
    assert.equal(runs[0].sessionId, 's1', '摘要应跑在旧会话上');
    assert.equal(runs[0].signal?.aborted, true, '摘要运行必须收到 signal 并被中止');
    assert.ok(ilink.sent.some((s) => s.text === '已停止。'));
    assert.ok(!ilink.sent.some((s) => s.text === '任务不该跑'), '不该把任务结果发出去');
  } finally {
    router.stop();
  }
});

test('/stop 打断运行中的任务：只说已停止，不说超时', async () => {
  const { ilink, runner, router } = build();
  const runs = [];
  runner.run = ({ signal }) => {
    runs.push({ signal });
    return new Promise((resolve) => {
      const done = () =>
        resolve({ sessionId: 's1', finalText: null, text: '', totalTokens: 0, turns: 0, exitCode: 0, stderrTail: '', timedOut: true });
      if (signal?.aborted) done();
      else signal?.addEventListener('abort', done, { once: true });
    });
  };

  try {
    await router.handle(msg('跑着'));
    await until(() => runs.length === 1, '任务开始');
    await router.handle(msg('/stop'));
    await until(() => router.status().current === null, '任务收尾');

    assert.ok(ilink.sent.some((s) => s.text === '已停止。'));
    assert.ok(!ilink.sent.some((s) => s.text.includes('任务已中止')), '用户主动停止时不该说超时');
    assert.deepEqual(router.status(), { current: null, pending: 0 });
  } finally {
    router.stop();
  }
});

test('任务结束后 status 报空闲且不残留定时器', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const progressTimers = [];
  const typingTimers = new Set();

  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 45000) {
      const t = { __progress: true, fn, cleared: false };
      progressTimers.push(t);
      return t;
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  globalThis.clearTimeout = (t) => {
    if (t?.__progress) {
      t.cleared = true;
      return;
    }
    return realClearTimeout(t);
  };
  globalThis.setInterval = (fn, ms, ...rest) => {
    const h = realSetInterval(fn, ms, ...rest);
    const rec = { h, cleared: false };
    h.__rec = rec;
    typingTimers.add(rec);
    return h;
  };
  globalThis.clearInterval = (h) => {
    if (h?.__rec) h.__rec.cleared = true;
    return realClearInterval(h);
  };

  const { runner, router } = build();
  try {
    await router.handle(msg('收尾检查'));
    await until(() => runner.runs.length === 1 && router.status().current === null, '任务收尾');

    assert.deepEqual(router.status(), { current: null, pending: 0 });
    assert.equal(progressTimers.length, 1, '应建立一个 45 秒进度定时器');
    assert.equal(progressTimers[0].cleared, true, '进度定时器必须被清掉');
    assert.equal(typingTimers.size, 1, '应建立一个 typing 心跳');
    assert.ok([...typingTimers].every((r) => r.cleared), 'typing 心跳必须被清掉');
  } finally {
    router.stop();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    for (const rec of typingTimers) if (!rec.cleared) realClearInterval(rec.h);
    for (const t of progressTimers) if (!t.cleared) realClearTimeout(t);
  }
});

// ---- 入站媒体 ----

test('图片：落盘后把路径写进任务，让 DSH 自己去看', async () => {
  const mediaStore = fakeMediaStore({ kind: 'image', path: 'D:\\DHS\\.wechat-inbox\\x\\image-1.jpg', name: 'image-1.jpg', bytes: 1234 });
  const { ilink, runner, router } = build({ mediaStore });

  await router.handle(mediaMsg(2, { image_item: { media: { encrypt_query_param: 'p' } } }));
  await router.idle();

  assert.equal(mediaStore.calls.length, 1);
  assert.equal(runner.runs.length, 1);
  assert.match(runner.runs[0].taskText, /image-1\.jpg/);
  assert.match(runner.runs[0].taskText, /读图工具/);
  assert.ok(ilink.sent.some((s) => s.text.includes('好的')));
});

test('语音：把微信转写当正文，同时给出原始音频路径', async () => {
  const mediaStore = fakeMediaStore({ kind: 'voice', path: 'D:\\a\\voice-2.silk', name: 'voice-2.silk', bytes: 99, text: '下午三点到' });
  const { runner, router } = build({ mediaStore });

  await router.handle(mediaMsg(3, { voice_item: { text: '下午三点到', media: { encrypt_query_param: 'p' } } }));
  await router.idle();

  assert.match(runner.runs[0].taskText, /下午三点到/);
  assert.match(runner.runs[0].taskText, /voice-2\.silk/);
});

test('文件：任务里带文件名和路径', async () => {
  const mediaStore = fakeMediaStore({ kind: 'file', path: 'D:\\a\\预算.xlsx', name: '预算.xlsx', bytes: 2048 });
  const { runner, router } = build({ mediaStore });

  await router.handle(mediaMsg(4, { file_item: { file_name: '预算.xlsx', len: '2048', media: { encrypt_query_param: 'p' } } }));
  await router.idle();

  assert.match(runner.runs[0].taskText, /预算\.xlsx/);
  assert.match(runner.runs[0].taskText, /2048/);
});

test('视频：明确拒绝，不落盘也不跑任务', async () => {
  const mediaStore = fakeMediaStore({});
  const { ilink, runner, router } = build({ mediaStore });

  await router.handle(mediaMsg(5, { video_item: { media: { encrypt_query_param: 'p' } } }));
  await router.idle();

  assert.equal(mediaStore.calls.length, 0);
  assert.equal(runner.runs.length, 0);
  assert.match(ilink.sent[0].text, /视频暂时不支持/);
});

test('未接入 mediaStore 时给出清楚的降级提示', async () => {
  const { ilink, runner, router } = build();

  await router.handle(mediaMsg(2, { image_item: { media: { encrypt_query_param: 'p' } } }));
  await router.idle();

  assert.equal(runner.runs.length, 0);
  assert.match(ilink.sent[0].text, /未启用媒体接收/);
});

test('接收失败时告诉用户原因，且不跑任务', async () => {
  const mediaStore = fakeMediaStore(null, { throws: '超过 20 MB 上限' });
  const { ilink, runner, router } = build({ mediaStore });

  await router.handle(mediaMsg(4, { file_item: { file_name: 'big.bin', len: '999999999', media: { encrypt_query_param: 'p' } } }));
  await router.idle();

  assert.equal(runner.runs.length, 0);
  assert.match(ilink.sent[0].text, /接收文件失败/);
  assert.match(ilink.sent[0].text, /20 MB/);
});

// ---- 出站附件 ----

function fakeUploader({ throws } = {}) {
  const sent = [];
  return {
    sent,
    sendFile: async ({ toUserId, contextToken, path }) => {
      sent.push({ toUserId, contextToken, path });
      if (throws) throw new Error(throws);
      return { kind: 'file', name: 'x', bytes: 1, messageId: 1 };
    },
  };
}

test('回复里的 [[send: 路径]] 触发上传，标记不展示给用户', async () => {
  const uploader = fakeUploader();
  const { ilink, router } = build({
    uploader,
    result: { finalText: '做好了。\n[[send: D:\\out\\报告.docx]]\n还需要改吗？' },
  });

  await router.handle(msg('做个报告'));
  await router.idle();

  assert.deepEqual(uploader.sent.map((s) => s.path), ['D:\\out\\报告.docx']);
  const reply = ilink.sent.at(-1).text;
  assert.match(reply, /做好了/);
  assert.match(reply, /还需要改吗/);
  assert.ok(!reply.includes('[['), '标记不能出现在回复里');
});

test('上传失败时告诉用户原因，正文照发', async () => {
  const uploader = fakeUploader({ throws: '超过 20 MB 上限' });
  const { ilink, router } = build({
    uploader,
    result: { finalText: '好了。[[send: D:\\big.bin]]' },
  });

  await router.handle(msg('发个大文件'));
  await router.idle();

  const reply = ilink.sent.at(-1).text;
  assert.match(reply, /发送附件失败/);
  assert.match(reply, /20 MB/);
  assert.match(reply, /好了/);
});

test('没有 uploader 时提示出站未启用，且不把标记漏给用户', async () => {
  const { ilink, router } = build({ result: { finalText: '完成。[[send: D:\\a.txt]]' } });

  await router.handle(msg('发个文件'));
  await router.idle();

  const reply = ilink.sent.at(-1).text;
  assert.match(reply, /出站未启用/);
  assert.ok(!reply.includes('[['));
});

test('只发文件不写字时，补一句“已发出”而不是空消息', async () => {
  const uploader = fakeUploader();
  const { ilink, router } = build({ uploader, result: { finalText: '[[send: D:\\a.txt]]' } });

  await router.handle(msg('发一下'));
  await router.idle();

  assert.match(ilink.sent.at(-1).text, /已发出 1 个文件/);
});

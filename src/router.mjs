import { chunkText } from './chunk.mjs';
import { mediaKind } from './media.mjs';
import { parseSendMarkers } from './upload.mjs';

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

/**
 * 比 extractText 更细：把媒体消息也识别出来，交给 media store 落盘。
 * text 之外的类型不在这里转成任务文案，由 buildMediaTask 负责。
 */
export function describeItem(msg) {
  const item = msg?.item_list?.[0];
  if (item?.type === 1 && typeof item.text_item?.text === 'string') {
    return { kind: 'text', text: item.text_item.text };
  }
  const kind = mediaKind(item);
  if (kind) return { kind, item };
  return { kind: 'unsupported', itemType: item?.type ?? null };
}

const KIND_LABEL = { image: '图片', voice: '语音', file: '文件', video: '视频' };

export function buildMediaTask({ kind, path, name, bytes, text }) {
  if (kind === 'image') {
    return `用户发来一张图片，已保存到 ${path}（${bytes} 字节）。请先用读图工具查看这张图片，再判断用户想要什么；如果看不出意图，就问一句。`;
  }
  if (kind === 'voice') {
    const said = text ? `"${text}"` : '（微信没有给出转写）';
    return `用户发来语音消息，微信自动转写为：${said}。原始音频已保存到 ${path}。请按这句话的内容处理。`;
  }
  return `用户发来文件 ${name}，已保存到 ${path}（${bytes} 字节）。请按需读取后再处理。`;
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
  mediaStore,
  uploader,
  preamble = DEFAULT_PREAMBLE,
  limits = { queue: 5, timeoutMs: 30 * 60 * 1000 },
} = {}) {
  const deduper = createDeduper({ size: 200 });
  const queue = [];
  let current = null;
  let running = false;

  const saveSession = (userId, patch) => {
    const all = store.read('session.json', {});
    all[userId] = { ...(all[userId] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    store.write('session.json', all);
    return all[userId];
  };

  const currentSession = (userId) => store.read('session.json', {})[userId] ?? null;

  // 出站消息一律 best-effort：ilink.sendText 在网络/鉴权/服务端错误时会 reject，
  // 一次发送失败不该让定时器泄漏、任务卡死或把宿主进程拖挂。
  async function safeSend(userId, contextToken, text) {
    try {
      for (const piece of chunkText(text)) {
        await ilink.sendText({ toUserId: userId, contextToken, text: piece });
      }
      return true;
    } catch (e) {
      logger?.warn?.(`发送微信消息失败: ${e.message}`);
      return false;
    }
  }

  async function runTask({ text, userId, contextToken }) {
    // current / AbortController 必须在最前面就绪：换代摘要期间也要能被 /stop 中止，
    // 也要让 /status 如实显示"执行中"。
    current = { userId, startedAt: Date.now() };
    const ac = new AbortController();
    current.abort = () => ac.abort();

    // 不再发开工回执：用户嫌每条回答前都多一句。等模型出结果，中途靠「正在输入」兜着。
    let typingTimer = null;
    let progressTimer = null;

    try {
      const roll = await maybeRollover({
        runner,
        store,
        userId,
        logger,
        signal: ac.signal,
        limits: { maxTokens: 400000, maxTurns: 40 },
      });
      if (ac.signal.aborted) return; // 用户已 /stop，别再往下走
      // 换代只记日志，不再给用户发提示：多一条消息反而打断对话
      if (roll.rolled) {
        logger?.info?.(`会话已换代，摘要${roll.summary ? '已生成' : '生成失败'}`);
      }

      const session = currentSession(userId);
      const prefix = session?.summary ? `（前情提要：${session.summary}）\n\n` : '';
      const taskText = `${prefix}${preamble}${text}`;

      typingTimer = setInterval(() => {
        void ilink.sendTyping({ toUserId: userId, contextToken, status: 1 }).catch(() => {});
      }, 5000);
      void ilink.sendTyping({ toUserId: userId, contextToken, status: 1 }).catch(() => {});

      // 45 秒还没出结果时推一条轻进度，每次任务最多一条
      progressTimer = setTimeout(() => {
        void safeSend(userId, contextToken, '还在处理，稍等…');
      }, 45000);

      const out = await runner.run({
        taskText,
        sessionId: session?.sessionId,
        signal: ac.signal,
      });

      const failed = out.exitCode !== 0;
      const sessionLost = failed && isSessionLost(out.stderrTail, session?.sessionId);

      if (sessionLost) {
        // 旧 session 在 dsh 那边已经不存在了（换过工作区、或会话被清掉）。
        // 不清掉的话后续每个任务都会拿这个死 id 重试，直到用户发 /new 为止。
        // turns / totalTokens / summary 都保留。
        saveSession(userId, { sessionId: null });
        logger?.warn?.(`会话 ${session?.sessionId ?? ''} 在 dsh 侧已不存在，已清除 sessionId`);
      } else if (out.sessionId) {
        saveSession(userId, {
          sessionId: out.sessionId,
          // 失败的运行不算一轮对话，但 token 是真的花掉了，照记
          turns: (session?.turns ?? 0) + (failed ? 0 : out.turns || 1),
          totalTokens: (session?.totalTokens ?? 0) + (out.totalTokens ?? 0),
        });
      }

      if (out.timedOut) {
        // 用户主动 /stop 时已经回过"已停止。"，别再补一句自相矛盾的"超时"
        if (!current?.stoppedByUser) await safeSend(userId, contextToken, '任务已中止（超时或被 /stop 打断）。');
        return;
      }

      // 空则用累积 text：finalText 可能是空串，用 ?? 会让空串"赢"过累积文本
      const answer = (out.finalText || out.text || '').trim();

      // 出站附件：模型在回复里写 `[[send: 路径]]`，由桥上传发送，标记本身不展示给用户。
      const { text: cleaned, paths } = parseSendMarkers(answer);
      let sentFiles = 0;
      let fileNote = '';
      for (const p of paths) {
        if (!uploader) {
          fileNote = '\n\n（收到发送附件的请求，但出站未启用。）';
          break;
        }
        try {
          await uploader.sendFile({ toUserId: userId, contextToken, path: p });
          sentFiles += 1;
        } catch (e) {
          fileNote += `\n\n发送附件失败：${e.message}`;
        }
      }

      if (failed) {
        // 非零退出必须把退出码和 stderr 尾部一起发出去，哪怕模型已经吐了半截回答：
        // 半截回答看着和"成功"没区别，不标出来用户会以为任务做完了
        const tail = (out.stderrTail || '').trim().slice(-800);
        const parts = [];
        if (sessionLost) parts.push('原会话已失效（可能换了工作区），已重置，下一条消息会开新会话。');
        if (cleaned) parts.push(cleaned);
        parts.push(`任务失败（退出码 ${out.exitCode}）。${tail ? `\n\n${tail}` : ''}`);
        await safeSend(userId, contextToken, parts.join('\n\n') + fileNote);
        return;
      }

      let body = cleaned;
      if (!body && (sentFiles > 0 || paths.length > 0)) body = `已发出 ${sentFiles} 个文件。`;
      await safeSend(userId, contextToken, (body || '任务结束，没有输出。') + fileNote);
    } catch (e) {
      if (ac.signal.aborted) {
        if (!current?.stoppedByUser) await safeSend(userId, contextToken, '已停止。');
      } else {
        logger?.error(`任务执行异常: ${e.message}`);
        await safeSend(userId, contextToken, `出错了：${e.message}`);
      }
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      if (progressTimer) clearTimeout(progressTimer);
      typingTimer = null;
      void ilink.sendTyping({ toUserId: userId, contextToken, status: 2 }).catch(() => {});
      current = null;
    }
  }

  async function worker() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        // 单条任务炸了不能带走整个队列
        try {
          await runTask(job);
        } catch (e) {
          logger?.error(`任务执行异常: ${e.message}`);
        }
      }
    } finally {
      running = false;
    }
  }

  async function handle(msg) {
    if (msg?.message_type !== 1) return;
    if (msg.from_user_id !== ownerId) {
      // 不匹配就意味着"用户发什么都没反应"，只留一行日志当唯一线索，所以把期望值也打出来
      logger?.warn(`忽略陌生来源消息 from=${msg.from_user_id} expected=${ownerId}`);
      return;
    }
    if (msg.message_id !== undefined && deduper.seen(msg.message_id)) return;

    const described = describeItem(msg);
    const contextToken = msg.context_token;

    if (described.kind === 'unsupported') {
      await safeSend(msg.from_user_id, contextToken, '目前只支持文字、图片、语音和文件消息。');
      return;
    }
    if (described.kind === 'video') {
      await safeSend(msg.from_user_id, contextToken, '视频暂时不支持；发文字、图片、语音或文件都可以。');
      return;
    }

    if (described.kind === 'text') {
      const cmd = parseCommand(described.text);
      if (cmd) {
        await handleCommand(cmd, msg.from_user_id, contextToken);
        return;
      }
    }

    if (queue.length >= limits.queue) {
      await safeSend(msg.from_user_id, contextToken, `还在忙，已排队 ${limits.queue} 条，多的先不收了。`);
      return;
    }

    let taskText;
    if (described.kind === 'text') {
      taskText = described.text;
    } else {
      const label = KIND_LABEL[described.kind] ?? '附件';
      if (!mediaStore) {
        await safeSend(msg.from_user_id, contextToken, `收到${label}，但当前未启用媒体接收，只支持文字消息。`);
        return;
      }
      // 下载解密在轮询循环里同步等待：单个文件最多几十秒，期间新消息会排在下一次
      // getupdates 之后；对单用户场景够用，不为它引入额外的并发层。
      let saved;
      try {
        saved = await mediaStore.saveInbound({ item: described.item, messageId: msg.message_id });
      } catch (e) {
        await safeSend(msg.from_user_id, contextToken, `接收${label}失败：${e.message}`);
        return;
      }
      taskText = buildMediaTask(saved);
    }

    queue.push({ text: taskText, userId: msg.from_user_id, contextToken });
    void worker().catch((e) => logger?.error(`队列执行异常: ${e.message}`));
  }

  async function handleCommand(cmd, userId, contextToken) {
    switch (cmd.name) {
      case 'stop':
        stop();
        await safeSend(userId, contextToken, '已停止。');
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
        await safeSend(userId, contextToken, lines.join('\n'));
        break;
      }
      case 'new':
        saveSession(userId, { sessionId: null, turns: 0, totalTokens: 0, summary: null });
        await safeSend(userId, contextToken, '已换新会话，之前的上下文不再带过去。');
        break;
      case 'help':
      default:
        await safeSend(userId, contextToken, HELP);
        break;
    }
  }

  function stop() {
    queue.length = 0;
    if (current) {
      current.stoppedByUser = true;
      current.abort?.();
    }
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

// 两种真实报错（本机 dsh 实测）：
//   dsh: session "…" does not exist; omit --session-id to start a new Session  → 会话不存在
//   dsh: session "…" was recorded in "A", not "B"                             → 会话属于别的工作区
// 只匹配这两种特有措辞，别的失败（模型报错、超时）不能被误判成会话失效。
const SESSION_LOST_RE =
  /session\b[^\n]{0,200}does not exist|session\b[^\n]{0,200}was recorded in[^\n]{0,400}\bnot\b/i;

// 光靠措辞不够：`Error: config session dir C:\x does not exist` 或
// `warn: session store does not exist yet, creating` 也会命中上面第一条。
// 所以还要求 stderr 里真的出现本轮用的那个 session id——没带 --session-id 的运行谈不上"会话失效"。
function isSessionLost(stderrTail, sessionId) {
  if (!sessionId) return false;
  if (typeof stderrTail !== 'string' || !stderrTail.includes(sessionId)) return false;
  return SESSION_LOST_RE.test(stderrTail);
}

const SUMMARY_PROMPT =
  '把目前为止的关键信息、结论和未完成事项压成 300 字以内的中文摘要，供下一个会话接手使用。只输出摘要本身。';

export async function maybeRollover({
  runner,
  store,
  userId,
  logger,
  signal,
  limits = { maxTokens: 400000, maxTurns: 40 },
} = {}) {
  const all = store.read('session.json', {});
  const session = all[userId];
  if (!session?.sessionId) return { rolled: false, summary: null };

  const overTokens = (session.totalTokens ?? 0) > limits.maxTokens;
  const overTurns = (session.turns ?? 0) > limits.maxTurns;
  if (!overTokens && !overTurns) return { rolled: false, summary: null };

  let summary = null;
  try {
    const out = await runner.run({ taskText: SUMMARY_PROMPT, sessionId: session.sessionId, signal });
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

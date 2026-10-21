// src/main.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { createLogger } from './log.mjs';
import { createIlink } from './ilink.mjs';
import { createRunner } from './dsh.mjs';
import { createRouter } from './router.mjs';
import { createMediaStore, pruneInbox } from './media.mjs';
import { createUploader } from './upload.mjs';
import { acquireLock } from './lock.mjs';
import { renderQr } from './qr.mjs';

const STATE_DIR = join(homedir(), '.wechat-bridge');
const WORKSPACE = process.env.BRIDGE_WORKSPACE || 'D:\\DHS';
const CHANNEL_VERSION = '1.0.0';
const QR_PNG = join(STATE_DIR, 'qr.png');
// 收尾等待必须严格大于 dsh.mjs 的 killGraceMs（10s）：子进程忽略 taskkill 时，
// runner 要等宽限计时器到点才把那一轮判成超时收尾。窗口比它短，收尾会先放弃——
// 重登会在旧子进程还活着时换 router，退出也会在宽限烧完前就 process.exit(0)。
const SETTLE_MS = 12000;

// logger 必须先建：store 的「状态文件损坏」告警要靠它才发得出来
const logger = createLogger({ dir: join(STATE_DIR, 'logs') });
const store = createStore(STATE_DIR, { logger });
const runner = createRunner({ workspace: WORKSPACE, logger });

// 入站媒体落在工作区内，方便 DSH 直接读；按天分目录，保留 7 天后自动清理。
const INBOX_DIR = join(WORKSPACE, '.wechat-inbox');
const INBOX_KEEP_DAYS = 7;
const mediaStore = createMediaStore({ dir: INBOX_DIR, logger });
pruneInbox(INBOX_DIR, { days: INBOX_KEEP_DAYS, logger });
setInterval(() => pruneInbox(INBOX_DIR, { days: INBOX_KEEP_DAYS, logger }), 24 * 60 * 60 * 1000).unref();

let ilink;
let router = null;
let stopped = false;
let bridgeLock = null;
const shutdown = new AbortController();

const makeIlink = (creds) => createIlink({ creds, logger, channelVersion: CHANNEL_VERSION });

// router 在构造时就把 ilink 实例和 ownerId 抓走了。换凭证时必须连 router 一起重建，
// 否则新 token 只活在新 client 里，发送仍走旧的 ilink 和旧的 ownerId。
const makeRouter = (client, creds) =>
  createRouter({
    ilink: client,
    runner,
    store,
    logger,
    ownerId: creds.userId,
    workspace: WORKSPACE,
    mediaStore,
    // 上传必须跟着当前 client 走：重新登录会换 ilink 实例，旧实例的 token 已经无效
    uploader: createUploader({ ilink: client, logger }),
  });

// 退避等待也要能被 Ctrl-C 立刻打断，否则 30s 的退避期间按 Ctrl-C 看着像卡死
function waitAbortable(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

// 给在跑的任务一个上限；超时返回 false，由调用方决定强制退出
function idleWithin(idlePromise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([idlePromise.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

// 登录失败不该带走守护进程：网络/服务端错误退避重试，Ctrl-C 干净退出，
// 只有不可重试的（鉴权失败、未知异常）才交给 fatal 路径。
const RETRYABLE_LOGIN_KINDS = new Set(['network', 'server']);

async function loginWithRetry(phase) {
  for (let attempt = 1; ; attempt += 1) {
    if (shutdown.signal.aborted) {
      logger.info(`${phase}被停止信号打断，桥退出`);
      return null;
    }
    try {
      return await ensureCreds();
    } catch (e) {
      if (shutdown.signal.aborted || e?.kind === 'aborted') {
        logger.info(`${phase}被停止信号打断，桥退出`);
        return null;
      }
      if (!RETRYABLE_LOGIN_KINDS.has(e?.kind)) {
        logger.error(`${phase}遇到不可重试的错误(kind=${e?.kind ?? e?.name ?? 'unknown'})：${e.message}`);
        throw e;
      }
      const waitMs = attempt >= 3 ? 30000 : 2000;
      logger.error(`${phase}失败(${attempt}): ${e.message}；${waitMs}ms 后重试`);
      await waitAbortable(waitMs, shutdown.signal);
    }
  }
}

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
  // 单实例锁必须在最前面：两个桥会抢同一个 getupdates 游标，导致重复回复或丢消息。
  // 退出码 3 是「已有实例」，start.cmd 见到它会等 60 秒再重试，避免 5 秒一次地空转。
  try {
    bridgeLock = acquireLock(STATE_DIR);
  } catch (e) {
    if (e.code === 'already-running') {
      logger.error(`已有实例在运行 pid=${e.pid}，本进程退出`);
      process.exit(3);
    }
    throw e;
  }

  logger.info(`桥启动 workspace=${WORKSPACE} state=${STATE_DIR}`);
  ilink = makeIlink(null);

  let creds = store.read('creds.json', null);
  if (!creds?.token) {
    creds = await loginWithRetry('启动登录');
    if (!creds) return;
  } else {
    logger.info(`已加载凭证 bot=${creds.accountId}`);
  }
  ilink = makeIlink(creds);

  router = makeRouter(ilink, creds);

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

      // 401/403（auth）和 -14（session-expired）是同一件事：token 已经不能用了，
      // 重扫码是唯一出路。以前 auth 会掉进通用退避里每 30 秒空转，永远好不了。
      if (e.kind === 'session-expired' || e.kind === 'auth') {
        logger.warn(`${e.kind === 'auth' ? '鉴权被拒' : 'session 过期'}，清除凭证并重新扫码`);
        store.write('creds.json', null);
        store.write('cursor.json', {});

        // 旧 router 可能还有任务在跑（队列、子进程、还没发出去的回复）。必须先 stop 并等它
        // 有界收尾，再换新 router：否则旧任务的子进程没人 abort，回复会发在已失效的 token 上，
        // 而退出时的有界等待只看新 router，可能留下活着的 cmd.exe/dsh 树。
        const old = router;
        router = null;
        if (old) {
          try {
            old.stop();
          } catch (err) {
            logger.error(`停止旧 router 时出错: ${err.message}`);
          }
          if (!(await idleWithin(old.idle(), SETTLE_MS))) {
            logger.warn(`重新登录前旧任务 ${SETTLE_MS}ms 内没收尾（子进程可能忽略 kill），继续重登`);
          }
        }

        creds = await loginWithRetry('重新登录');
        if (!creds) break;
        ilink = makeIlink(creds);
        router = makeRouter(ilink, creds);
        ilink.cursor = '';
        continue;
      }

      failures += 1;
      const waitMs = failures >= 3 ? 30000 : 2000;
      logger.error(`轮询失败(${failures}): ${e.message}；${waitMs}ms 后重试`);
      await waitAbortable(waitMs, shutdown.signal);
    }
  }

  // Ctrl-C 之后不能马上把「桥已退出」打出去：在跑的任务可能还攥着 dsh 子进程。
  // 用有限等待收尾，超时就走人并说明原因（不能让宿主吊到 30 分钟超时）。
  // 正在重新登录时 router 是 null（旧 router 已经收尾完毕），没有要等的东西。
  const settled = router ? await idleWithin(router.idle(), SETTLE_MS) : true;
  logger.info('桥已退出');
  if (!settled) {
    logger.warn(`在跑任务 ${SETTLE_MS}ms 内没收尾（子进程可能忽略 kill），强制退出`);
    process.exit(0);
  }
}

function requestShutdown() {
  if (stopped) {
    logger.warn('已经在退出中，忽略重复的停止信号');
    return;
  }
  stopped = true;
  // router.stop() 清队列并 abort 在跑任务：dsh 子进程会被 kill，
  // 不会攥着 stdio 把宿主拖到 30 分钟超时
  try {
    router?.stop();
  } catch (e) {
    logger.error(`停止任务时出错: ${e.message}`);
  }
  shutdown.abort();
}

process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);
process.on('exit', () => bridgeLock?.release());
process.on('unhandledRejection', (e) => logger.error(`未处理的 Promise 拒绝: ${e?.message ?? e}`));

main().catch((e) => {
  logger.error(`致命错误: ${e.stack ?? e.message}`);
  process.exit(1);
});

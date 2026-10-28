// src/dsh.mjs
import { spawn } from 'node:child_process';
import { buildChildEnv } from './credentials.mjs';

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
  killGraceMs = 10000,
} = {}) {
  const launcher = dshBin ? { bin: dshBin, prefix: dshArgsPrefix ?? [] } : resolveLauncher();

  async function run({ taskText, sessionId, onEvent, signal } = {}) {
    const args = [...launcher.prefix, '--profile', profile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-');

    const acc = createAccumulator();
    let stderrTail = '';
    let timedOut = false;

    // DSH 44.7 起 headless 不再从凭证库自取 key，必须由调用方透传（见 credentials.mjs）
    const { env: childEnv, hasKey } = buildChildEnv();
    if (!hasKey) logger?.warn?.('没有找到 DEEPSEEK_API_KEY（环境变量与 DSH 凭证库都没有），任务大概率会 MISSING_CREDENTIAL');

    const child = spawnImpl(launcher.bin, args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv,
    });

    // 必须立刻挂 error 监听：启动失败时 Node 会把 'error' 当未捕获事件，直接杀死宿主进程
    const launchErrors = [];
    child.on('error', (e) => launchErrors.push(e));

    if (!child.pid) {
      // Node 的 'error' 是异步派发的，等一拍才拿得到真实原因（ENOENT 等）
      await new Promise((resolve) => setImmediate(resolve));
      const reason = launchErrors[0]?.message ?? `无法启动 ${launcher.bin}`;
      throw new Error(`DSH 进程启动失败: ${reason}`);
    }

    let buf = '';
    // onEvent 是消费者提供的（将来是发消息的路径），它抛异常不能带走整个守护进程
    const emit = (ev) => {
      if (!ev || ev.type === 'unparsed') return;
      try {
        onEvent?.(ev);
      } catch (e) {
        logger?.warn?.(`onEvent 回调抛错，已跳过该事件: ${e?.message ?? e}`);
      }
    };

    const feed = (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const ev = acc.push(line);
        if (ev?.type === 'unparsed') logger?.warn?.(`跳过无法解析的行: ${ev.raw.slice(0, 120)}`);
        else emit(ev);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', feed);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-STDERR_KEEP);
    });

    // 先挂 close 监听再接线 kill：已 abort 的 signal 会立刻 kill，
    // 而 killTree 可能同步 emit 'close'，监听挂晚了就没人接得住
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    let settled = false;
    let graceTimer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
      resolveClosed(code);
    };
    child.on('close', (code) => finish(code ?? -1));

    const kill = () => {
      timedOut = true;
      Promise.resolve(killTree(child.pid)).catch(() => {});
      // killTree 返回不等于进程真的死了（taskkill 失败、cmd.exe 不理都算）。'close' 一直不来时，
      // 唯一的 worker 会被永久占住：30 分钟计时器已经烧掉了，不会再有东西来叫醒它。
      // 所以 kill 之后再给一个宽限上限，到点按超时收尾。
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => {
        logger?.warn?.(`kill 后 ${killGraceMs}ms 子进程仍未退出，按超时收尾`);
        finish(-1);
      }, killGraceMs);
    };

    const timer = setTimeout(kill, timeoutMs);

    const onAbort = () => kill();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    child.stdin.on('error', () => {});
    child.stdin.end(taskText ?? '');

    const exitCode = await closed;

    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    signal?.removeEventListener('abort', onAbort);

    // 没有换行结尾的残留片段也要计入
    if (buf.trim()) emit(acc.push(buf));

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

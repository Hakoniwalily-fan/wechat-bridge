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
  // 日志绝不允许抛：磁盘满、状态目录被删、权限不足都只降级成"仅控制台"。
  // 一旦抛出去，safeSend 的 catch 会再记一次日志 → 再抛 → 未捕获拒绝/未捕获异常，守护进程直接死。
  let logDir = dir ?? null;
  if (logDir) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      logDir = null;
    }
  }

  const write = (level, msg) => {
    const line = `${now().toISOString()} ${level} ${redact(msg)}`;
    if (logDir) {
      try {
        appendFileSync(join(logDir, `bridge-${now().toISOString().slice(0, 10)}.log`), line + '\n');
      } catch {
        /* 落盘失败就只写控制台 */
      }
    }
    (level === 'ERROR' ? console.error : console.log)(line);
  };

  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

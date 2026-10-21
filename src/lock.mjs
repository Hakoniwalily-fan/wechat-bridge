// 单实例锁：防止出现两个桥同时在跑。
//
// 为什么需要：桥是长轮询 + 单一队列，两个实例会抢同一个 getupdates 游标，
// 表现为重复回复或消息丢失。而计划任务的 "忽略新实例" 只看任务实例本身——
// 一旦 supervisor(cmd) 被留在任务之外（例如 Stop-ScheduledTask 只杀了外层的
// wscript），它就会继续拉起 node，同时新任务又起一套。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 表示进程存在但属于别人，同样算活着
    return e.code === 'EPERM';
  }
}

export function acquireLock(dir, { name = 'bridge.lock', self = process.pid } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);

  if (existsSync(file)) {
    const holder = Number(String(readFileSync(file, 'utf8')).trim());
    if (holder !== self && isAlive(holder)) {
      const e = new Error(`已有实例在运行 pid=${holder}`);
      e.code = 'already-running';
      e.pid = holder;
      throw e;
    }
  }

  writeFileSync(file, String(self), 'utf8');

  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      try {
        if (String(readFileSync(file, 'utf8')).trim() === String(self)) unlinkSync(file);
      } catch {
        /* 文件已被删或已属于别人：不动它 */
      }
    },
  };
}

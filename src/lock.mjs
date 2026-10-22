// 单实例锁：防止出现两个桥同时在跑。
//
// 为什么需要：桥是长轮询 + 单一队列，两个实例会抢同一个 getupdates 游标，
// 表现为重复回复或消息丢失。而计划任务的 "忽略新实例" 只看任务实例本身——
// 一旦 supervisor(cmd) 被留在任务之外（例如 Stop-ScheduledTask 只杀了外层的
// wscript），它就会继续拉起 node，同时新任务又起一套。
//
// 为什么光有 pid 不够：机器重启后锁文件还在，而那个 pid 可能被**别的进程复用**。
// 此时 process.kill(pid, 0) 会成功，看起来"实例还活着"，于是每个新桥都拒绝启动、
// 永远起不来（2026-10-22 实测踩到）。所以锁里同时记录本次开机的 bootStamp，
// 开机时间对不上就说明是上一个开机周期的遗留，直接接管。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

/** 本次开机的近似时间戳（秒）。同一开机周期内稳定，重启后必然变化。 */
export function bootStamp(now = Date.now(), up = uptime()) {
  return Math.round((now - up * 1000) / 1000);
}

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

function readLockFile(file) {
  const raw = String(readFileSync(file, 'utf8')).trim();
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    // 纯数字既是旧格式，也是合法 JSON，必须显式认出来
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return { pid: o, boot: null };
    if (o && typeof o === 'object' && Number.isFinite(o.pid)) {
      return { pid: o.pid, boot: Number.isFinite(o.boot) ? o.boot : null };
    }
    return null;
  } catch {
    // 旧格式：纯数字 pid。没有 boot 信息，只能靠存活判断。
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? { pid: n, boot: null } : null;
  }
}

export function acquireLock(dir, { name = 'bridge.lock', self = process.pid, boot = bootStamp() } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);

  if (existsSync(file)) {
    let holder = null;
    try {
      holder = readLockFile(file);
    } catch {
      holder = null;
    }

    if (holder && holder.pid !== self) {
      const sameBoot = holder.boot === null ? null : holder.boot === boot;
      if (sameBoot === true && isAlive(holder.pid)) {
        const e = new Error(`已有实例在运行 pid=${holder.pid}`);
        e.code = 'already-running';
        e.pid = holder.pid;
        throw e;
      }
      if (sameBoot === null && isAlive(holder.pid)) {
        // 旧格式且 pid 存活：无法区分"真在跑"和"pid 被复用"，保守拒绝。
        // 升级后不会再写出这种格式；遇到就手动删 bridge.lock。
        const e = new Error(`锁是旧格式且 pid=${holder.pid} 存活，无法判断是否残留；确认无进程后删除 lock 文件`);
        e.code = 'ambiguous-lock';
        e.pid = holder.pid;
        throw e;
      }
      // 其余情况（boot 不同、或 pid 已死）都视为遗留，接管
    }
  }

  writeFileSync(file, JSON.stringify({ pid: self, boot, at: new Date().toISOString() }), 'utf8');

  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      try {
        const holder = readLockFile(file);
        if (holder && holder.pid === self) unlinkSync(file);
      } catch {
        /* 文件已被删：不动它 */
      }
    },
  };
}

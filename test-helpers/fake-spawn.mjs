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

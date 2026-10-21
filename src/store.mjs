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
        logger?.warn?.(`状态文件损坏，已回退默认值: ${name} (${e.name})`);
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

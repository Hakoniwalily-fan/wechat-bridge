// headless 子进程的凭证解析。
//
// 背景（2026-10-28 实测）：DSH 更新到 44.7.0 之后，桌面/网页端走的是 OAuth grant，
// 但 `dsh --profile headless` 不再从 .credentials.yaml 里自动取 key，直接报
//   MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
// 同一台机器上凭证其实是好的（refs.DEEPSEEK_API_KEY 是 sk- 开头的真实 key），
// 所以桥在启动子进程时把它读出来透过去即可，不复制、不落盘、不写进仓库。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.dsh', '.credentials.yaml');

const KEY_LINE = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m;

/**
 * 解析要传给 dsh 子进程的 API key。
 * 优先环境变量（用户自己 export 的），其次 DSH 凭证库里的 refs.DEEPSEEK_API_KEY。
 * 返回 null 表示两处都没有。
 */
export function resolveApiKey({ env = process.env, storePath = DEFAULT_CREDENTIALS_PATH, readFile = readFileSync } = {}) {
  const fromEnv = env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();

  let text;
  try {
    text = String(readFile(storePath, 'utf8'));
  } catch {
    return null;
  }
  const m = KEY_LINE.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * 给 dsh 子进程用的环境：继承当前环境，固定权限档位，需要时补上 API key。
 */
export function buildChildEnv({ base = process.env, ...opts } = {}) {
  const env = { ...base, DSH_PERMISSION_MODE: 'danger-full-access' };
  const key = resolveApiKey({ env: base, ...opts });
  if (key) env.DEEPSEEK_API_KEY = key;
  return { env, hasKey: Boolean(key) };
}

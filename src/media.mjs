// 入站媒体：把微信 CDN 上的加密引用变成磁盘上的普通文件。
//
// 协议要点（来自 iLink 文档与实测）：
// - 媒体是 AES-128-ECB + PKCS7 加密后放在 https://novac2c.cdn.weixin.qq.com/c2c
// - 下载：GET /c2c/download?encrypted_query_param=<urlencode>
// - aes_key 有三种写法，必须都兼容（见 decodeAesKey）
// - 图片可能额外带 image_item.aeskey（32 个 hex 字符），优先级更高
import { createDecipheriv } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const ITEM_FIELD = {
  image: 'image_item',
  voice: 'voice_item',
  file: 'file_item',
  video: 'video_item',
};

export function mediaKind(item) {
  switch (item?.type) {
    case 2:
      return 'image';
    case 3:
      return 'voice';
    case 4:
      return 'file';
    case 5:
      return 'video';
    default:
      return null;
  }
}

/**
 * aes_key 的三种编码都要认：
 *   A. base64(16 字节原始密钥)        —— 解码后长度 16
 *   B. base64(32 个 hex 字符的 ASCII) —— 解码后长度 32 且内容是 hex
 *   C. 直接的 32 个 hex 字符           —— 图片的 image_item.aeskey 就是这种
 * 优先级：显式 hex 字段 > media.aes_key。
 */
export function decodeAesKey(media, hexKey) {
  if (typeof hexKey === 'string' && /^[0-9a-fA-F]{32}$/.test(hexKey)) {
    return Buffer.from(hexKey, 'hex');
  }

  const b64 = media?.aes_key;
  if (typeof b64 !== 'string' || !b64) throw new Error('媒体缺少 aes_key');

  const raw = Buffer.from(b64, 'base64');
  if (raw.length === 16) return raw;
  if (raw.length === 32) {
    const ascii = raw.toString('latin1');
    if (/^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex');
  }
  throw new Error(`无法识别的 aes_key（解码后 ${raw.length} 字节）`);
}

export function decryptEcb(ciphertext, key) {
  const d = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/**
 * 微信传来的文件名是不可信输入：只取 basename、去掉路径分隔符与 Windows 非法字符，
 * 并剥掉开头的点，避免 `..` 或隐藏文件把内容写到工作区外面。
 */
export function safeFileName(name, fallback = 'attachment') {
  const raw = basename(String(name ?? '').replace(/\\/g, '/'));
  const cleaned = raw
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const out = cleaned || fallback;
  return out.slice(0, 120);
}

export function guessExt(buf) {
  if (!buf || buf.length < 4) return 'bin';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return 'bin';
}

/**
 * 清掉超过保留期的入站媒体，并顺手删除已经空了的日期目录。
 * 只删 dir 之下、且 mtime 早于 days 天的**文件**；不跟目录层级较劲。
 */
export function pruneInbox(dir, { days = 7, now = () => new Date(), logger } = {}) {
  if (!dir) return { removed: 0, dirs: 0 };
  let dayDirs;
  try {
    dayDirs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { removed: 0, dirs: 0 };
  }

  const cutoff = now().getTime() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let dirs = 0;

  for (const dayDir of dayDirs) {
    const path = join(dir, dayDir.name);
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    let kept = 0;
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        kept += 1;
        continue;
      }
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) {
        try {
          rmSync(file, { force: true });
          removed += 1;
        } catch (e) {
          logger?.warn?.(`清理失败 ${entry.name}: ${e.message}`);
          kept += 1;
        }
      } else {
        kept += 1;
      }
    }
    if (kept === 0) {
      try {
        rmSync(path, { recursive: true, force: true });
        dirs += 1;
      } catch {
        /* 目录删不掉就算了 */
      }
    }
  }

  if (removed || dirs) logger?.info?.(`清理入站媒体：删除 ${removed} 个文件、${dirs} 个空目录`);
  return { removed, dirs };
}

export function createMediaStore({  dir,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = globalThis.fetch,
  logger,
  now = () => new Date(),
  timeoutMs = 60000,
} = {}) {
  if (!dir) throw new Error('createMediaStore 需要 dir');

  const dayDir = () => {
    const d = now();
    const stamp = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    return join(dir, stamp);
  };

  return {
    async saveInbound({ item, messageId }) {
      const kind = mediaKind(item);
      if (!kind) throw new Error('不是媒体消息');

      const sub = item[ITEM_FIELD[kind]];
      const media = sub?.media;
      if (!media?.encrypt_query_param) throw new Error('媒体缺少 CDN 引用');

      const declared = Number(sub?.mid_size ?? sub?.len ?? sub?.video_size ?? 0) || 0;
      const oversize = () => {
        const e = new Error(`超过 ${Math.round(maxBytes / 1048576)} MB 上限`);
        e.code = 'too-large';
        return e;
      };
      if (declared > maxBytes) throw oversize();

      const url = `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
      let res;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new Error(`下载失败：${e.name === 'TimeoutError' ? '超时' : e.message}`);
      }
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

      const cipher = Buffer.from(await res.arrayBuffer());
      if (cipher.length > maxBytes + 64) throw oversize();

      const key = decodeAesKey(media, sub?.aeskey);
      let plain;
      try {
        plain = decryptEcb(cipher, key);
      } catch {
        throw new Error('解密失败（key 或数据不匹配）');
      }

      let name;
      if (kind === 'file') {
        name = safeFileName(sub.file_name, `file-${messageId ?? Date.now()}`);
      } else if (kind === 'image') {
        name = `image-${messageId ?? Date.now()}.${guessExt(plain)}`;
      } else if (kind === 'voice') {
        name = `voice-${messageId ?? Date.now()}.silk`;
      } else {
        name = `video-${messageId ?? Date.now()}.${guessExt(plain) === 'bin' ? 'mp4' : guessExt(plain)}`;
      }

      const targetDir = dayDir();
      mkdirSync(targetDir, { recursive: true });
      const path = join(targetDir, name);
      writeFileSync(path, plain);

      logger?.info?.(`已接收${kind} ${plain.length} 字节 -> ${name}`);
      return { kind, path, name, bytes: plain.length, text: sub?.text ?? null };
    },
  };
}

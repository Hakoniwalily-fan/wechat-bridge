// 出站媒体：把本地文件加密后上传到微信 CDN，再作为消息发给用户。
//
// 协议顺序（来自 iLink 文档）：
//   1. POST /ilink/bot/getuploadurl  → 预签名上传参数
//   2. 本地 AES-128-ECB + PKCS7 加密
//   3. POST https://novac2c.cdn.weixin.qq.com/c2c/upload?... → 响应头 x-encrypted-param
//   4. POST /ilink/bot/sendmessage，item 带 CDNMedia
//
// 两个容易搞错的地方，这里刻意写死：
//   - 出站 aes_key 用 base64(hex 字符串)，不是原始 16 字节
//   - file_item.len 是**字符串**形式的明文字节数
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { DEFAULT_MAX_BYTES, safeFileName } from './media.mjs';

const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

export function mediaTypeFor(name) {
  const ext = String(name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXT.has(ext) ? 1 : 3;
}

/**
 * 从回复正文里抽出 `[[send: 路径]]` 标记。
 * 返回去掉标记的正文和路径列表；标记语法对大小写和多余空格宽容。
 */
export function parseSendMarkers(text) {
  const src = String(text ?? '');
  const paths = [];
  const marker = /\[\[\s*send\s*:\s*([^\]\n]+?)\s*\]\]/gi;
  let m;
  while ((m = marker.exec(src)) !== null) {
    const p = m[1].trim();
    if (p) paths.push(p);
  }
  const cleaned = src
    .replace(marker, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, paths };
}

export function cipherSize(rawsize) {
  return Math.ceil((rawsize + 1) / 16) * 16;
}

export function createUploader({
  ilink,
  logger,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
} = {}) {
  if (!ilink) throw new Error('createUploader 需要 ilink');

  async function sendFile({ toUserId, contextToken, path }) {
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new Error(`文件不存在：${path}`);
    }
    if (!st.isFile()) throw new Error(`不是文件：${path}`);
    if (st.size > maxBytes) throw new Error(`超过 ${Math.round(maxBytes / 1048576)} MB 上限`);

    const buf = readFileSync(path);
    const rawsize = buf.length;
    const filesize = cipherSize(rawsize);
    const name = safeFileName(basename(path), 'file.bin');
    const mediaType = mediaTypeFor(name);
    const aeskey = randomBytes(16).toString('hex');
    const key = Buffer.from(aeskey, 'hex');
    const filekey = randomBytes(16).toString('hex');
    const rawfilemd5 = createHash('md5').update(buf).digest('hex');

    const up = await ilink.post('/ilink/bot/getuploadurl', {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey,
    });
    if (!up?.upload_param) throw new Error('getuploadurl 没有返回 upload_param');

    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);

    const uploadUrl =
      `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param)}` +
      `&filekey=${encodeURIComponent(filekey)}`;
    let res;
    try {
      res = await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encrypted,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`上传失败：${e.name === 'TimeoutError' ? '超时' : e.message}`);
    }
    if (!res.ok) throw new Error(`上传失败：HTTP ${res.status}`);
    const encryptQueryParam = res.headers?.get?.('x-encrypted-param');
    if (!encryptQueryParam) throw new Error('CDN 没有返回 x-encrypted-param');

    const media = {
      encrypt_query_param: encryptQueryParam,
      // 出站固定 base64(hex 字符串)
      aes_key: Buffer.from(aeskey, 'latin1').toString('base64'),
      encrypt_type: 1,
    };

    const item =
      mediaType === 1
        ? { type: 2, image_item: { media, mid_size: filesize } }
        : { type: 4, file_item: { media, file_name: name, len: String(rawsize) } };

    const out = await ilink.sendItem({ toUserId, contextToken, item });
    logger?.info?.(`已发送${mediaType === 1 ? '图片' : '文件'} ${rawsize} 字节 -> ${name}`);
    return { name, bytes: rawsize, messageId: out?.messageId ?? null, kind: mediaType === 1 ? 'image' : 'file' };
  }

  return { sendFile };
}

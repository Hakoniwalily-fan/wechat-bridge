// src/qr.mjs
import QRCode from 'qrcode';

export async function renderQr(url, { pngPath } = {}) {
  if (pngPath) await QRCode.toFile(pngPath, url, { width: 480, margin: 2 });
  const ascii = await QRCode.toString(url, { type: 'terminal', small: true });
  return { pngPath: pngPath ?? null, ascii };
}

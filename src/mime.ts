import path from 'node:path';

const IMAGE_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
]);

export function normalizeMimeType(value: string | null | undefined): string {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase();
}

export function imageMimeFromExtension(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  return IMAGE_MIME_BY_EXT.get(path.extname(filePath).toLowerCase());
}

export function imageMimeFromMagic(data: Buffer): string | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 6) {
    const sig = data.subarray(0, 6).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  if (data.length >= 4) {
    const first4 = data.subarray(0, 4);
    if (first4.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || first4.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return 'image/tiff';
  }
  return undefined;
}

export function imageMimeForTelegramPhoto(options: { headerMime?: string | null; filePath?: string; data: Buffer; fallback?: string }): string {
  const headerMime = normalizeMimeType(options.headerMime);
  if (headerMime.startsWith('image/')) return headerMime;
  return imageMimeFromExtension(options.filePath) ?? imageMimeFromMagic(options.data) ?? options.fallback ?? 'image/jpeg';
}

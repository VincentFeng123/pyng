import { nativeImage } from 'electron';
import { readFile } from 'node:fs/promises';

export const AVATAR_SIZE = 64;
export const MAX_INPUT_BYTES = 1 * 1024 * 1024;

export type NormalizedAvatar = {
  imageBase64: string;
  byteLength: number;
};

export async function normalizeAvatarFromFile(filePath: string): Promise<NormalizedAvatar> {
  const buf = await readFile(filePath);
  if (buf.length > MAX_INPUT_BYTES) {
    throw new Error(`avatar source too large: ${buf.length} bytes (max ${MAX_INPUT_BYTES})`);
  }
  return normalizeAvatarFromBuffer(buf);
}

export function normalizeAvatarFromBuffer(buf: Buffer): NormalizedAvatar {
  if (buf.length > MAX_INPUT_BYTES) {
    throw new Error(`avatar source too large: ${buf.length} bytes (max ${MAX_INPUT_BYTES})`);
  }
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) {
    throw new Error('avatar source is not a supported image (PNG/JPG/BMP/etc.)');
  }
  const size = img.getSize();
  const scale = AVATAR_SIZE / Math.min(size.width, size.height);
  const scaledW = Math.round(size.width * scale);
  const scaledH = Math.round(size.height * scale);
  const resized = img.resize({ width: scaledW, height: scaledH, quality: 'good' });
  const cropX = Math.floor((scaledW - AVATAR_SIZE) / 2);
  const cropY = Math.floor((scaledH - AVATAR_SIZE) / 2);
  const cropped = resized.crop({ x: cropX, y: cropY, width: AVATAR_SIZE, height: AVATAR_SIZE });
  const pngBuf = cropped.toPNG();
  return {
    imageBase64: pngBuf.toString('base64'),
    byteLength: pngBuf.length,
  };
}

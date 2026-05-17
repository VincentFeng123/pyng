import { getNativeOpenCv } from './native-opencv.js';

export async function smokeOpenCV(): Promise<boolean> {
  const cv = getNativeOpenCv() as { Mat?: new () => { delete?: () => void } } | null;
  if (typeof cv?.Mat !== 'function') return false;
  const mat = new cv.Mat();
  mat.delete?.();
  return true;
}

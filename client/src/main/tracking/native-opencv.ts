import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cachedCv: unknown | null | undefined;
let cachedError: unknown;

export function getNativeOpenCv(): unknown | null {
  if (cachedCv !== undefined) return cachedCv;
  try {
    const mod = require('@u4/opencv4nodejs') as { default?: unknown };
    cachedCv = mod.default ?? mod;
  } catch (err) {
    cachedError = err;
    cachedCv = null;
  }
  return cachedCv;
}

export function getNativeOpenCvLoadError(): unknown {
  return cachedError;
}

export function nativeOpenCvAvailable(): boolean {
  return getNativeOpenCv() !== null;
}

export function _resetNativeOpenCvForTests(): void {
  cachedCv = undefined;
  cachedError = undefined;
}

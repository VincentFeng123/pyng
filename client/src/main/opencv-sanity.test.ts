import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { getNativeOpenCv, getNativeOpenCvLoadError } from './tracking/native-opencv.js';

test('@u4/opencv4nodejs loads and creates a Mat', (t) => {
  const cv = getNativeOpenCv() as { Mat?: new () => { delete?: () => void } } | null;
  if (typeof cv?.Mat !== 'function') {
    t.skip(`native OpenCV binding unavailable: ${String(getNativeOpenCvLoadError())}`);
    return;
  }

  const mat = new cv.Mat();
  assert.ok(mat, 'Mat() should construct');
  mat.delete?.();
});

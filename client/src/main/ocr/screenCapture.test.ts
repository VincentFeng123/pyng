import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { bitmapToGrayscaleFrame, downscaleTo720p } from './screenCapture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', '..', '..', 'test', 'fixtures');
const SAMPLE = path.join(FIXTURES, 'avatar-source-256x256.png');

test('downscaleTo720p: output height ≤ 720', async () => {
  const input = readFileSync(SAMPLE);
  const output = await downscaleTo720p(input);
  const meta = await sharp(output).metadata();
  assert.ok((meta.height ?? 0) <= 720, `expected height ≤ 720, got ${meta.height}`);
});

test('downscaleTo720p: aspect ratio preserved within 1px rounding', async () => {
  const input = readFileSync(SAMPLE);
  const inMeta = await sharp(input).metadata();
  const output = await downscaleTo720p(input);
  const outMeta = await sharp(output).metadata();

  const inW = inMeta.width ?? 1;
  const inH = inMeta.height ?? 1;
  const outW = outMeta.width ?? 1;
  const outH = outMeta.height ?? 1;

  const inRatio = inW / inH;
  const outRatio = outW / outH;
  assert.ok(
    Math.abs(inRatio - outRatio) < 0.02,
    `aspect ratio changed too much: ${inRatio.toFixed(3)} → ${outRatio.toFixed(3)}`,
  );
});

test('downscaleTo720p: does not enlarge images already ≤ 720px tall', async () => {
  const input = readFileSync(SAMPLE);
  const inMeta = await sharp(input).metadata();
  const output = await downscaleTo720p(input);
  const outMeta = await sharp(output).metadata();

  if ((inMeta.height ?? 0) <= 720) {
    assert.equal(outMeta.height, inMeta.height, 'small image should not be enlarged');
  }
});

test('bitmapToGrayscaleFrame converts 4-byte bitmap data without channel-order assumptions', () => {
  const bitmap = Buffer.from([0, 30, 60, 255, 90, 120, 150, 255]);
  const frame = bitmapToGrayscaleFrame(bitmap, 2, 1);
  assert.equal(frame.width, 2);
  assert.equal(frame.height, 1);
  assert.deepEqual([...frame.buffer], [30, 120]);
});

test('bitmapToGrayscaleFrame can include an RGB buffer for visual tracking', () => {
  const bitmap = Buffer.from([0, 30, 60, 255, 90, 120, 150, 255]);
  const frame = bitmapToGrayscaleFrame(bitmap, 2, 1, { includeRgbBuffer: true });
  assert.deepEqual([...(frame.rgbBuffer ?? Buffer.alloc(0))], [0, 30, 60, 90, 120, 150]);
});

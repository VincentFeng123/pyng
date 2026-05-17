// These tests require Electron's `nativeImage` API. They skip under plain
// Node so `npm test` (which runs tsx --test) stays green; run them via
// `npm run test:electron` to exercise the avatar normalization path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const isElectron = typeof process.versions.electron === 'string';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', '..', 'test', 'fixtures');
const SAMPLE_256 = path.join(FIXTURES, 'avatar-source-256x256.png');

test(
  'normalizes a 256x256 PNG to a 64x64 PNG under a size cap',
  { skip: !isElectron },
  async () => {
    const { normalizeAvatarFromFile, AVATAR_SIZE } = await import('./avatarNormalize.js');
    const { nativeImage } = await import('electron');
    const out = await normalizeAvatarFromFile(SAMPLE_256);
    assert.ok(out.imageBase64.length > 0);
    assert.ok(out.byteLength < 10 * 1024, `expected <10KB, got ${out.byteLength}`);
    const decoded = nativeImage.createFromBuffer(Buffer.from(out.imageBase64, 'base64'));
    const size = decoded.getSize();
    assert.equal(size.width, AVATAR_SIZE);
    assert.equal(size.height, AVATAR_SIZE);
  },
);

test('rejects oversize input files', { skip: !isElectron }, async () => {
  const { normalizeAvatarFromFile, MAX_INPUT_BYTES } = await import('./avatarNormalize.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'pyng-avatar-test-'));
  try {
    const big = path.join(dir, 'big.bin');
    writeFileSync(big, Buffer.alloc(MAX_INPUT_BYTES + 1));
    await assert.rejects(() => normalizeAvatarFromFile(big), /too large/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects non-image input', { skip: !isElectron }, async () => {
  const { normalizeAvatarFromFile } = await import('./avatarNormalize.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'pyng-avatar-test-'));
  try {
    const txt = path.join(dir, 'not-image.txt');
    writeFileSync(txt, 'plain text, definitely not a PNG');
    await assert.rejects(() => normalizeAvatarFromFile(txt), /not a supported image/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

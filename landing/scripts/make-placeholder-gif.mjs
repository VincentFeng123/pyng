// One-shot generator for landing/demo.gif placeholder. Runs ad-hoc:
//   node landing/scripts/make-placeholder-gif.mjs
// Replace landing/demo.gif with the real 15-second screencap at release.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'demo.gif');

const W = 720;
const H = 405;

// Two-color palette: 0 = bg #0e0e10, 1 = accent #7c3aed.
const palette = Buffer.from([0x0e, 0x0e, 0x10, 0x7c, 0x3a, 0xed]);

// Pack a single frame: every pixel = color index 0 (solid bg). We then encode
// it as LZW per the GIF spec. To keep this generator trivially correct, use
// the simplest legal "uncompressed" encoding: emit clear codes between every
// few pixels. A standard LZW encoder is overkill for a constant-color frame.

function encodeFrame() {
  const minCodeSize = 2; // smallest legal value
  const clearCode = 1 << minCodeSize; // 4
  const eoiCode = clearCode + 1; // 5
  const codeSize = minCodeSize + 1; // start at 3 bits

  // Bit-pack codes into bytes. The encoder emits: CLEAR, then runs of
  // index-0 codes (color 0), with CLEAR every ~100 codes to avoid growing
  // the dictionary, then EOI.
  const out = [];
  let bitBuf = 0;
  let bitCount = 0;
  const pushCode = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  pushCode(clearCode);
  const total = W * H;
  for (let i = 0; i < total; i++) {
    if (i > 0 && i % 100 === 0) pushCode(clearCode);
    pushCode(0); // color index 0
  }
  pushCode(eoiCode);
  if (bitCount > 0) out.push(bitBuf & 0xff);

  // Wrap raw bytes in GIF sub-blocks (max 255 per block).
  const subBlocks = [];
  subBlocks.push(minCodeSize);
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    subBlocks.push(chunk.length);
    for (const b of chunk) subBlocks.push(b);
  }
  subBlocks.push(0); // block terminator
  return Buffer.from(subBlocks);
}

const header = Buffer.from('GIF89a', 'ascii');
const lsd = Buffer.alloc(7);
lsd.writeUInt16LE(W, 0);
lsd.writeUInt16LE(H, 2);
lsd[4] = 0b10010001; // global color table flag, color resolution=2 bits/channel, sorted=0, size=001 (4 entries)
lsd[5] = 0; // bg color index
lsd[6] = 0; // pixel aspect

const gct = Buffer.alloc(12); // 4 entries × 3 bytes = 12; only first two are non-zero
palette.copy(gct, 0);

const imageDesc = Buffer.alloc(10);
imageDesc[0] = 0x2c;
imageDesc.writeUInt16LE(0, 1);
imageDesc.writeUInt16LE(0, 3);
imageDesc.writeUInt16LE(W, 5);
imageDesc.writeUInt16LE(H, 7);
imageDesc[9] = 0;

const trailer = Buffer.from([0x3b]);

const buf = Buffer.concat([header, lsd, gct, imageDesc, encodeFrame(), trailer]);
writeFileSync(OUT, buf);
process.stdout.write(`wrote ${OUT} (${buf.length} bytes)\n`);

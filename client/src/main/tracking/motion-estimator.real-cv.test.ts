// Real runtime smoke test for estimateMotion.
//
// The runtime uses @u4/opencv4nodejs for per-ping KCF correction and falls back
// to the built-in patch matcher for global motion, so this test exercises the
// no-mock default.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { warmup, estimateMotion } from './motion-estimator.js';

// ---- Synthetic image generator (adapted from motion-estimator.golden.test.ts) ----

function generateSyntheticGray(
  width: number,
  height: number,
  options: { offsetX?: number; offsetY?: number },
): Buffer {
  const { offsetX = 0, offsetY = 0 } = options;
  const buf = Buffer.alloc(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - offsetX;
      const sy = y - offsetY;
      const gx = ((((sx % 37) + 37) % 37) - 18) ** 2;
      const gy = ((((sy % 29) + 29) % 29) - 14) ** 2;
      const val = (gx < 9 && gy < 9 ? 220 : 40) + 30 * Math.sin(sx / 17) + 20 * Math.cos(sy / 23);
      buf[y * width + x] = Math.max(0, Math.min(255, Math.round(val)));
    }
  }

  return buf;
}

// ---- Tests ----

describe('estimateMotion default runtime path (no mock)', () => {
  before(async () => {
    // Native module loading can take a moment on a cold start; allow up to 15s.
    await warmup();
  });

  it(
    '16px rightward translation produces expected yaw/pitch (non-mock path)',
    { timeout: 15000 },
    async (_t) => {
      const W = 320;
      const H = 240;
      const PPD = 8.0;

      const prev = generateSyntheticGray(W, H, { offsetX: 0, offsetY: 0 });
      const curr = generateSyntheticGray(W, H, { offsetX: 16, offsetY: 0 });

      // NO _cv argument — uses the runtime default path.
      const motion = estimateMotion(prev, curr, W, H, [], PPD);

      assert.ok(motion !== null, 'estimateMotion returned null: default runtime path failed');

      const { yawDelta, pitchDelta, inlierCount } = motion;

      // 2. Rightward translation (world moves left in camera) → negative yawDelta.
      assert.ok(
        yawDelta < 0,
        `yawDelta ${yawDelta.toFixed(4)} should be negative for rightward translation`,
      );

      // 3. Expected yaw ≈ -2.0° (16px / 8 PPD). Loose ±1.5° tolerance because
      //    the runtime fallback uses coarse patch registration.
      assert.ok(
        Math.abs(yawDelta + 2.0) < 1.5,
        `yawDelta ${yawDelta.toFixed(4)} not within ±1.5° of expected -2.0°`,
      );

      // 4. Patch consensus should have enough grid matches to be usable.
      assert.ok(
        inlierCount >= 5,
        `inlierCount ${inlierCount} should be >= 5; too few means patch tracking is degraded`,
      );

      // 5. No Y translation → pitchDelta should be near zero.
      assert.ok(
        Math.abs(pitchDelta) < 1.5,
        `pitchDelta ${pitchDelta.toFixed(4)} should be near 0 (no vertical shift)`,
      );

      // Log the actual values so CI output documents the runtime numbers.
      console.log(
        `runtime motion output — yawDelta: ${yawDelta.toFixed(4)}, pitchDelta: ${pitchDelta.toFixed(4)}, inlierCount: ${inlierCount}`,
      );
    },
  );
});

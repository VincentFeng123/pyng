import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GrayFrame } from './capture-loop.js';
import { VisualPatchCorrector } from './visual-patch-corrector.js';

describe('VisualPatchCorrector', () => {
  it('captures the initial patch, then finds the shifted patch', () => {
    const corrector = new VisualPatchCorrector({
      patchSizePx: 15,
      innerMaskRadiusPx: 2,
      searchRadiusPx: 12,
      minScore: 0.55,
    });
    const frameA = makeFrame(80, 50);
    const frameB = makeFrame(80, 50);
    drawPattern(frameA, 40, 25);
    drawPattern(frameB, 46, 25);

    const projection = {
      id: 'p',
      screenX: 40,
      screenY: 25,
      confidence: 1,
      isEdgeArrow: false,
    };

    assert.deepEqual(corrector.update(frameA, [projection], { width: 80, height: 50 }), []);

    const corrections = corrector.update(frameB, [projection], { width: 80, height: 50 });
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0]!.id, 'p');
    assert.ok(Math.abs(corrections[0]!.observedScreenX - 46) <= 1);
    assert.ok(corrections[0]!.confidence > 0.75);
  });

  it('ignores the center of the patch so the overlay marker cannot dominate matching', () => {
    const corrector = new VisualPatchCorrector({
      patchSizePx: 17,
      innerMaskRadiusPx: 4,
      searchRadiusPx: 12,
      minScore: 0.55,
    });
    const frameA = makeFrame(90, 60);
    const frameB = makeFrame(90, 60);
    drawPattern(frameA, 45, 30);
    drawPattern(frameB, 51, 30);
    drawCenterMarker(frameA, 45, 30);
    drawCenterMarker(frameB, 45, 30);

    const projection = {
      id: 'p',
      screenX: 45,
      screenY: 30,
      confidence: 1,
      isEdgeArrow: false,
    };

    corrector.update(frameA, [projection], { width: 90, height: 60 });
    const corrections = corrector.update(frameB, [projection], { width: 90, height: 60 });

    assert.equal(corrections.length, 1);
    assert.ok(
      Math.abs(corrections[0]!.observedScreenX - 51) <= 1,
      `expected ring match near shifted scene patch, got ${corrections[0]!.observedScreenX}`,
    );
  });
});

function makeFrame(width: number, height: number): GrayFrame {
  return { width, height, buffer: Buffer.alloc(width * height, 24) };
}

function drawPattern(frame: GrayFrame, cx: number, cy: number): void {
  for (let y = -8; y <= 8; y++) {
    for (let x = -8; x <= 8; x++) {
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
      const value = 60 + ((x * 17 + y * 31 + x * y * 7 + 512) % 170);
      frame.buffer[py * frame.width + px] = value;
    }
  }
}

function drawCenterMarker(frame: GrayFrame, cx: number, cy: number): void {
  for (let y = -3; y <= 3; y++) {
    for (let x = -3; x <= 3; x++) {
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
      frame.buffer[py * frame.width + px] = 255;
    }
  }
}

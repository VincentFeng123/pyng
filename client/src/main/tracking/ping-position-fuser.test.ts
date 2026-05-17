import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PingPositionFuser } from './ping-position-fuser.js';
import type { PingProjection } from './ping-tracker.js';
import type { SurfaceTrackerResult, SurfaceTrackingMethod } from './surface-tracking-types.js';

const NS_PER_MS = 1_000_000;

function projection(screenX: number, confidence = 1): PingProjection {
  return {
    id: 'p',
    screenX,
    screenY: 70,
    confidence,
    isEdgeArrow: false,
  };
}

function localObservation(
  screenX: number,
  observedAtNs: number,
  confidence = 0.9,
  trackingMethod?: SurfaceTrackingMethod,
): SurfaceTrackerResult {
  return {
    id: 'p',
    screenX,
    screenY: 70,
    confidence,
    observedAtNs,
    inlierCount: 24,
    trackedPointCount: 28,
    residualPx: 1.1,
    trackingMethod,
  };
}

describe('PingPositionFuser', () => {
  it('uses a strong local anchor to move the emitted ping without changing global projection', () => {
    const fuser = new PingPositionFuser();
    const first = fuser.update([projection(110)], new Map(), 0, 'frame')[0]!;
    assert.equal(first.screenX, 110);

    const nowNs = 16 * NS_PER_MS;
    const observations = new Map([['p', localObservation(124, nowNs)]]);
    const fused = fuser.update([projection(110)], observations, nowNs, 'optical')[0]!;

    assert.ok(fused.screenX > 113, `screenX ${fused.screenX} should follow local evidence`);
    assert.equal(fused.globalConfidence, 1);
    assert.ok((fused.localConfidence ?? 0) > 0.8);
    assert.equal(fused.trackingState, 'exact');
  });

  it('lets medium-confidence KCF visual correction move with real pixel magnitude', () => {
    const fuser = new PingPositionFuser();
    fuser.update([projection(100)], new Map(), 0, 'frame');

    const nowNs = 16 * NS_PER_MS;
    const observations = new Map([['p', localObservation(140, nowNs, 0.55, 'kcf')]]);
    const fused = fuser.update([projection(100)], observations, nowNs, 'frame')[0]!;

    assert.ok(
      fused.screenX > 125,
      `KCF correction should not be blended down to a tiny nudge, got ${fused.screenX}`,
    );
    assert.equal(fused.trackingMethod, 'kcf');
    assert.ok((fused.localConfidence ?? 0) >= 0.55);
  });

  it('does not clamp a plausible KCF jump back toward the prediction', () => {
    const fuser = new PingPositionFuser();
    fuser.update([projection(100)], new Map(), 0, 'frame');

    const nowNs = 16 * NS_PER_MS;
    const observations = new Map([['p', localObservation(230, nowNs, 0.5, 'kcf')]]);
    const fused = fuser.update([projection(100)], observations, nowNs, 'frame')[0]!;

    assert.ok(
      fused.screenX > 170,
      `KCF jump should remain large enough to catch up, got ${fused.screenX}`,
    );
    assert.ok((fused.uncertaintyPx ?? 0) < 60);
  });

  it('falls back to global projection when the local observation is stale', () => {
    const fuser = new PingPositionFuser();
    fuser.update([projection(110)], new Map(), 0, 'frame');

    const nowNs = 200 * NS_PER_MS;
    const observations = new Map([['p', localObservation(160, 0)]]);
    const fused = fuser.update([projection(112)], observations, nowNs, 'mouse')[0]!;

    assert.ok(
      fused.screenX < 120,
      `stale local observation should be ignored, got ${fused.screenX}`,
    );
    assert.equal(fused.localConfidence, 0);
  });
});

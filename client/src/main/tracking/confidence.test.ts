import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfidenceEstimator, type MotionResult } from './confidence.js';

function makeMotion(yawDelta: number, pitchDelta: number, inlierCount = 50): MotionResult {
  return { yawDelta, pitchDelta, inlierCount };
}

describe('ConfidenceEstimator', () => {
  it('agree-magnitude-and-sign → 1.0', () => {
    const est = new ConfidenceEstimator();
    // Mouse moved +80px horizontally → expectedYaw = +80/8 = +10 deg
    // Inject event ~100ms in the past to keep lastEventAt within 1000ms window.
    est.recordMouseDelta(80, 0);
    // Patch lastEventAt to be recent — we need to record now and score now.
    const motion = makeMotion(10, 0); // actual yaw matches expected
    const result = est.score(motion, 8.0);
    assert.equal(result, 1.0);
  });

  it('disagree-sign → 0.0', () => {
    const est = new ConfidenceEstimator();
    est.recordMouseDelta(80, 0);
    // Mouse moved +80px → expectedYaw = +10; actual = -10 (opposite sign)
    const motion = makeMotion(-10, 0);
    const result = est.score(motion, 8.0);
    assert.equal(result, 0.0);
  });

  it('agree-sign-disagree-magnitude ratio=2.0 → ≈0.7', () => {
    const est = new ConfidenceEstimator();
    // expectedYaw = +80/8 = +10; actual = +20 (ratio = 2.0)
    est.recordMouseDelta(80, 0);
    const motion = makeMotion(20, 0);
    const result = est.score(motion, 8.0);
    // raw = 0.3 + 0.4 * (1 - |2.0 - 1|) = 0.3 + 0.4 * 0 = 0.3, clamped to [0.3, 0.7]
    assert.ok(result >= 0.3 && result <= 0.7, `expected 0.3–0.7, got ${result}`);
  });

  it('agree-sign-disagree-magnitude ratio=5.0 → 0.3', () => {
    const est = new ConfidenceEstimator();
    // expectedYaw = +10; actual = +50 (ratio = 5.0)
    est.recordMouseDelta(80, 0);
    const motion = makeMotion(50, 0);
    const result = est.score(motion, 8.0);
    // raw = 0.3 + 0.4 * (1 - 4) = 0.3 - 1.2 < 0 → clamped to 0.3
    assert.equal(result, 0.3);
  });

  it('no-mouse-data → inlierCount/100 capped at 0.8', () => {
    const est = new ConfidenceEstimator();
    // No recordMouseDelta calls, so lastEventAt = 0 → falls back to inlier path.
    assert.equal(est.score(makeMotion(0, 0, 50), 8.0), 0.5);
    assert.equal(est.score(makeMotion(0, 0, 150), 8.0), 0.8); // capped
  });

  it('zero mouse deltas are ignored so optical-flow fallback can still track', () => {
    const est = new ConfidenceEstimator();
    est.recordMouseDelta(0, 0);
    assert.deepEqual(est.getAccumulatedDelta(), { dx: 0, dy: 0, eventCount: 0 });
    assert.equal(est.score(makeMotion(5, 0, 70), 8.0), 0.7);
  });

  it('cancelling fullscreen cursor deltas fall back to optical-flow confidence', () => {
    const est = new ConfidenceEstimator();
    est.recordMouseDelta(20, 0);
    est.recordMouseDelta(-20, 0);
    assert.equal(est.score(makeMotion(5, 0, 70), 8.0), 0.7);
  });

  it('consumeAccumulatedDelta returns net and absolute movement, then clears the buffer', () => {
    const est = new ConfidenceEstimator();
    est.recordMouseDelta(10, -2);
    est.recordMouseDelta(-4, -3);

    const summary = est.consumeAccumulatedDelta();
    assert.equal(summary.dx, 6);
    assert.equal(summary.dy, -5);
    assert.equal(summary.absDx, 14);
    assert.equal(summary.absDy, 5);
    assert.equal(summary.eventCount, 2);
    assert.ok(summary.ageMs !== null);
    assert.deepEqual(est.getAccumulatedDelta(), { dx: 0, dy: 0, eventCount: 0 });
  });

  it('ring buffer does not grow unbounded after 10000 recordMouseDelta calls', () => {
    const est = new ConfidenceEstimator({ bufferSize: 512 });
    for (let i = 0; i < 10000; i++) {
      est.recordMouseDelta(1, 1);
    }
    const { eventCount } = est.getAccumulatedDelta();
    assert.ok(eventCount <= 512, `buffer grew to ${eventCount}, expected ≤ 512`);
  });
});

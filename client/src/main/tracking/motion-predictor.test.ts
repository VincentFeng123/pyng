import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MotionPredictor } from './motion-predictor.js';

const NS_PER_MS = 1_000_000;

describe('MotionPredictor', () => {
  it('predicts slightly ahead from recent timestamped mouse velocity', () => {
    const p = new MotionPredictor();
    p.recordMouseDelta(80, 0, 1 / 8, 1_000 * NS_PER_MS);
    p.recordMouseDelta(80, 0, 1 / 8, 1_008 * NS_PER_MS);

    const pose = p.predictPose(20, 0, 1_009 * NS_PER_MS);

    assert.ok(pose.yawDeg > 20, `expected predicted yaw > 20, got ${pose.yawDeg}`);
    assert.ok(pose.yawDeg <= 23, `prediction should be capped, got ${pose.yawDeg}`);
    assert.ok(pose.leadMs > 0);
  });

  it('compensates for input age so delayed mouse events do not render behind', () => {
    const p = new MotionPredictor();
    p.recordMouseDelta(80, 0, 1 / 8, 1_000 * NS_PER_MS);
    p.recordMouseDelta(80, 0, 1 / 8, 1_008 * NS_PER_MS);

    const immediate = p.predictPose(20, 0, 1_009 * NS_PER_MS);
    const delayed = p.predictPose(20, 0, 1_016 * NS_PER_MS);

    assert.ok(
      delayed.yawDeg > immediate.yawDeg,
      `${delayed.yawDeg} should lead ${immediate.yawDeg}`,
    );
    assert.ok(delayed.yawDeg <= 23, `prediction should stay bounded, got ${delayed.yawDeg}`);
  });

  it('stops predicting after input goes stale', () => {
    const p = new MotionPredictor();
    p.recordMouseDelta(80, 0, 1 / 8, 1_000 * NS_PER_MS);
    p.recordMouseDelta(80, 0, 1 / 8, 1_008 * NS_PER_MS);

    const pose = p.predictPose(20, 0, 1_200 * NS_PER_MS);

    assert.equal(pose.yawDeg, 20);
    assert.equal(pose.pitchDeg, 0);
    assert.equal(pose.leadMs, 0);
  });

  it('predicts pitch using the same camera convention as mouse tracking', () => {
    const p = new MotionPredictor();
    p.recordMouseDelta(0, -80, 1 / 8, 1_000 * NS_PER_MS);
    p.recordMouseDelta(0, -80, 1 / 8, 1_008 * NS_PER_MS);

    const pose = p.predictPose(0, 20, 1_009 * NS_PER_MS);

    assert.ok(pose.pitchDeg > 20, `expected predicted pitch > 20, got ${pose.pitchDeg}`);
  });
});

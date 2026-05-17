import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentInterpolatedPosition,
  interpolate,
  interpolationWindowForCadence,
  MAX_DYNAMIC_INTERP_WINDOW_MS,
  MIN_DYNAMIC_INTERP_WINDOW_MS,
  type TrackingTarget,
} from './tracking-math.js';

const TARGET: TrackingTarget = {
  targetX: 100,
  targetY: 200,
  targetConfidence: 0.8,
  isEdgeArrow: false,
  receivedAt: 0,
};

const LAST = { x: 0, y: 0, confidence: 0 };

describe('interpolate', () => {
  it('returns last position at elapsed=0', () => {
    const result = interpolate(LAST, TARGET, 0);
    assert.equal(result.x, 0);
    assert.equal(result.y, 0);
    assert.equal(result.confidence, 0);
  });

  it('returns exact target at elapsed >= INTERP_WINDOW_MS (6ms)', () => {
    const result = interpolate(LAST, TARGET, 6);
    assert.equal(result.x, 100);
    assert.equal(result.y, 200);
    assert.equal(result.confidence, 0.8);
  });

  it('returns midpoint at elapsed = 3ms (~50%)', () => {
    const result = interpolate(LAST, TARGET, 3);
    assert.ok(Math.abs(result.x - 50) < 0.1, `x=${result.x}`);
    assert.ok(Math.abs(result.y - 100) < 0.1, `y=${result.y}`);
    assert.ok(Math.abs(result.confidence - 0.4) < 0.01, `conf=${result.confidence}`);
  });

  it('clamps t to 1 when elapsed exceeds window', () => {
    const result = interpolate(LAST, TARGET, 500);
    assert.equal(result.x, 100);
    assert.equal(result.y, 200);
    assert.equal(result.confidence, 0.8);
  });

  it('handles last === target (no movement)', () => {
    const same = { x: 100, y: 200, confidence: 0.8 };
    const result = interpolate(same, TARGET, 33);
    assert.equal(result.x, 100);
    assert.equal(result.y, 200);
    assert.equal(result.confidence, 0.8);
  });

  it('snaps sub-pixel residuals instead of easing forever', () => {
    const result = interpolate({ x: 99.6, y: 200.2, confidence: 0.79 }, TARGET, 0);
    assert.equal(result.x, 100);
    assert.equal(result.y, 200);
    assert.equal(result.confidence, 0.8);
  });

  it('honors a per-target interpolation window', () => {
    const result = interpolate(LAST, { ...TARGET, interpWindowMs: 12 }, 6);
    assert.ok(Math.abs(result.x - 50) < 0.1, `x=${result.x}`);
    assert.ok(Math.abs(result.y - 100) < 0.1, `y=${result.y}`);
  });
});

describe('currentInterpolatedPosition', () => {
  it('uses target.receivedAt as the interpolation origin', () => {
    const result = currentInterpolatedPosition(LAST, { ...TARGET, receivedAt: 100 }, 103);
    assert.ok(Math.abs(result.x - 50) < 0.1, `x=${result.x}`);
    assert.ok(Math.abs(result.y - 100) < 0.1, `y=${result.y}`);
  });
});

describe('interpolationWindowForCadence', () => {
  it('uses a minimum one-frame smoothing window for the first update', () => {
    assert.equal(interpolationWindowForCadence(null, 100), MIN_DYNAMIC_INTERP_WINDOW_MS);
  });

  it('tracks source update cadence and clamps very slow updates', () => {
    assert.ok(interpolationWindowForCadence(100, 150) < 50);
    assert.equal(interpolationWindowForCadence(0, 500), MAX_DYNAMIC_INTERP_WINDOW_MS);
  });

  it('credits prediction lead when choosing the smoothing window', () => {
    assert.ok(
      interpolationWindowForCadence(100, 150, 12) < interpolationWindowForCadence(100, 150),
    );
  });

  it('uses a shorter smoothing window for mouse-driven predicted updates', () => {
    const frameWindow = interpolationWindowForCadence(100, 150, 8, 'frame');
    const mouseWindow = interpolationWindowForCadence(100, 150, 8, 'mouse');

    assert.ok(mouseWindow < frameWindow, `${mouseWindow} should be shorter than ${frameWindow}`);
  });

  it('uses a keyboard-specific smoothing window between mouse and frame updates', () => {
    const frameWindow = interpolationWindowForCadence(100, 150, 8, 'frame');
    const keyboardWindow = interpolationWindowForCadence(100, 150, 8, 'keyboard');
    const mouseWindow = interpolationWindowForCadence(100, 150, 8, 'mouse');

    assert.ok(
      keyboardWindow < frameWindow,
      `${keyboardWindow} should be shorter than ${frameWindow}`,
    );
    assert.ok(
      keyboardWindow > mouseWindow,
      `${keyboardWindow} should remain smoother than ${mouseWindow}`,
    );
  });

  it('uses a shorter smoothing window for visual object locks', () => {
    const frameWindow = interpolationWindowForCadence(100, 116, 0, 'frame', 'prediction');
    const kcfWindow = interpolationWindowForCadence(100, 116, 0, 'frame', 'kcf');

    assert.ok(kcfWindow < frameWindow, `${kcfWindow} should be shorter than ${frameWindow}`);
  });
});

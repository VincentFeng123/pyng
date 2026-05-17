import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingCaptureLoop, type GrayFrame } from './capture-loop.js';
import { ScreenCaptureError } from '../ocr/screenCapture.js';

const FAKE_FRAME: GrayFrame = { buffer: Buffer.from([0, 1, 2, 3]), width: 2, height: 2 };

function makeFakeCapture(
  behavior: 'ok' | 'screen-error' | 'other-error' | (() => Promise<GrayFrame>),
): () => Promise<GrayFrame> {
  if (typeof behavior === 'function') return behavior;
  return async () => {
    if (behavior === 'screen-error') throw new ScreenCaptureError('in flight');
    if (behavior === 'other-error') throw new Error('unexpected capture failure');
    return FAKE_FRAME;
  };
}

// Wait for real timers to fire; works with setTimeout chaining.
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFrameCount(
  frames: GrayFrame[],
  minCount: number,
  timeoutMs = 250,
): Promise<void> {
  const startedAt = Date.now();
  while (frames.length < minCount && Date.now() - startedAt < timeoutMs) {
    await wait(10);
  }
}

describe('TrackingCaptureLoop', () => {
  it('start → onFrame fires repeatedly, stop → onFrame stops', async () => {
    const frames: GrayFrame[] = [];
    const loop = new TrackingCaptureLoop({
      fps: 100, // fast for tests
      onFrame: (f) => {
        frames.push(f);
      },
      _captureFn: makeFakeCapture('ok'),
    });

    loop.start();
    assert.ok(loop.isRunning());

    await waitForFrameCount(frames, 2);
    loop.stop();
    assert.ok(!loop.isRunning());

    const countAfterStop = frames.length;
    assert.ok(countAfterStop >= 2, `expected ≥ 2 frames, got ${countAfterStop}`);

    await wait(40);
    assert.equal(frames.length, countAfterStop, 'no new frames after stop');
  });

  it('start() when already running is a no-op (no double scheduling)', async () => {
    const frames: GrayFrame[] = [];
    const loop = new TrackingCaptureLoop({
      fps: 100,
      onFrame: (f) => {
        frames.push(f);
      },
      _captureFn: makeFakeCapture('ok'),
    });

    loop.start();
    loop.start(); // second call should be no-op

    await wait(50);
    loop.stop();

    // If double-scheduled, frame rate would be roughly doubled. We can't assert exact count
    // but assert frames arrived (loop ran at all).
    assert.ok(frames.length >= 1);
  });

  it('ScreenCaptureError is silently skipped — onError NOT called', async () => {
    const errors: Error[] = [];
    const frames: GrayFrame[] = [];
    const loop = new TrackingCaptureLoop({
      fps: 100,
      onFrame: (f) => {
        frames.push(f);
      },
      onError: (e) => errors.push(e),
      _captureFn: makeFakeCapture('screen-error'),
    });

    loop.start();
    await wait(60);
    loop.stop();

    assert.equal(errors.length, 0, 'onError must not be called for ScreenCaptureError');
    assert.equal(frames.length, 0, 'no frames when capture always throws');
  });

  it('non-ScreenCaptureError calls onError', async () => {
    const errors: Error[] = [];
    const loop = new TrackingCaptureLoop({
      fps: 100,
      onFrame: () => {},
      onError: (e) => errors.push(e),
      _captureFn: makeFakeCapture('other-error'),
    });

    loop.start();
    await wait(60);
    loop.stop();

    assert.ok(errors.length >= 1, 'onError should have been called');
    assert.ok(errors[0] instanceof Error);
    assert.equal(errors[0]!.message, 'unexpected capture failure');
  });

  it('setFps changes the interval', async () => {
    const frames: GrayFrame[] = [];
    const loop = new TrackingCaptureLoop({
      fps: 10, // 100ms per tick
      onFrame: (f) => {
        frames.push(f);
      },
      _captureFn: makeFakeCapture('ok'),
    });

    loop.start();
    await wait(80); // <1 tick at 10fps
    const countSlow = frames.length;

    loop.setFps(200); // ~5ms per tick
    await wait(80);
    const countFast = frames.length - countSlow;

    loop.stop();

    assert.ok(
      countFast > countSlow + 2,
      `expected more frames at 200fps (${countFast}) vs 10fps (${countSlow})`,
    );
  });

  it('awaits onFrame processing before scheduling the next capture', async () => {
    let activeHandlers = 0;
    let maxActiveHandlers = 0;
    let frames = 0;
    const loop = new TrackingCaptureLoop({
      fps: 500,
      onFrame: async () => {
        frames++;
        activeHandlers++;
        maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
        await wait(20);
        activeHandlers--;
      },
      _captureFn: makeFakeCapture('ok'),
    });

    loop.start();
    await wait(70);
    loop.stop();

    assert.equal(maxActiveHandlers, 1, 'onFrame handlers must not overlap');
    assert.ok(frames <= 4, `expected backpressure to limit frames, got ${frames}`);
  });

  it('stop is idempotent', () => {
    const loop = new TrackingCaptureLoop({
      onFrame: () => {},
      _captureFn: makeFakeCapture('ok'),
    });

    loop.start();
    loop.stop();
    assert.doesNotThrow(() => loop.stop());
    assert.ok(!loop.isRunning());
  });

  it('frame shape matches GrayFrame type (buffer, width, height)', async () => {
    const frames: GrayFrame[] = [];
    const loop = new TrackingCaptureLoop({
      fps: 200,
      onFrame: (f) => {
        frames.push(f);
      },
      _captureFn: makeFakeCapture('ok'),
    });

    loop.start();
    await wait(30);
    loop.stop();

    assert.ok(frames.length >= 1, 'expected at least one frame');
    const f = frames[0]!;
    assert.ok(Buffer.isBuffer(f.buffer));
    assert.equal(typeof f.width, 'number');
    assert.equal(typeof f.height, 'number');
    assert.equal(f.width, 2);
    assert.equal(f.height, 2);
  });
});

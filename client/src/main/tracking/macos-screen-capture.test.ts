import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MacScreenCaptureLoop } from './macos-screen-capture.js';
import type { TrackingFrameLoop } from './capture-loop.js';

class FakeFrameLoop implements TrackingFrameLoop {
  readonly setFpsCalls: number[] = [];
  startCalls = 0;
  stopCalls = 0;
  private running = false;

  start(): void {
    this.running = true;
    this.startCalls++;
  }

  stop(): void {
    this.running = false;
    this.stopCalls++;
  }

  setFps(fps: number): void {
    this.setFpsCalls.push(fps);
  }

  isRunning(): boolean {
    return this.running;
  }
}

describe('MacScreenCaptureLoop', () => {
  it('keeps Electron fallback capped after active tracking requests 60fps', () => {
    const fallback = new FakeFrameLoop();
    const loop = new MacScreenCaptureLoop({
      fps: 60,
      onFrame: () => {},
      fallbackFactory: () => fallback,
      log: () => {},
    });

    const internals = loop as unknown as Record<string, unknown>;
    internals.running = true;
    const startFallback = internals.startFallback as (
      this: MacScreenCaptureLoop,
      reason: string,
    ) => void;
    startFallback.call(loop, 'test');

    assert.deepEqual(fallback.setFpsCalls, [30]);
    assert.equal(fallback.startCalls, 1);

    loop.setFps(60);
    assert.equal(fallback.setFpsCalls.at(-1), 30);

    loop.setFps(15);
    assert.equal(fallback.setFpsCalls.at(-1), 15);
  });
});

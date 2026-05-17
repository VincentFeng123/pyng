import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingLoop } from './tracking-loop.js';
import { TrackingCaptureLoop } from './capture-loop.js';
import { PingTracker } from './ping-tracker.js';
import { ConfidenceEstimator } from './confidence.js';
import type { GrayFrame } from './capture-loop.js';
import type { OverlayUpdatePingPositionPayload } from '@pyng/shared';
import type { MotionResult } from './motion-estimator.js';
import type { KeyboardTrackingState, TrackingLoopOptions } from './tracking-loop.js';
import type { FlowEstimate } from './ping-tracker.js';

const FRAME_A: GrayFrame = { buffer: Buffer.alloc(4), width: 2, height: 2 };
const FRAME_B: GrayFrame = { buffer: Buffer.alloc(4, 1), width: 2, height: 2 };
const NS_PER_MS = 1_000_000;
const KEYBOARD_FORWARD: KeyboardTrackingState = {
  forward: true,
  backward: false,
  left: false,
  right: false,
  jump: false,
  crouch: false,
  sprint: false,
  horizontalAxis: 0,
  verticalAxis: 1,
  activeKeyCount: 1,
  active: true,
};

function wait(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// A fake capture loop whose start/stop/setFps calls are tracked.
// The factory wires `onFrame` so tests can fire frames manually.
type FakeLoopState = {
  startCalls: number;
  stopCalls: number;
  setFpsCalls: number[];
  fireFrame: (f: GrayFrame) => void;
  fireFrameAsync: (f: GrayFrame) => Promise<void>;
  factory: NonNullable<TrackingLoopOptions['_CaptureLoopFactory']>;
};

function makeFakeLoopFactory(): FakeLoopState {
  // Use an object so mutations are visible through the returned reference.
  const self: FakeLoopState = {
    startCalls: 0,
    stopCalls: 0,
    setFpsCalls: [],
    fireFrame: (_f: GrayFrame) => {
      /* filled in factory call */
    },
    fireFrameAsync: async (_f: GrayFrame) => {
      /* filled in factory call */
    },
    factory: (
      onFrame: (f: GrayFrame) => void | Promise<void>,
      onError: (e: Error) => void,
    ): TrackingCaptureLoop => {
      // Let tests call fireFrame to push a frame into the TrackingLoop handler.
      self.fireFrame = (f) => {
        void onFrame(f);
      };
      self.fireFrameAsync = async (f) => {
        await onFrame(f);
      };

      const inner = new TrackingCaptureLoop({
        fps: 15,
        onFrame,
        onError,
        _captureFn: async () => FRAME_A,
      });

      // Wrap prototype methods on the instance so we can count calls.
      const origStart = inner.start.bind(inner);
      const origStop = inner.stop.bind(inner);
      const origSetFps = inner.setFps.bind(inner);

      inner.start = () => {
        self.startCalls++;
        origStart();
      };
      inner.stop = () => {
        self.stopCalls++;
        origStop();
      };
      inner.setFps = (fps: number) => {
        self.setFpsCalls.push(fps);
        origSetFps(fps);
      };

      return inner;
    },
  };

  return self;
}

function baseOptions(
  overrides: Partial<TrackingLoopOptions> = {},
): TrackingLoopOptions & { emits: OverlayUpdatePingPositionPayload[] } {
  const emits: OverlayUpdatePingPositionPayload[] = [];
  return {
    pingTracker: new PingTracker(),
    confidence: new ConfidenceEstimator(),
    emitPositionUpdate: (p) => emits.push(p),
    getMaskRegions: () => [],
    getFovH: () => 70,
    getFovV: () => 43,
    getPixelsPerDegree: () => 8,
    getMousePixelsPerDegree: () => 8,
    getOverlayBounds: () => ({ width: 1920, height: 1080 }),
    // Skip native OpenCV warmup in tests
    _warmup: async () => {},
    ...overrides,
    emits,
  } as TrackingLoopOptions & { emits: OverlayUpdatePingPositionPayload[] };
}

describe('TrackingLoop', () => {
  it('start() causes captureLoop.start() to be called', async () => {
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({ _CaptureLoopFactory: fake.factory });
    const loop = new TrackingLoop(opts);

    loop.start();
    await wait(20); // wait for warmup + factory invocation

    assert.equal(fake.startCalls, 1, 'captureLoop.start() should be called once');
    assert.ok(loop.isRunning());
    loop.stop();
  });

  it('stop() causes captureLoop.stop() and clears prevFrame', async () => {
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({ _CaptureLoopFactory: fake.factory });
    const loop = new TrackingLoop(opts);

    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);

    loop.stop();

    assert.ok(!loop.isRunning());
    assert.equal(fake.stopCalls, 1, 'captureLoop.stop() should be called once');

    // After restart, a single frame must not call estimateMotion (prevFrame cleared)
    const estimateCalls: unknown[] = [];
    const fake2 = makeFakeLoopFactory();
    const opts2 = baseOptions({
      _CaptureLoopFactory: fake2.factory,
      _estimateMotion: (...args) => {
        estimateCalls.push(args);
        return null;
      },
    });
    const loop2 = new TrackingLoop(opts2);
    loop2.start();
    await wait(20);

    fake2.fireFrame(FRAME_A);
    await wait(5);

    assert.equal(estimateCalls.length, 0, 'no estimateMotion on first frame after stop+restart');
    loop2.stop();
  });

  it('frame pair → estimateMotion called → applyOpticalFlow called', async () => {
    const pingTracker = new PingTracker();
    const applyFlowCalls: FlowEstimate[] = [];
    const origApply = pingTracker.applyOpticalFlow.bind(pingTracker);
    pingTracker.applyOpticalFlow = (flow) => {
      applyFlowCalls.push(flow);
      return origApply(flow);
    };

    const fakeMotion: MotionResult = {
      yawDelta: 1.0,
      pitchDelta: 0.5,
      confidence: 0.9,
      inlierCount: 50,
      dxPx: -8.0,
      dyPx: -4.0,
    };
    const estimateCalls: unknown[][] = [];

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: (...args) => {
        estimateCalls.push(args as unknown[]);
        return fakeMotion;
      },
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A); // sets prevFrame, no estimateMotion
    await wait(5);
    assert.equal(estimateCalls.length, 0);

    fake.fireFrame(FRAME_B); // triggers estimateMotion
    await wait(5);

    assert.equal(estimateCalls.length, 1, 'estimateMotion should be called on second frame');
    assert.equal(
      applyFlowCalls.length,
      1,
      'applyOpticalFlow should be called when motion is non-null',
    );
    loop.stop();
  });

  it('frame pair with motion=null does not apply trusted optical motion', async () => {
    const pingTracker = new PingTracker();
    const applyMotionCalls: unknown[] = [];
    const orig = pingTracker.applyMotion.bind(pingTracker);
    pingTracker.applyMotion = (m) => {
      applyMotionCalls.push(m);
      orig(m);
    };

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => null,
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(applyMotionCalls.length, 0, 'applyMotion must not be called when motion is null');
    loop.stop();
  });

  it('low-confidence motion fades instead of applying a wrong yaw update', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('low-conf', 960, 540, 1920, 1080, 70, 43, 10000);

    const applyMotionCalls: unknown[] = [];
    const origApply = pingTracker.applyMotion.bind(pingTracker);
    pingTracker.applyMotion = (m) => {
      applyMotionCalls.push(m);
      origApply(m);
    };

    const confidence = new ConfidenceEstimator();
    confidence.score = () => 0.0;

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      confidence,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => ({
        yawDelta: 20,
        pitchDelta: 0,
        confidence: 1,
        inlierCount: 100,
        dxPx: -160,
        dyPx: 0,
      }),
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(applyMotionCalls.length, 0, 'bad motion should not move ping bearings');
    const ping = pingTracker.getPing('low-conf')!;
    assert.ok(ping.confidence < 1, 'bad motion should fade confidence');
    assert.equal(tidy(pingTracker.getYawDeg()), 0, 'low-confidence flow must not move yaw');
    loop.stop();
  });

  it('direct mouse movement updates ping projection immediately', () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('mouse-direct', 960, 540, 1920, 1080, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
    });

    const loop = new TrackingLoop(opts);
    const applied = loop.applyMouseDelta(80, 0);

    assert.equal(applied, true);
    assert.equal(tidy(pingTracker.getYawDeg()), 10);
    assert.equal(pingTracker.getPing('mouse-direct')!.bearingDeg, 0);
    assert.ok(emits.length >= 1, 'direct mouse movement should emit an immediate overlay update');
    assert.ok(emits.at(-1)!.screenX < 960, 'ping should move left as yaw turns right');
  });

  it('direct vertical mouse movement updates ping projection immediately', () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('mouse-direct-y', 960, 540, 1920, 1080, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
    });

    const loop = new TrackingLoop(opts);
    const applied = loop.applyMouseDelta(0, -80);

    assert.equal(applied, true);
    assert.equal(tidy(pingTracker.getPitchDeg()), 10);
    assert.equal(pingTracker.getPing('mouse-direct-y')!.pitchBearingDeg, 0);
    assert.ok(emits.length >= 1, 'direct vertical mouse movement should emit immediately');
    assert.ok(emits.at(-1)!.screenY > 540, 'ping should move down as camera pitches up');
  });

  it('screen-only mode ignores direct mouse movement', () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('screen-only-mouse', 960, 540, 1920, 1080, 70, 43, 10000);

    const opts = baseOptions({ pingTracker, mouseTrackingEnabled: false });
    const loop = new TrackingLoop(opts);

    assert.equal(loop.applyMouseDelta(80, 0), false);
    assert.equal(pingTracker.getYawDeg(), 0);
    assert.equal(opts.confidence.getAccumulatedDelta().eventCount, 0);
    assert.equal(opts.emits.length, 0);
  });

  it('matching optical flow validates direct mouse movement without double-applying it', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('mouse', 960, 540, 1920, 1080, 70, 43, 10000);

    const estimateCalls: unknown[][] = [];

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: (...args) => {
        estimateCalls.push(args as unknown[]);
        return {
          yawDelta: 10,
          pitchDelta: 0,
          confidence: 1,
          inlierCount: 100,
          dxPx: -80,
          dyPx: 0,
        };
      },
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);
    assert.equal(loop.applyMouseDelta(80, 0), true);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(estimateCalls.length, 1, 'optical flow should still run as validation');
    assert.equal(
      (estimateCalls[0]![5] as { expectedYawDeltaDeg?: number }).expectedYawDeltaDeg,
      10,
    );
    assert.equal(tidy(pingTracker.getYawDeg()), 10, 'matching flow must not double-apply yaw');
    loop.stop();
  });

  it('post-calibration visual motion follows spectated camera movement without mouse input', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('spectator', 960, 540, 1920, 1080, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => ({
        yawDelta: 10,
        pitchDelta: 0,
        confidence: 1,
        inlierCount: 100,
        dxPx: -80,
        dyPx: 0,
      }),
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      captureLoop: TrackingCaptureLoop | null;
    };
    internals._opticalFinished = true;

    fake.fireFrame(FRAME_A);
    await wait(5);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(tidy(pingTracker.getYawDeg()), 10);
    assert.ok(emits.at(-1)!.screenX < 960, 'ping should move with optical camera motion');
    assert.equal(emits.at(-1)!.trackingMode, 'optical');
    loop.stop();
  });

  it('screen-only mode applies optical motion immediately without mouse calibration', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('screen-only-optical', 960, 540, 1920, 1080, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
      mouseTrackingEnabled: false,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => ({
        yawDelta: 8,
        pitchDelta: 0,
        confidence: 1,
        inlierCount: 100,
        dxPx: -64,
        dyPx: 0,
      }),
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(tidy(pingTracker.getYawDeg()), 8);
    assert.ok(emits.at(-1)!.screenX < 960, 'screen-only optical motion should move the ping');
    assert.equal(emits.at(-1)!.trackingMode, 'optical');
    loop.stop();
  });

  it('screen-only mode accepts high-confidence patch motion with few grid matches', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('screen-only-patch', 960, 540, 1920, 1080, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
      mouseTrackingEnabled: false,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => ({
        yawDelta: 6,
        pitchDelta: 0,
        confidence: 0.78,
        inlierCount: 6,
        dxPx: -48,
        dyPx: 0,
        model: 'patch-rotation',
        residualDeg: 0.7,
      }),
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(tidy(pingTracker.getYawDeg()), 6);
    assert.equal(emits.at(-1)!.trackingMode, 'optical');
    loop.stop();
  });

  it('keyboard movement marks visual updates and increases local lock cadence', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('keyboard-cadence', 960, 540, 1920, 1080, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => null,
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      _lastLocalVisualLockAtNs: number;
    };
    internals._opticalFinished = true;

    await fake.fireFrameAsync({ ...FRAME_A, capturedAtNs: 1_000 * NS_PER_MS });
    assert.equal(internals._lastLocalVisualLockAtNs, 1_000 * NS_PER_MS);

    loop.applyKeyboardState(KEYBOARD_FORWARD, 1_005 * NS_PER_MS);
    await fake.fireFrameAsync({ ...FRAME_B, capturedAtNs: 1_030 * NS_PER_MS });

    assert.equal(
      internals._lastLocalVisualLockAtNs,
      1_030 * NS_PER_MS,
      'keyboard movement should shorten the local visual-lock interval',
    );
    assert.equal(emits.at(-1)!.trackingMode, 'keyboard');
    loop.stop();
  });

  it('keyboard movement limits no-mouse optical yaw and relies on visual evidence', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('keyboard-optical', 960, 540, 1920, 1080, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => ({
        yawDelta: 10,
        pitchDelta: 0,
        confidence: 1,
        inlierCount: 100,
        dxPx: -80,
        dyPx: 0,
      }),
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const internals = loop as unknown as { _opticalFinished: boolean };
    internals._opticalFinished = true;

    await fake.fireFrameAsync({ ...FRAME_A, capturedAtNs: 1_000 * NS_PER_MS });
    loop.applyKeyboardState(KEYBOARD_FORWARD, 1_005 * NS_PER_MS);
    await fake.fireFrameAsync({ ...FRAME_B, capturedAtNs: 1_040 * NS_PER_MS });

    assert.ok(
      pingTracker.getYawDeg() > 0 && pingTracker.getYawDeg() < 4,
      `keyboard movement should not let global optical flow fully drive yaw, got ${pingTracker.getYawDeg()}`,
    );
    assert.equal(emits.at(-1)!.trackingMode, 'keyboard');
    loop.stop();
  });

  it('post-calibration mouse tracking is partially corrected by same-direction optical flow', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('post-cal-mouse', 960, 540, 1920, 1080, 70, 43, 10000);

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => ({
        yawDelta: 14,
        pitchDelta: 0,
        confidence: 1,
        inlierCount: 100,
        dxPx: -112,
        dyPx: 0,
      }),
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      captureLoop: TrackingCaptureLoop | null;
    };
    internals._opticalFinished = true;

    fake.fireFrame(FRAME_A);
    await wait(5);
    assert.equal(loop.applyMouseDelta(80, 0), true);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.ok(pingTracker.getYawDeg() > 10, `yaw ${pingTracker.getYawDeg()} should correct up`);
    assert.ok(pingTracker.getYawDeg() < 14, `yaw ${pingTracker.getYawDeg()} should not snap`);
    loop.stop();
  });

  it('post-calibration recent mouse prediction throttles optical estimation work', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('throttle', 960, 540, 1920, 1080, 70, 43, 10000);

    const estimateCalls: number[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => {
        estimateCalls.push(Date.now());
        return {
          yawDelta: 10,
          pitchDelta: 0,
          confidence: 1,
          inlierCount: 100,
          dxPx: -80,
          dyPx: 0,
        };
      },
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      captureLoop: TrackingCaptureLoop | null;
    };
    internals._opticalFinished = true;

    fake.fireFrame({ ...FRAME_A, capturedAtNs: 1_000 * NS_PER_MS });
    await wait(5);
    assert.equal(loop.applyMouseDelta(80, 0, 1_005 * NS_PER_MS), true);
    fake.fireFrame({ ...FRAME_B, capturedAtNs: 1_010 * NS_PER_MS });
    await wait(5);
    fake.fireFrame({ ...FRAME_A, capturedAtNs: 1_050 * NS_PER_MS });
    await wait(5);
    fake.fireFrame({ ...FRAME_B, capturedAtNs: 1_125 * NS_PER_MS });
    await wait(5);

    assert.equal(
      estimateCalls.length,
      3,
      'optical should run initially, skip sub-33ms frames, then run at high correction cadence',
    );
    loop.stop();
  });

  it('cancelling mouse movement allows optical flow to nudge yaw only slightly', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('optical', 960, 540, 1920, 1080, 70, 43, 10000);

    const confidence = new ConfidenceEstimator();
    const estimateCalls: unknown[][] = [];

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      confidence,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: (...args) => {
        estimateCalls.push(args as unknown[]);
        return {
          yawDelta: 5,
          pitchDelta: 0,
          confidence: 1,
          inlierCount: 100,
          dxPx: -40,
          dyPx: 0,
        };
      },
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);
    confidence.recordMouseDelta(20, 0);
    confidence.recordMouseDelta(-20, 0);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(estimateCalls.length, 1, 'cancelled mouse movement should not block optical flow');
    assert.equal(tidy(pingTracker.getYawDeg()), 0.32);
    const projection = pingTracker.projectAll(Date.now(), 1920, 1080, 70, 43)[0]!;
    assert.ok(projection.screenX < 960);
    loop.stop();
  });

  it('post-calibration tiny visual jitter with no mouse input does not drift the ping', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('still-optical', 960, 540, 1920, 1080, 70, 43, 10000);

    const motions = [0.05, -0.04, 0.03, -0.05, 0.02];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => {
        const yawDelta = motions.shift() ?? 0;
        return {
          yawDelta,
          pitchDelta: 0,
          confidence: 1,
          inlierCount: 100,
          dxPx: -yawDelta * 8,
          dyPx: 0,
          residualDeg: 0.1,
        };
      },
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      captureLoop: TrackingCaptureLoop | null;
    };
    internals._opticalFinished = true;

    fake.fireFrame(FRAME_A);
    await wait(5);
    for (let i = 0; i < 5; i++) {
      fake.fireFrame(i % 2 === 0 ? FRAME_B : FRAME_A);
      await wait(5);
    }

    assert.equal(tidy(pingTracker.getYawDeg()), 0);
    const projection = pingTracker.projectAll(Date.now(), 1920, 1080, 70, 43)[0]!;
    assert.ok(Math.abs(projection.screenX - 960) < 1);
    loop.stop();
  });

  it('post-calibration mouse tracking ignores sub-deadzone optical disagreement', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('mouse-deadzone', 960, 540, 1920, 1080, 70, 43, 10000);

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => ({
        yawDelta: 10.2,
        pitchDelta: 0,
        confidence: 1,
        inlierCount: 100,
        dxPx: -81.6,
        dyPx: 0,
        residualDeg: 0.1,
      }),
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const internals = loop as unknown as { _opticalFinished: boolean };
    internals._opticalFinished = true;

    fake.fireFrame(FRAME_A);
    await wait(5);
    assert.equal(loop.applyMouseDelta(80, 0), true);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(tidy(pingTracker.getYawDeg()), 10);
    loop.stop();
  });

  it('high-residual optical motion is rejected instead of moving the ping', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('bad-residual', 960, 540, 1920, 1080, 70, 43, 10000);

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => ({
        yawDelta: 6,
        pitchDelta: 0,
        confidence: 1,
        inlierCount: 120,
        dxPx: -48,
        dyPx: 0,
        residualDeg: 2.5,
      }),
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const internals = loop as unknown as { _opticalFinished: boolean };
    internals._opticalFinished = true;

    fake.fireFrame(FRAME_A);
    await wait(5);
    fake.fireFrame(FRAME_B);
    await wait(5);

    assert.equal(tidy(pingTracker.getYawDeg()), 0);
    loop.stop();
  });

  it('default surface tracking does not mutate global yaw', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('patch', 110, 70, 220, 140, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
      getOverlayBounds: () => ({ width: 220, height: 140 }),
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => null,
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const frameA = { ...makePatchFrame(220, 140), capturedAtNs: 1_000 * NS_PER_MS };
    const frameB = { ...makePatchFrame(220, 140), capturedAtNs: 1_060 * NS_PER_MS };
    const frameC = { ...makePatchFrame(220, 140), capturedAtNs: 1_120 * NS_PER_MS };
    drawScenePattern(frameA, 110, 70);
    drawScenePattern(frameB, 124, 70);
    drawScenePattern(frameC, 124, 70);

    await fake.fireFrameAsync(frameA);
    await fake.fireFrameAsync(frameB);
    await fake.fireFrameAsync(frameC);

    assert.equal(tidy(pingTracker.getYawDeg()), 0);
    const last = emits.at(-1)!;
    assert.ok(Number.isFinite(last.screenX));
    assert.ok(Number.isFinite(last.screenY));
    loop.stop();
  });

  it('legacy visual patch opt-in no longer mutates global yaw', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('patch-opt-in', 110, 70, 220, 140, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
      enableVisualPatchCorrection: true,
      getOverlayBounds: () => ({ width: 220, height: 140 }),
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => null,
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    const frameA = makePatchFrame(220, 140);
    const frameB = makePatchFrame(220, 140);
    drawScenePattern(frameA, 110, 70);
    drawScenePattern(frameB, 124, 70);

    await fake.fireFrameAsync(frameA);
    await fake.fireFrameAsync(frameB);

    assert.equal(tidy(pingTracker.getYawDeg()), 0);
    assert.ok(Number.isFinite(emits.at(-1)!.screenX));
    loop.stop();
  });

  it('projectAll called per frame → emitPositionUpdate fires for active ping', async () => {
    const pingTracker = new PingTracker();
    pingTracker.addPing('test-ping', 960, 540, 1920, 1080, 70, 43, 10000);

    const emits: OverlayUpdatePingPositionPayload[] = [];
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      pingTracker,
      emitPositionUpdate: (p) => emits.push(p),
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => null,
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);

    assert.ok(emits.length >= 1, 'emitPositionUpdate should fire for the active ping');
    assert.equal(emits[0]!.id, 'test-ping');
    assert.equal(emits[0]!.trackingMethod, 'prediction');
    assert.equal(emits[0]!.surfaceLockKind, 'unknown');
    assert.equal(typeof emits[0]!.surfaceConfidence, 'number');
    loop.stop();
  });

  it('frame budget exceeded → captureLoop steps down from 60fps to 30fps', async () => {
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => {
        // Simulate slow processing (> 67ms budget threshold)
        const end = Date.now() + 80;
        while (Date.now() < end) {
          /* spin */
        }
        return null;
      },
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    // First frame sets prevFrame (no estimateMotion call)
    fake.fireFrame(FRAME_A);
    await wait(5);

    // 3 consecutive slow frames (each triggers estimateMotion with 80ms spin)
    for (let i = 0; i < 3; i++) {
      fake.fireFrame(i % 2 === 0 ? FRAME_B : FRAME_A);
      await wait(150); // give async handleFrame time to complete
    }

    assert.ok(
      fake.setFpsCalls.includes(30),
      `setFps(30) should have been called; calls=${JSON.stringify(fake.setFpsCalls)}`,
    );
    loop.stop();
  });

  it('confidence.score called between estimateMotion and applyOpticalFlow', async () => {
    const confidence = new ConfidenceEstimator();
    const callOrder: string[] = [];

    const origScore = confidence.score.bind(confidence);
    confidence.score = (...args) => {
      callOrder.push('score');
      return origScore(...args);
    };

    const pingTracker = new PingTracker();
    const origApply = pingTracker.applyOpticalFlow.bind(pingTracker);
    pingTracker.applyOpticalFlow = (flow) => {
      callOrder.push('applyOpticalFlow');
      return origApply(flow);
    };

    const fakeMotion: MotionResult = {
      yawDelta: 0.5,
      pitchDelta: 0.2,
      confidence: 0.8,
      inlierCount: 40,
      dxPx: -4.0,
      dyPx: -1.6,
    };

    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      confidence,
      pingTracker,
      _CaptureLoopFactory: fake.factory,
      _estimateMotion: () => {
        callOrder.push('estimateMotion');
        return fakeMotion;
      },
    });

    const loop = new TrackingLoop(opts);
    loop.start();
    await wait(20);

    fake.fireFrame(FRAME_A);
    await wait(5);
    fake.fireFrame(FRAME_B);
    await wait(5);

    const estimateIdx = callOrder.indexOf('estimateMotion');
    const scoreIdx = callOrder.indexOf('score');
    const applyIdx = callOrder.indexOf('applyOpticalFlow');

    assert.ok(estimateIdx >= 0, 'estimateMotion should have been called');
    assert.ok(scoreIdx > estimateIdx, 'confidence.score should be called after estimateMotion');
    assert.ok(applyIdx > scoreIdx, 'applyOpticalFlow should be called after confidence.score');
    loop.stop();
  });

  it('start() when already running is a no-op', async () => {
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({ _CaptureLoopFactory: fake.factory });
    const loop = new TrackingLoop(opts);

    loop.start();
    await wait(20);
    loop.start(); // second call should be no-op

    assert.equal(fake.startCalls, 1, 'captureLoop.start() should only be called once');
    loop.stop();
  });

  it('notifyPingAdded restarts visual-motion capture after optical calibration has gone idle', async () => {
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({
      _CaptureLoopFactory: fake.factory,
    });
    const loop = new TrackingLoop(opts);

    loop.start();
    await wait(20);
    assert.equal(fake.startCalls, 1);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      captureLoop: TrackingCaptureLoop | null;
    };
    internals._opticalFinished = true;
    internals.captureLoop?.stop();
    internals.captureLoop = null;
    opts.pingTracker.addPing('late-ping', 960, 540, 1920, 1080, 70, 43, 10000);

    loop.notifyPingAdded();
    await wait(20);

    assert.equal(fake.startCalls, 2, 'visual motion should restart capture for active pings');
    loop.stop();
  });

  it('post-calibration idle keeps capture warm at low fps instead of stopping', async () => {
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({ _CaptureLoopFactory: fake.factory });
    const loop = new TrackingLoop(opts);

    loop.start();
    await wait(20);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      captureLoop: TrackingCaptureLoop | null;
    };
    internals._opticalFinished = true;

    fake.fireFrame(FRAME_A);
    await wait(5);

    assert.ok(fake.setFpsCalls.includes(2), 'idle visual capture should step down to 2fps');
    assert.notEqual(internals.captureLoop, null, 'idle visual capture should stay warm');
    loop.stop();
  });

  it('notifyPingAdded ramps warm idle capture to active visual fps', async () => {
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({ _CaptureLoopFactory: fake.factory });
    const loop = new TrackingLoop(opts);

    loop.start();
    await wait(20);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      _currentFps: number;
    };
    internals._opticalFinished = true;
    internals._currentFps = 2;
    opts.pingTracker.addPing('warm-ping', 960, 540, 1920, 1080, 70, 43, 10000);

    loop.notifyPingAdded();
    await wait(5);

    assert.ok(fake.setFpsCalls.includes(60), 'active pings should use active visual fps');
    assert.equal(fake.startCalls, 1, 'warm capture should not be restarted');
    loop.stop();
  });

  it('notifyPingAdded does not restart capture when no active ping exists', async () => {
    const fake = makeFakeLoopFactory();
    const opts = baseOptions({ _CaptureLoopFactory: fake.factory });
    const loop = new TrackingLoop(opts);

    loop.start();
    await wait(20);
    assert.equal(fake.startCalls, 1);

    const internals = loop as unknown as {
      _opticalFinished: boolean;
      captureLoop: TrackingCaptureLoop | null;
    };
    internals._opticalFinished = true;
    internals.captureLoop?.stop();
    internals.captureLoop = null;

    loop.notifyPingAdded();
    await wait(20);

    assert.equal(fake.startCalls, 1, 'visual motion capture should wait for an active ping');
    loop.stop();
  });

  it('stop() when not running is a no-op', () => {
    const opts = baseOptions();
    const loop = new TrackingLoop(opts);
    assert.doesNotThrow(() => loop.stop());
    assert.ok(!loop.isRunning());
  });
});

function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function makePatchFrame(width: number, height: number): GrayFrame {
  return {
    width,
    height,
    buffer: Buffer.alloc(width * height, 24),
    rgbBuffer: Buffer.alloc(width * height * 3, 24),
  };
}

function drawScenePattern(frame: GrayFrame, cx: number, cy: number): void {
  for (let y = -30; y <= 30; y++) {
    for (let x = -30; x <= 30; x++) {
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
      const value = 45 + ((x * 17 + y * 31 + x * y * 7 + x * x * 3 + y * y * 5 + 4096) % 185);
      const idx = py * frame.width + px;
      frame.buffer[idx] = value;
      if (frame.rgbBuffer) {
        frame.rgbBuffer[idx * 3] = 190;
        frame.rgbBuffer[idx * 3 + 1] = 72;
        frame.rgbBuffer[idx * 3 + 2] = 54;
      }
    }
  }
}

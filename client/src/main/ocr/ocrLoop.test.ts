import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OcrLoop, WorkerLike } from './ocrLoop.js';
import { ScreenCaptureError } from './screenCapture.js';

// ---- fake worker ----

type AnyHandler = (...args: unknown[]) => void;

interface FakeWorker extends WorkerLike {
  _messageHandlers: AnyHandler[];
  _terminated: boolean;
  _autoReply: ((id: string) => { text: string; confidence: number } | { error: string }) | null;
  _emit(msg: unknown): void;
  _emitError(err: Error): void;
  _emitExit(code: number): void;
}

function makeFakeWorker(): FakeWorker {
  const w: FakeWorker = {
    _messageHandlers: [],
    _terminated: false,
    _autoReply: null,

    postMessage(msg: unknown) {
      if (this._autoReply) {
        const m = msg as { id: string; buffer: Buffer };
        const reply = this._autoReply(m.id);
        // Defer to next microtask so _pending.set has already run
        Promise.resolve().then(() => {
          if (!this._terminated) {
            this._emit({ id: m.id, ...reply });
          }
        });
      }
    },

    terminate() {
      this._terminated = true;
    },

    on(event: string, handler: unknown) {
      if (event === 'message') this._messageHandlers.push(handler as AnyHandler);
      return this;
    },

    off(event: string, handler: unknown) {
      if (event === 'message') {
        const idx = this._messageHandlers.indexOf(handler as AnyHandler);
        if (idx !== -1) this._messageHandlers.splice(idx, 1);
      }
      return this;
    },

    _emit(msg: unknown) {
      for (const h of [...this._messageHandlers]) h(msg);
    },

    _emitError(err: Error) {
      // error handlers not tracked separately here — emit via message for test simplicity
      void err;
    },

    _emitExit(code: number) {
      void code;
    },
  };
  return w;
}

// ---- helpers ----

const FAKE_BUFFER = Buffer.from('fake');

function makeLoop(overrides: {
  onDetected?: (u: string, c: number) => void;
  onLost?: () => void;
  capture?: () => Promise<Buffer>;
  autoReply?: (id: string) => { text: string; confidence: number } | { error: string };
}): { loop: OcrLoop; worker: FakeWorker } {
  const worker = makeFakeWorker();
  if (overrides.autoReply) worker._autoReply = overrides.autoReply;

  const loop = new OcrLoop({
    workerScriptPath: '/fake/worker.js',
    langPath: '/fake/lang',
    onDetected: overrides.onDetected ?? (() => {}),
    onLost: overrides.onLost ?? (() => {}),
    _captureAndDownscale: overrides.capture ?? (() => Promise.resolve(FAKE_BUFFER)),
    _WorkerFactory: () => worker,
  });
  return { loop, worker };
}

// Fires the ready signal so the interval starts, then calls _tick() directly.
async function startAndTick(
  loop: OcrLoop,
  worker: FakeWorker,
  peerUsername: string,
): Promise<void> {
  loop.start(peerUsername);
  worker._emit({ type: 'ready' });
  // Let the readyPromise.then() queue, then one more microtask to start interval
  await Promise.resolve();
  await Promise.resolve();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private for testing
  await (loop as any)._tick();
}

// Tick without restarting
async function tick(loop: OcrLoop): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private for testing
  await (loop as any)._tick();
}

// ---- tests ----

describe('OcrLoop', () => {
  it('test 1: detects on first matching tick', async () => {
    const detected: Array<{ username: string; confidence: number }> = [];
    const { loop, worker } = makeLoop({
      onDetected: (u, c) => detected.push({ username: u, confidence: c }),
      autoReply: () => ({ text: 'Spectating: Vincent_Feng', confidence: 90 }),
    });

    await startAndTick(loop, worker, 'Vincent_Feng');

    assert.equal(detected.length, 1);
    const first = detected[0];
    assert.ok(first !== undefined);
    assert.equal(first.username, 'Vincent_Feng');
    assert.ok(first.confidence >= 0 && first.confidence <= 1);
    loop.stop();
  });

  it('test 2: second tick with match does not re-fire onDetected (de-dupe)', async () => {
    const detected: Array<{ username: string }> = [];
    const { loop, worker } = makeLoop({
      onDetected: (u) => detected.push({ username: u }),
      autoReply: () => ({ text: 'Spectating: Vincent_Feng', confidence: 90 }),
    });

    await startAndTick(loop, worker, 'Vincent_Feng');
    await tick(loop);

    assert.equal(detected.length, 1);
    loop.stop();
  });

  it('test 3: 4 miss ticks after detection do not fire onLost (under 5s)', async () => {
    const lost: number[] = [];
    const { loop, worker } = makeLoop({
      onLost: () => lost.push(1),
      autoReply: (id) => {
        void id;
        return { text: 'Spectating: Vincent_Feng', confidence: 90 };
      },
    });

    await startAndTick(loop, worker, 'Vincent_Feng');

    // Switch to miss replies
    worker._autoReply = () => ({ text: '', confidence: 90 });

    // 4 miss ticks — all happen within the same ms window, no 5s elapsed
    for (let i = 0; i < 4; i++) {
      await tick(loop);
    }

    assert.equal(lost.length, 0);
    loop.stop();
  });

  it('test 4: misses for >5s after detection fire onLost once', async () => {
    const lost: number[] = [];
    const { loop, worker } = makeLoop({
      onLost: () => lost.push(1),
      autoReply: () => ({ text: 'Spectating: Vincent_Feng', confidence: 90 }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- manipulate private time for testing
    const loopAny = loop as any;

    await startAndTick(loop, worker, 'Vincent_Feng');

    // Switch to miss replies
    worker._autoReply = () => ({ text: '', confidence: 90 });

    // First miss — sets firstMissAt
    await tick(loop);
    assert.ok(loopAny._firstMissAt !== null, 'firstMissAt should be set after first miss');

    // Backdate firstMissAt by 6 seconds so next miss triggers onLost
    loopAny._firstMissAt = Date.now() - 6000;

    await tick(loop);

    assert.equal(lost.length, 1);
    loop.stop();
  });

  it('test 5: updatePeerUsername("") resets state silently, no onLost', async () => {
    const lost: number[] = [];
    const { loop, worker } = makeLoop({
      onLost: () => lost.push(1),
      autoReply: () => ({ text: 'Spectating: Vincent_Feng', confidence: 90 }),
    });

    await startAndTick(loop, worker, 'Vincent_Feng');

    loop.updatePeerUsername('');

    // tick should skip since peerUsername is ''
    await tick(loop);

    assert.equal(lost.length, 0);
    loop.stop();
  });

  it('test 6: ScreenCaptureError causes skip, no onDetected/onLost, no unhandled rejection', async () => {
    const detected: number[] = [];
    const lostCalls: number[] = [];
    const { loop, worker } = makeLoop({
      onDetected: () => detected.push(1),
      onLost: () => lostCalls.push(1),
      capture: () => {
        throw new ScreenCaptureError('no screen');
      },
    });

    loop.start('Vincent_Feng');
    worker._emit({ type: 'ready' });
    await Promise.resolve();
    await Promise.resolve();

    await assert.doesNotReject(() => tick(loop));

    assert.equal(detected.length, 0);
    assert.equal(lostCalls.length, 0);
    loop.stop();
  });

  it('test 7: worker error response logs and continues, no events', async () => {
    const detected: number[] = [];
    const lostCalls: number[] = [];
    const { loop, worker } = makeLoop({
      onDetected: () => detected.push(1),
      onLost: () => lostCalls.push(1),
      autoReply: () => ({ error: 'recognize failed' }),
    });

    await startAndTick(loop, worker, 'Vincent_Feng');

    assert.equal(detected.length, 0);
    assert.equal(lostCalls.length, 0);
    loop.stop();
  });

  it('test 8: stop() while running clears interval and terminates worker', async () => {
    const { loop, worker } = makeLoop({
      autoReply: () => ({ text: 'Spectating: Vincent_Feng', confidence: 90 }),
    });

    loop.start('Vincent_Feng');
    worker._emit({ type: 'ready' });
    await Promise.resolve();
    await Promise.resolve();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private for testing
    const loopAny = loop as any;
    assert.ok(loopAny._worker !== null);

    loop.stop();

    assert.ok(worker._terminated);
    assert.equal(loopAny._worker, null);
    assert.equal(loopAny._interval, null);

    // After stop, peerUsername is '', tick should be a no-op
    await tick(loop);
  });
});

import { Worker } from 'node:worker_threads';
import { captureAndDownscale, ScreenCaptureError } from './screenCapture.js';

export type OcrLoopOptions = {
  workerScriptPath: string;
  langPath: string;
  onDetected: (username: string, confidence: number) => void;
  onLost: () => void;
  // Injectable for tests — omit in production
  _captureAndDownscale?: () => Promise<Buffer>;
  _WorkerFactory?: (script: string, opts: { workerData: unknown }) => WorkerLike;
};

// Minimal interface satisfied by both the real Worker and test fakes
export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  on(event: 'message', handler: (msg: unknown) => void): this;
  on(event: 'error', handler: (err: Error) => void): this;
  on(event: 'exit', handler: (code: number) => void): this;
  off(event: 'message', handler: (msg: unknown) => void): this;
}

type WorkerResponse =
  | { id: string; text: string; confidence: number }
  | { id: string; error: string };

type OcrState = 'idle' | 'tracking';

const WORKER_TIMEOUT_MS = 5000;
const SLOW_WARN_MS = 2000;
const LOST_DEBOUNCE_MS = 5000;
const TICK_INTERVAL_MS = 1000;
const DETECTION_THRESHOLD = 0.7;

export class OcrLoop {
  private readonly _options: OcrLoopOptions;
  private readonly _capture: () => Promise<Buffer>;
  private readonly _WorkerFactory: (script: string, opts: { workerData: unknown }) => WorkerLike;

  private _worker: WorkerLike | null = null;
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _peerUsername = '';
  private _state: OcrState = 'idle';
  private _firstMissAt: number | null = null;
  private _pending = new Map<string, (response: WorkerResponse) => void>();
  private _counter = 0;

  constructor(options: OcrLoopOptions) {
    this._options = options;
    this._capture = options._captureAndDownscale ?? captureAndDownscale;
    this._WorkerFactory =
      options._WorkerFactory ??
      ((script, opts) => new Worker(script, opts) as unknown as WorkerLike);
  }

  start(peerUsername: string): void {
    if (this._interval !== null) return;

    this._peerUsername = peerUsername;
    this._state = 'idle';
    this._firstMissAt = null;

    const worker = this._WorkerFactory(this._options.workerScriptPath, {
      workerData: { langPath: this._options.langPath },
    });
    this._worker = worker;

    worker.on('message', (msg: unknown) => {
      const m = msg as WorkerResponse & { type?: string };
      const resolver = this._pending.get(m.id);
      if (resolver) {
        this._pending.delete(m.id);
        resolver(m);
      }
    });

    worker.on('error', (err) => {
      console.warn('[ocrLoop] worker error:', err);
      this._clearPending();
      worker.terminate();
      if (this._worker === worker) this._worker = null;
      this._state = 'idle';
      this._firstMissAt = null;
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.warn('[ocrLoop] worker exited with code', code);
        this._clearPending();
        if (this._worker === worker) this._worker = null;
        this._state = 'idle';
        this._firstMissAt = null;
      }
    });

    // Wait for {type:'ready'} before starting the interval
    const readyPromise = new Promise<void>((resolve) => {
      const onMsg = (msg: unknown) => {
        const m = msg as { type?: string };
        if (m.type === 'ready') {
          worker.off('message', onMsg);
          resolve();
        }
      };
      worker.on('message', onMsg);
    });

    readyPromise.then(() => {
      this._interval = setInterval(() => {
        void this._tick();
      }, TICK_INTERVAL_MS);
    });
  }

  stop(): void {
    if (this._interval !== null) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._worker !== null) {
      this._worker.terminate();
      this._worker = null;
    }
    this._clearPending();
    this._state = 'idle';
    this._firstMissAt = null;
    this._peerUsername = '';
  }

  updatePeerUsername(name: string): void {
    this._peerUsername = name;
    if (name === '') {
      this._state = 'idle';
      this._firstMissAt = null;
    }
  }

  private _clearPending(): void {
    for (const [id, resolver] of this._pending) {
      resolver({ id, error: 'worker terminated' });
    }
    this._pending.clear();
  }

  private async _tick(): Promise<void> {
    if (this._peerUsername === '') return;

    let buffer: Buffer;
    try {
      buffer = await this._capture();
    } catch (err) {
      if (err instanceof ScreenCaptureError) {
        console.warn('[ocrLoop] screen capture failed:', err.message);
        return;
      }
      throw err;
    }

    if (this._worker === null) return;

    const id = String(++this._counter);
    const startMs = Date.now();

    const response = await new Promise<WorkerResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        resolve({ id, error: 'timeout' });
      }, WORKER_TIMEOUT_MS);

      this._pending.set(id, (res) => {
        clearTimeout(timeout);
        resolve(res);
      });

      this._worker!.postMessage({ id, buffer });
    });

    const elapsed = Date.now() - startMs;
    if (elapsed > SLOW_WARN_MS) {
      console.warn(`[ocrLoop] recognize took ${elapsed}ms (>2000ms), skipping state update`);
      return;
    }

    if ('error' in response) {
      console.warn('[ocrLoop] worker error response:', response.error);
      return;
    }

    const { text, confidence } = response;
    const matches = text.toLowerCase().includes(this._peerUsername.toLowerCase());
    const combined = (matches ? 1.0 : 0.0) * (confidence / 100);

    this._advanceState(combined, confidence);
  }

  private _advanceState(combined: number, confidence: number): void {
    const now = Date.now();

    if (this._state === 'idle') {
      if (combined > DETECTION_THRESHOLD) {
        this._options.onDetected(this._peerUsername, confidence / 100);
        this._state = 'tracking';
        this._firstMissAt = null;
      }
    } else {
      // tracking
      if (combined > DETECTION_THRESHOLD) {
        this._state = 'tracking';
        this._firstMissAt = null;
      } else {
        if (this._firstMissAt === null) {
          this._firstMissAt = now;
        } else if (now - this._firstMissAt >= LOST_DEBOUNCE_MS) {
          this._options.onLost();
          this._state = 'idle';
          this._firstMissAt = null;
        }
      }
    }
  }
}

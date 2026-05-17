import {
  captureAndDownscaleGray480p,
  ScreenCaptureError,
  type GrayFrame,
} from '../ocr/screenCapture.js';
import { MacScreenCaptureLoop } from './macos-screen-capture.js';

export type { GrayFrame };

export type TrackingCaptureLoopOptions = {
  fps?: number;
  includeRgbBuffer?: boolean;
  targetHeight?: number;
  onFrame: (frame: GrayFrame) => void | Promise<void>;
  onError?: (err: Error) => void;
  // Injectable for tests — omit in production
  _captureFn?: () => Promise<GrayFrame>;
};

export type TrackingFrameLoop = {
  start(): void;
  stop(): void;
  setFps(fps: number): void;
  isRunning(): boolean;
};

const DEFAULT_FPS = 15;
const MIN_FPS = 1;
const MAX_FPS = 60;
const DEFAULT_NATIVE_TARGET_HEIGHT = 540;
const FALLBACK_TARGET_HEIGHT = 480;
const FALLBACK_MAX_FPS = 30;

export class TrackingCaptureLoop implements TrackingFrameLoop {
  private readonly _onFrame: (frame: GrayFrame) => void | Promise<void>;
  private readonly _onError?: (err: Error) => void;
  private readonly _capture: () => Promise<GrayFrame>;

  private _fps: number;
  private _running = false;
  private _timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TrackingCaptureLoopOptions) {
    this._fps = Math.min(MAX_FPS, Math.max(MIN_FPS, options.fps ?? DEFAULT_FPS));
    this._onFrame = options.onFrame;
    this._onError = options.onError;
    this._capture =
      options._captureFn ??
      (() =>
        captureAndDownscaleGray480p({
          includeRgbBuffer: options.includeRgbBuffer,
          targetHeight: options.targetHeight,
        }));
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._schedule();
  }

  stop(): void {
    this._running = false;
    if (this._timeout !== null) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }

  setFps(fps: number): void {
    const clamped = Math.min(MAX_FPS, Math.max(MIN_FPS, fps));
    this._fps = clamped;
    if (this._running) {
      this.stop();
      this._running = true;
      this._schedule();
    }
  }

  isRunning(): boolean {
    return this._running;
  }

  private _schedule(): void {
    this._timeout = setTimeout(async () => {
      if (!this._running) return;
      await this._tick();
      if (this._running) this._schedule();
    }, 1000 / this._fps);
  }

  private async _tick(): Promise<void> {
    try {
      const frame = await this._capture();
      frame.capturedAtNs ??= Number(process.hrtime.bigint());
      frame.source ??= 'electron';
      await this._onFrame(frame);
    } catch (err) {
      if (err instanceof ScreenCaptureError) {
        // re-entrancy or missing source — skip this frame silently
        return;
      }
      this._onError?.(err as Error);
    }
  }
}

export function createTrackingFrameLoop(options: TrackingCaptureLoopOptions): TrackingFrameLoop {
  const nativeOptions = {
    ...options,
    targetHeight: options.targetHeight ?? DEFAULT_NATIVE_TARGET_HEIGHT,
  };
  const fallbackFactory = () =>
    new TrackingCaptureLoop({
      ...options,
      fps: Math.min(options.fps ?? DEFAULT_FPS, FALLBACK_MAX_FPS),
      targetHeight: Math.min(
        options.targetHeight ?? FALLBACK_TARGET_HEIGHT,
        FALLBACK_TARGET_HEIGHT,
      ),
    });
  if (process.platform !== 'darwin' || process.env.PYNG_DISABLE_NATIVE_CAPTURE === '1') {
    return fallbackFactory();
  }
  return new MacScreenCaptureLoop({
    ...nativeOptions,
    fallbackFactory,
  });
}

import type { NormalizedRect, OverlayUpdatePingPositionPayload, TrackingFps } from '@pyng/shared';
import { createTrackingFrameLoop, type GrayFrame, type TrackingFrameLoop } from './capture-loop.js';
import { warmup, estimateMotion } from './motion-estimator.js';
import type { MotionResult } from './motion-estimator.js';
import { ConfidenceEstimator } from './confidence.js';
import { PingTracker } from './ping-tracker.js';
import { MotionPredictor, monotonicNowNs } from './motion-predictor.js';
import { LocalPingAnchorTracker } from './local-ping-anchor-tracker.js';
import { NativeKcfAnchorTracker } from './native-kcf-anchor-tracker.js';
import { PingPositionFuser } from './ping-position-fuser.js';
import { SurfaceAnchorTracker } from './surface-anchor-tracker.js';
import type { SurfaceTrackerResult } from './surface-tracking-types.js';
import { VisualPatchCorrector, type VisualPatchCorrection } from './visual-patch-corrector.js';

export type TrackingLoopOptions = {
  pingTracker: PingTracker;
  confidence: ConfidenceEstimator;
  emitPositionUpdate: (payload: OverlayUpdatePingPositionPayload) => void;
  getMaskRegions: () => NormalizedRect[];
  getFovH: () => number;
  getFovV: () => number;
  getPixelsPerDegree: () => number;
  getMousePixelsPerDegree: () => number;
  getOverlayBounds: () => { width: number; height: number };
  getTrackingFps?: () => TrackingFps;
  getFovLearningEnabled?: () => boolean;
  mouseTrackingEnabled?: boolean;
  // Per-ping patch correction fallback. It stays local to the fuser and does
  // not mutate global yaw; set false to disable it for diagnostics.
  enableVisualPatchCorrection?: boolean;
  // Test injection
  _CaptureLoopFactory?: (
    onFrame: (frame: GrayFrame) => void | Promise<void>,
    onError: (e: Error) => void,
  ) => TrackingFrameLoop;
  _estimateMotion?: typeof estimateMotion;
  _warmup?: () => Promise<void>;
};

export type KeyboardTrackingState = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  horizontalAxis: number;
  verticalAxis: number;
  activeKeyCount: number;
  active: boolean;
};

const DEFAULT_FPS = 60;
const AUTO_FPS = 60;
const MID_STEPDOWN_FPS = 30;
const STEPDOWN_FPS = 15;
const BUDGET_WINDOW = 3;
const BUDGET_HISTORY = 5;
const MIN_APPLY_CONFIDENCE = 0.3;
const OPTICAL_ASSIST_WEIGHT = 0.08;
const VISUAL_ASSIST_FPS = 60;
const IDLE_VISUAL_ASSIST_FPS = 2;
const NO_MOUSE_VISUAL_BLEND_WEIGHT = 1;
const POST_CALIBRATION_MIN_OPTICAL_WEIGHT = 0.04;
const POST_CALIBRATION_MAX_OPTICAL_WEIGHT = 0.18;
const POST_CALIBRATION_DISAGREEMENT_DEG = 14;
const POST_CALIBRATION_WEIGHT_RANGE = 0.14;
const POST_CALIBRATION_CORRECTION_DEADZONE_DEG = 0.8;
const POST_CALIBRATION_MOUSE_OPTICAL_INTERVAL_MS = 33;
const POST_CALIBRATION_NO_MOUSE_OPTICAL_INTERVAL_MS = 33;
const LOCAL_VISUAL_LOCK_INTERVAL_MS = 50;
const KEYBOARD_VISUAL_LOCK_INTERVAL_MS = 25;
const SCREEN_ONLY_PATCH_MIN_TRACKED_POINTS = 5;
const RECENT_MOUSE_INPUT_MS = 120;
const RECENT_KEYBOARD_INPUT_MS = 220;
const KEYBOARD_OPTICAL_BLEND_WEIGHT = 0.12;
const OPTICAL_CALIBRATION_TARGET_SAMPLES = 12;
const OPTICAL_CALIBRATION_MAX_MS = 5_000;
const OPTICAL_CALIBRATION_MIN_CONFIDENCE = 0.3;
const OPTICAL_CALIBRATION_MIN_MOUSE_DX = 4;
const OPTICAL_CALIBRATION_MIN_VISUAL_DX = 2;
const MOUSE_SENSITIVITY_ALPHA = 0.18;
const FOV_ALPHA = 0.12;
const MIN_MOUSE_DEG_PER_PX = 0.01;
const MAX_MOUSE_DEG_PER_PX = 1.5;
const MIN_LEARNED_FOV = 45;
const MAX_LEARNED_FOV = 120;
const MOTION_RESIDUAL_FULL_CONFIDENCE_DEG = 0.35;
const MOTION_RESIDUAL_REJECT_DEG = 1.8;
const SURFACE_LOCK_TRACKING_ENABLED = process.env.PYNG_DISABLE_SURFACE_LOCK !== '1';
const LEGACY_KCF_TRACKING_ENABLED = process.env.PYNG_FORCE_LEGACY_KCF === '1';
const LOCAL_KLT_TRACKING_ENABLED = process.env.PYNG_ENABLE_LOCAL_KLT === '1';
const VISUAL_PATCH_CORRECTION_ENABLED = process.env.PYNG_DISABLE_VISUAL_PATCH !== '1';

export class TrackingLoop {
  private readonly options: TrackingLoopOptions;
  private captureLoop: TrackingFrameLoop | null = null;
  private _prevFrame: GrayFrame | null = null;
  private _running = false;
  private _currentFps = DEFAULT_FPS;
  private _captureStarting = false;
  private _lastBudgets: number[] = [];
  private _opticalStartedAtMs = 0;
  private _opticalFinished = false;
  private _calibrationSamples = 0;
  private _learnedMouseSensitivityDegPerPx: number | null = null;
  private _learnedHorizontalFovDeg: number | null = null;
  private readonly _nativeKcfAnchorTracker = new NativeKcfAnchorTracker();
  private readonly _localAnchorTracker = new LocalPingAnchorTracker();
  private readonly _surfaceAnchorTracker = new SurfaceAnchorTracker();
  private readonly _visualPatchCorrector = new VisualPatchCorrector();
  private readonly _positionFuser = new PingPositionFuser();
  private readonly _motionPredictor = new MotionPredictor();
  private readonly _latestLocalObservations = new Map<string, SurfaceTrackerResult>();
  private _observer: ((motionInPx: TrackingObserverSample) => void) | null = null;
  private _lastMouseInputAtNs: number | null = null;
  private _keyboardActive = false;
  private _lastKeyboardInputAtNs: number | null = null;
  private _lastKeyboardState: KeyboardTrackingState | null = null;
  private _lastPostCalibrationOpticalAtNs = 0;
  private _lastLocalVisualLockAtNs = 0;

  constructor(options: TrackingLoopOptions) {
    this.options = options;
  }

  start(): void {
    if (this._running) return;

    this._opticalStartedAtMs = Date.now();
    this._opticalFinished = !this.mouseTrackingEnabled();
    this._calibrationSamples = 0;
    this._prevFrame = null;
    this._currentFps = this.preferredFps();
    this._lastBudgets = [];
    this.resetLocalTracking();
    this._positionFuser.reset();
    this._latestLocalObservations.clear();
    this._motionPredictor.reset();
    this._lastMouseInputAtNs = null;
    this._keyboardActive = false;
    this._lastKeyboardInputAtNs = null;
    this._lastKeyboardState = null;
    this._lastPostCalibrationOpticalAtNs = 0;
    this._lastLocalVisualLockAtNs = 0;

    this._running = true;
    this.startCaptureLoop();
  }

  notifyPingAdded(): void {
    if (!this._running) return;
    if (this.options.pingTracker.getActiveCount() === 0) return;
    if (this._opticalFinished) this.ensureActiveVisualAssist();
  }

  private ensureActiveVisualAssist(): void {
    if (!this._running || this.options.pingTracker.getActiveCount() === 0) return;
    if (this.captureLoop === null) {
      this._currentFps = VISUAL_ASSIST_FPS;
      this._prevFrame = null;
      this.startCaptureLoop();
    } else if (this._currentFps < VISUAL_ASSIST_FPS) {
      this._currentFps = VISUAL_ASSIST_FPS;
      this.captureLoop.setFps(VISUAL_ASSIST_FPS);
    }
  }

  private startCaptureLoop(): void {
    if (!this._running || this.captureLoop !== null || this._captureStarting) return;
    this._captureStarting = true;
    const doWarmup = this.options._warmup ?? warmup;
    void doWarmup().then(() => {
      this._captureStarting = false;
      if (!this._running) {
        // start() was called then stop() arrived before warmup resolved
        return;
      }
      if (this.captureLoop !== null) return;

      const factory =
        this.options._CaptureLoopFactory ??
        ((onFrame, onError) =>
          createTrackingFrameLoop({
            fps: this._currentFps,
            includeRgbBuffer: true,
            onFrame,
            onError,
          }));

      this.captureLoop = factory(
        (frame) => this.handleFrame(frame),
        (err) => console.warn('[tracking] capture error', err),
      );
      this.captureLoop.start();
    });
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    this._captureStarting = false;
    this.captureLoop?.stop();
    this.captureLoop = null;
    this._prevFrame = null;
    this.resetLocalTracking();
    this._positionFuser.reset();
    this._latestLocalObservations.clear();
    this._motionPredictor.reset();
    this._lastMouseInputAtNs = null;
    this._keyboardActive = false;
    this._lastKeyboardInputAtNs = null;
    this._lastKeyboardState = null;
    this._lastPostCalibrationOpticalAtNs = 0;
    this._lastLocalVisualLockAtNs = 0;
  }

  isRunning(): boolean {
    return this._running;
  }

  setObserver(cb: ((motionInPx: TrackingObserverSample) => void) | null): void {
    this._observer = cb;
  }

  applyMouseDelta(dx: number, dy: number, eventTimeNs = monotonicNowNs()): boolean {
    if (!this.mouseTrackingEnabled()) return false;
    this.syncTrackerConfig();
    this.options.confidence.recordMouseDelta(dx, dy);
    this._motionPredictor.recordMouseDelta(
      dx,
      dy,
      this.options.pingTracker.getConfig().mouseSensitivityDegPerPx,
      eventTimeNs,
    );
    const applied = this.options.pingTracker.applyMouseDelta(dx, dy);
    if (!applied) return false;
    this._lastMouseInputAtNs = eventTimeNs;

    if (this._observer !== null) {
      this._observer({ dx, dy, inliers: 1, source: 'mouse' });
    }

    this.emitCurrentProjection(eventTimeNs, 'mouse');
    return true;
  }

  applyKeyboardState(state: KeyboardTrackingState, eventTimeNs = monotonicNowNs()): boolean {
    const active = keyboardStateActive(state);
    const changed =
      this._lastKeyboardState === null ||
      this._keyboardActive !== active ||
      this._lastKeyboardState.horizontalAxis !== state.horizontalAxis ||
      this._lastKeyboardState.verticalAxis !== state.verticalAxis ||
      this._lastKeyboardState.jump !== state.jump ||
      this._lastKeyboardState.crouch !== state.crouch ||
      this._lastKeyboardState.sprint !== state.sprint;

    this._keyboardActive = active;
    this._lastKeyboardState = { ...state };
    if (active || changed) {
      this._lastKeyboardInputAtNs = eventTimeNs;
    }
    if (active && this._running && this._opticalFinished) {
      this.ensureActiveVisualAssist();
    }
    return changed;
  }

  private async handleFrame(frame: GrayFrame): Promise<void> {
    const startMs = Date.now();
    const frameTimeNs = frame.capturedAtNs ?? monotonicNowNs();
    let projectionMode: OverlayUpdatePingPositionPayload['trackingMode'] =
      this.keyboardTrackingActive(frameTimeNs) ? 'keyboard' : 'frame';

    this.syncTrackerConfig();
    const prevFrame = this._prevFrame;
    const shouldEstimateOptical = this.shouldEstimateOpticalFrame(prevFrame, frameTimeNs);
    if (shouldEstimateOptical && prevFrame !== null) {
      if (this._opticalFinished) {
        this._lastPostCalibrationOpticalAtNs = frameTimeNs;
      }
      const _estimateMotion = this.options._estimateMotion ?? estimateMotion;
      const mouseDelta = this.options.confidence.getAccumulatedDelta();
      const expectedMotion = this.expectedMotionFromMouse(mouseDelta);
      const motion: MotionResult | null = _estimateMotion(
        prevFrame.buffer,
        frame.buffer,
        frame.width,
        frame.height,
        this.options.getMaskRegions(),
        {
          pixelsPerDegree: this.options.getPixelsPerDegree(),
          horizontalFovDeg: this.effectiveHorizontalFovDeg(),
          verticalFovDeg: this.options.getFovV(),
          expectedYawDeltaDeg: expectedMotion.yawDeltaDeg,
          expectedPitchDeltaDeg: expectedMotion.pitchDeltaDeg,
        },
      );

      if (motion !== null) {
        const sourceTimeNs = frameTimeNs;
        if (this._observer !== null) {
          this._observer({
            dx: motion.dxPx,
            dy: motion.dyPx,
            inliers: motion.inlierCount,
            source: 'optical',
          });
        }
        const noMouseVisualTracking =
          mouseDelta.eventCount === 0 && this.shouldUseVisualMotionWithoutMouse(sourceTimeNs);
        const keyboardVisualCue =
          mouseDelta.eventCount === 0 && this.keyboardTrackingActive(sourceTimeNs);
        const rawConfidence = this.rawMotionConfidence(motion);
        const refinedConfidence = this.motionQualityAdjustedConfidence(motion, rawConfidence);
        this.learnCalibrationFromOptical(motion, mouseDelta, refinedConfidence, frame);
        const opticalBlendWeight = this.opticalBlendWeightForMotion(
          motion,
          mouseDelta,
          refinedConfidence,
          noMouseVisualTracking,
          keyboardVisualCue,
        );
        this.options.pingTracker.applyOpticalFlow({
          yawDeltaDeg: motion.yawDelta,
          pitchDeltaDeg: motion.pitchDelta,
          confidence: refinedConfidence,
          medianDxPx: motion.dxPx,
          medianDyPx: motion.dyPx,
          trackedPointCount: motion.inlierCount,
          minTrackedPoints: this.minTrackedPointsForMotion(motion, refinedConfidence),
          opticalBlendWeight,
          rejectedReason:
            refinedConfidence >= MIN_APPLY_CONFIDENCE ? undefined : 'low-confidence-flow',
        });
        if (refinedConfidence < MIN_APPLY_CONFIDENCE) {
          this._motionPredictor.dampenVelocity(0.45);
        } else {
          projectionMode = keyboardVisualCue ? 'keyboard' : 'optical';
        }
      } else {
        this.options.pingTracker.applyOpticalFlow({
          yawDeltaDeg: 0,
          pitchDeltaDeg: 0,
          confidence: 0,
          medianDxPx: 0,
          medianDyPx: 0,
          trackedPointCount: 0,
          rejectedReason: 'no-stable-flow',
        });
        this._motionPredictor.dampenVelocity(0.7);
      }

      this.maybeFinishOpticalCalibration(startMs);
    }

    this._prevFrame = frame;

    this.updateLocalAnchors(prevFrame, frame, frameTimeNs);
    this.emitCurrentProjection(frameTimeNs, projectionMode);
    this.stopIdleVisualAssistIfNeeded();

    const elapsedMs = Date.now() - startMs;
    this._lastBudgets.push(elapsedMs);
    if (this._lastBudgets.length > BUDGET_HISTORY) this._lastBudgets.shift();

    if (
      this._lastBudgets.length >= BUDGET_WINDOW &&
      this._lastBudgets.slice(-BUDGET_WINDOW).every((b) => b > this.frameBudgetWarnMs())
    ) {
      if (this._currentFps > STEPDOWN_FPS && this.captureLoop !== null) {
        const nextFps = this._currentFps > MID_STEPDOWN_FPS ? MID_STEPDOWN_FPS : STEPDOWN_FPS;
        console.warn(
          `[tracking] frame budget exceeded; stepping down ${this._currentFps} → ${nextFps} fps`,
        );
        this._currentFps = nextFps;
        this.captureLoop.setFps(nextFps);
      }
    }
  }

  private updateLocalAnchors(
    prevFrame: GrayFrame | null,
    frame: GrayFrame,
    observedAtNs: number,
  ): void {
    if (this.options.pingTracker.getActiveCount() === 0) {
      this.resetLocalTracking();
      this._latestLocalObservations.clear();
      this._lastLocalVisualLockAtNs = 0;
      return;
    }
    if (!this.shouldUpdateLocalVisualLock(observedAtNs)) return;

    this._latestLocalObservations.clear();
    this._lastLocalVisualLockAtNs = observedAtNs;
    const bounds = this.options.getOverlayBounds();
    const projections = this.options.pingTracker.projectAll(
      Date.now(),
      bounds.width,
      bounds.height,
      this.effectiveHorizontalFovDeg(),
      this.options.getFovV(),
    );
    const observations = this.updateActiveVisualTracker(
      prevFrame,
      frame,
      projections,
      bounds,
      observedAtNs,
    );
    const mergedObservations = this.mergeVisualPatchCorrections(
      frame,
      projections,
      bounds,
      observedAtNs,
      observations,
    );
    for (const observation of mergedObservations) {
      this._latestLocalObservations.set(observation.id, observation);
    }
  }

  private stopIdleVisualAssistIfNeeded(): void {
    if (!this._opticalFinished) return;
    if (this.options.pingTracker.getActiveCount() > 0) return;
    this.resetLocalTracking();
    this._positionFuser.reset();
    this._latestLocalObservations.clear();
    this._lastLocalVisualLockAtNs = 0;
    if (this.captureLoop !== null && this._currentFps !== IDLE_VISUAL_ASSIST_FPS) {
      this._currentFps = IDLE_VISUAL_ASSIST_FPS;
      this.captureLoop.setFps(IDLE_VISUAL_ASSIST_FPS);
    }
  }

  private updateActiveVisualTracker(
    prevFrame: GrayFrame | null,
    frame: GrayFrame,
    projections: ReturnType<PingTracker['projectAll']>,
    bounds: { width: number; height: number },
    observedAtNs: number,
  ): SurfaceTrackerResult[] {
    const maskRegions = this.options.getMaskRegions();
    if (SURFACE_LOCK_TRACKING_ENABLED && !LEGACY_KCF_TRACKING_ENABLED) {
      return this._surfaceAnchorTracker.update(
        prevFrame,
        frame,
        projections,
        bounds,
        maskRegions,
        observedAtNs,
      );
    }
    if (LOCAL_KLT_TRACKING_ENABLED) {
      return this._localAnchorTracker.update(
        prevFrame,
        frame,
        projections,
        bounds,
        maskRegions,
        observedAtNs,
      );
    }
    return this._nativeKcfAnchorTracker.update(
      prevFrame,
      frame,
      projections,
      bounds,
      maskRegions,
      observedAtNs,
    );
  }

  private mergeVisualPatchCorrections(
    frame: GrayFrame,
    projections: ReturnType<PingTracker['projectAll']>,
    bounds: { width: number; height: number },
    observedAtNs: number,
    observations: SurfaceTrackerResult[],
  ): SurfaceTrackerResult[] {
    if (!this.visualPatchCorrectionEnabled()) return observations;

    const byId = new Map(observations.map((observation) => [observation.id, observation]));
    for (const correction of this._visualPatchCorrector.update(frame, projections, bounds)) {
      const observation = surfaceObservationFromPatch(correction, observedAtNs);
      const existing = byId.get(observation.id);
      if (existing === undefined || shouldPreferPatchObservation(existing, observation)) {
        byId.set(observation.id, observation);
      }
    }
    return Array.from(byId.values());
  }

  private visualPatchCorrectionEnabled(): boolean {
    return VISUAL_PATCH_CORRECTION_ENABLED && this.options.enableVisualPatchCorrection !== false;
  }

  private resetLocalTracking(): void {
    this._nativeKcfAnchorTracker.reset();
    this._localAnchorTracker.reset();
    this._surfaceAnchorTracker.reset();
    this._visualPatchCorrector.reset();
  }

  private syncTrackerConfig(): void {
    const bounds = this.options.getOverlayBounds();
    const baseMouseSensitivity = this.baseMouseSensitivityDegPerPx();
    this.options.pingTracker.updateConfig({
      screenWidth: bounds.width,
      screenHeight: bounds.height,
      horizontalFovDeg: this.effectiveHorizontalFovDeg(),
      verticalFovDeg: this.options.getFovV(),
      mouseSensitivityDegPerPx: this._learnedMouseSensitivityDegPerPx ?? baseMouseSensitivity,
      opticalFlowWeight: this.currentOpticalFlowWeight(),
    });
  }

  private currentOpticalFlowWeight(): number {
    if (
      this.options.confidence.getAccumulatedDelta().eventCount === 0 &&
      this.shouldUseVisualMotionWithoutMouse()
    ) {
      if (this.keyboardTrackingActive()) return KEYBOARD_OPTICAL_BLEND_WEIGHT;
      return NO_MOUSE_VISUAL_BLEND_WEIGHT;
    }
    return this._opticalFinished ? 0 : OPTICAL_ASSIST_WEIGHT;
  }

  private shouldEstimateOpticalFrame(prevFrame: GrayFrame | null, frameTimeNs: number): boolean {
    if (prevFrame === null) return false;
    if (!this._opticalFinished) return true;
    if (this.options.pingTracker.getActiveCount() === 0) return false;
    if (!this.hasRecentMouseInput(frameTimeNs)) {
      const elapsedMs =
        this._lastPostCalibrationOpticalAtNs === 0
          ? Number.POSITIVE_INFINITY
          : (frameTimeNs - this._lastPostCalibrationOpticalAtNs) / 1_000_000;
      return elapsedMs >= POST_CALIBRATION_NO_MOUSE_OPTICAL_INTERVAL_MS;
    }

    const elapsedMs =
      this._lastPostCalibrationOpticalAtNs === 0
        ? Number.POSITIVE_INFINITY
        : (frameTimeNs - this._lastPostCalibrationOpticalAtNs) / 1_000_000;
    return elapsedMs >= POST_CALIBRATION_MOUSE_OPTICAL_INTERVAL_MS;
  }

  private shouldUpdateLocalVisualLock(observedAtNs: number): boolean {
    if (this._lastLocalVisualLockAtNs === 0) return true;
    const intervalMs = this.keyboardTrackingActive(observedAtNs)
      ? KEYBOARD_VISUAL_LOCK_INTERVAL_MS
      : LOCAL_VISUAL_LOCK_INTERVAL_MS;
    return (observedAtNs - this._lastLocalVisualLockAtNs) / 1_000_000 >= intervalMs;
  }

  private expectedMotionFromMouse(mouseDelta: { dx: number; dy: number; eventCount: number }): {
    yawDeltaDeg?: number;
    pitchDeltaDeg?: number;
  } {
    if (mouseDelta.eventCount === 0) return {};
    const sensitivity = this.options.pingTracker.getConfig().mouseSensitivityDegPerPx;
    return {
      yawDeltaDeg: mouseDelta.dx * sensitivity,
      pitchDeltaDeg: -mouseDelta.dy * sensitivity,
    };
  }

  private opticalBlendWeightForMotion(
    motion: MotionResult,
    mouseDelta: { dx: number; dy: number; eventCount: number },
    confidence: number,
    noMouseVisualTracking: boolean,
    keyboardVisualCue: boolean,
  ): number | undefined {
    if (confidence < MIN_APPLY_CONFIDENCE) return undefined;
    if (keyboardVisualCue) return KEYBOARD_OPTICAL_BLEND_WEIGHT;
    if (noMouseVisualTracking) return NO_MOUSE_VISUAL_BLEND_WEIGHT;
    if (!this._opticalFinished || mouseDelta.eventCount === 0) return undefined;

    const expected = this.expectedMotionFromMouse(mouseDelta);
    const expectedYaw = expected.yawDeltaDeg ?? 0;
    const expectedPitch = expected.pitchDeltaDeg ?? 0;
    const yawDisagreementDeg = Math.abs(normalizeSignedDeg(motion.yawDelta - expectedYaw));
    const pitchDisagreementDeg = Math.abs(motion.pitchDelta - expectedPitch);
    const disagreementDeg = Math.max(yawDisagreementDeg, pitchDisagreementDeg);
    if (disagreementDeg <= POST_CALIBRATION_CORRECTION_DEADZONE_DEG) return 0;

    const effectiveDisagreementDeg = disagreementDeg - POST_CALIBRATION_CORRECTION_DEADZONE_DEG;
    return clamp(
      POST_CALIBRATION_MIN_OPTICAL_WEIGHT +
        (effectiveDisagreementDeg / POST_CALIBRATION_DISAGREEMENT_DEG) *
          POST_CALIBRATION_WEIGHT_RANGE,
      POST_CALIBRATION_MIN_OPTICAL_WEIGHT,
      POST_CALIBRATION_MAX_OPTICAL_WEIGHT,
    );
  }

  private motionQualityAdjustedConfidence(motion: MotionResult, rawConfidence: number): number {
    let confidence = clamp(rawConfidence, 0, 1);
    if (Number.isFinite(motion.confidence)) {
      confidence = Math.min(confidence, clamp(motion.confidence, 0, 1));
    }

    const residualDeg = motion.residualDeg;
    if (residualDeg === undefined || !Number.isFinite(residualDeg)) {
      return confidence;
    }
    if (residualDeg <= MOTION_RESIDUAL_FULL_CONFIDENCE_DEG) {
      return confidence;
    }
    if (residualDeg >= MOTION_RESIDUAL_REJECT_DEG) {
      return Math.min(confidence, 0.2);
    }

    const t =
      (residualDeg - MOTION_RESIDUAL_FULL_CONFIDENCE_DEG) /
      (MOTION_RESIDUAL_REJECT_DEG - MOTION_RESIDUAL_FULL_CONFIDENCE_DEG);
    return confidence * (1 - 0.8 * clamp(t, 0, 1));
  }

  private rawMotionConfidence(motion: MotionResult): number {
    if (!this.mouseTrackingEnabled()) return clamp(motion.confidence, 0, 1);
    return this.options.confidence.score(motion, this.options.getMousePixelsPerDegree());
  }

  private minTrackedPointsForMotion(motion: MotionResult, confidence: number): number | undefined {
    if (
      !this.mouseTrackingEnabled() &&
      motion.model === 'patch-rotation' &&
      confidence >= MIN_APPLY_CONFIDENCE
    ) {
      return SCREEN_ONLY_PATCH_MIN_TRACKED_POINTS;
    }
    return undefined;
  }

  private shouldUseVisualMotionWithoutMouse(nowNs = monotonicNowNs()): boolean {
    if (this.options.pingTracker.getActiveCount() === 0) return false;
    if (this._lastMouseInputAtNs === null) return true;
    return !this.hasRecentMouseInput(nowNs);
  }

  private mouseTrackingEnabled(): boolean {
    return this.options.mouseTrackingEnabled !== false;
  }

  private hasRecentMouseInput(nowNs = monotonicNowNs()): boolean {
    if (this._lastMouseInputAtNs === null) return false;
    return (nowNs - this._lastMouseInputAtNs) / 1_000_000 <= RECENT_MOUSE_INPUT_MS;
  }

  private keyboardTrackingActive(nowNs = monotonicNowNs()): boolean {
    return this._keyboardActive || this.hasRecentKeyboardInput(nowNs);
  }

  private hasRecentKeyboardInput(nowNs = monotonicNowNs()): boolean {
    if (this._lastKeyboardInputAtNs === null) return false;
    return (nowNs - this._lastKeyboardInputAtNs) / 1_000_000 <= RECENT_KEYBOARD_INPUT_MS;
  }

  private effectiveHorizontalFovDeg(): number {
    if (this.options.getFovLearningEnabled?.() === false) {
      return this.options.getFovH();
    }
    return this._learnedHorizontalFovDeg ?? this.options.getFovH();
  }

  private baseMouseSensitivityDegPerPx(): number {
    const mousePixelsPerDegree = this.options.getMousePixelsPerDegree();
    return mousePixelsPerDegree > 0 ? 1 / mousePixelsPerDegree : 1 / 8;
  }

  private preferredFps(): number {
    const configured = this.options.getTrackingFps?.() ?? DEFAULT_FPS;
    return configured === 'auto' ? AUTO_FPS : configured;
  }

  private frameBudgetWarnMs(): number {
    return 1000 / Math.max(1, this._currentFps);
  }

  private learnCalibrationFromOptical(
    motion: MotionResult,
    mouseDelta: { dx: number; dy: number; eventCount: number },
    confidence: number,
    frame: GrayFrame,
  ): void {
    if (this._opticalFinished) return;
    if (confidence < OPTICAL_CALIBRATION_MIN_CONFIDENCE) return;
    if (mouseDelta.eventCount === 0) return;

    const absDx = Math.abs(mouseDelta.dx);
    const absDy = Math.abs(mouseDelta.dy);
    const useYaw = absDx >= absDy;
    const mouseAxisPx = useYaw ? mouseDelta.dx : -mouseDelta.dy;
    const opticalAxisDeg = useYaw ? motion.yawDelta : motion.pitchDelta;
    const opticalAxisPx = useYaw ? motion.dxPx : motion.dyPx;
    if (Math.abs(mouseAxisPx) < OPTICAL_CALIBRATION_MIN_MOUSE_DX) return;
    if (Math.abs(opticalAxisPx) < OPTICAL_CALIBRATION_MIN_VISUAL_DX) return;

    const observedMouseSensitivity = opticalAxisDeg / mouseAxisPx;
    if (
      !Number.isFinite(observedMouseSensitivity) ||
      observedMouseSensitivity < MIN_MOUSE_DEG_PER_PX ||
      observedMouseSensitivity > MAX_MOUSE_DEG_PER_PX
    ) {
      return;
    }

    const previousSensitivity =
      this._learnedMouseSensitivityDegPerPx ?? this.baseMouseSensitivityDegPerPx();
    this._learnedMouseSensitivityDegPerPx = smooth(
      previousSensitivity,
      observedMouseSensitivity,
      MOUSE_SENSITIVITY_ALPHA * confidence,
    );

    const estimatedFov = this.estimateHorizontalFovFromSample(motion, mouseDelta, frame);
    if (estimatedFov !== null && this.options.getFovLearningEnabled?.() !== false) {
      this._learnedHorizontalFovDeg = smooth(
        this._learnedHorizontalFovDeg ?? this.options.getFovH(),
        estimatedFov,
        FOV_ALPHA * confidence,
      );
    }

    this._calibrationSamples += 1;
    this.syncTrackerConfig();
  }

  private estimateHorizontalFovFromSample(
    motion: MotionResult,
    mouseDelta: { dx: number },
    frame: GrayFrame,
  ): number | null {
    const bounds = this.options.getOverlayBounds();
    if (bounds.width <= 0 || frame.width <= 0) return null;
    const sensitivity =
      this._learnedMouseSensitivityDegPerPx ?? this.baseMouseSensitivityDegPerPx();
    const yawFromMouse = Math.abs(mouseDelta.dx * sensitivity);
    if (yawFromMouse < 0.1) return null;

    const screenDx = Math.abs(motion.dxPx) * (bounds.width / frame.width);
    if (screenDx < OPTICAL_CALIBRATION_MIN_VISUAL_DX) return null;

    const screenPxPerDeg = screenDx / yawFromMouse;
    if (!Number.isFinite(screenPxPerDeg) || screenPxPerDeg <= 0) return null;

    return clamp(bounds.width / screenPxPerDeg, MIN_LEARNED_FOV, MAX_LEARNED_FOV);
  }

  private maybeFinishOpticalCalibration(nowMs: number): void {
    if (this._opticalFinished) return;

    const elapsedMs = nowMs - this._opticalStartedAtMs;
    const enoughSamples = this._calibrationSamples >= OPTICAL_CALIBRATION_TARGET_SAMPLES;
    const timedOut = elapsedMs >= OPTICAL_CALIBRATION_MAX_MS;
    if (!enoughSamples && !timedOut) return;

    this._opticalFinished = true;
    this._prevFrame = null;
    this.options.confidence.reset();
    if (this.captureLoop !== null && this.options.pingTracker.getActiveCount() === 0) {
      this._currentFps = IDLE_VISUAL_ASSIST_FPS;
      this.captureLoop.setFps(IDLE_VISUAL_ASSIST_FPS);
    } else if (this.captureLoop !== null) {
      this._currentFps = VISUAL_ASSIST_FPS;
      this.captureLoop.setFps(VISUAL_ASSIST_FPS);
    }
    console.warn(
      `[tracking] optical calibration ${
        enoughSamples ? 'complete' : 'timed out'
      }; mouse tracking active, visual assist idles until pings are alive`,
    );
    this.syncTrackerConfig();
  }

  private emitCurrentProjection(
    sourceTimeNs = monotonicNowNs(),
    trackingMode: OverlayUpdatePingPositionPayload['trackingMode'] = 'frame',
  ): void {
    const bounds = this.options.getOverlayBounds();
    const nowNs = monotonicNowNs();
    const predicted = this._motionPredictor.predictPose(
      this.options.pingTracker.getYawDeg(),
      this.options.pingTracker.getPitchDeg(),
      nowNs,
    );
    const projections = this.options.pingTracker.projectAllAtPose(
      Date.now(),
      predicted.yawDeg,
      predicted.pitchDeg,
      bounds.width,
      bounds.height,
      this.effectiveHorizontalFovDeg(),
      this.options.getFovV(),
    );
    const fusedProjections = this._positionFuser.update(
      projections,
      this._latestLocalObservations,
      nowNs,
      trackingMode,
    );

    for (const p of fusedProjections) {
      this.options.emitPositionUpdate({
        ...p,
        sourceTimeNs,
        predictedAtNs: predicted.predictedAtNs,
        predictionLeadMs: predicted.leadMs,
      });
    }
  }
}

export type TrackingObserverSample = {
  dx: number;
  dy: number;
  inliers: number;
  source: 'mouse' | 'optical';
};

function keyboardStateActive(state: KeyboardTrackingState): boolean {
  return (
    state.active ||
    state.activeKeyCount > 0 ||
    state.forward ||
    state.backward ||
    state.left ||
    state.right ||
    state.jump ||
    state.crouch ||
    state.sprint
  );
}

function surfaceObservationFromPatch(
  correction: VisualPatchCorrection,
  observedAtNs: number,
): SurfaceTrackerResult {
  const confidence = clamp(0.28 + correction.confidence * 0.5, 0.28, 0.78);
  const pseudoInliers = Math.round(12 + correction.confidence * 36);
  return {
    id: correction.id,
    screenX: correction.observedScreenX,
    screenY: correction.observedScreenY,
    confidence,
    observedAtNs,
    inlierCount: pseudoInliers,
    trackedPointCount: pseudoInliers,
    residualPx: Math.max(0, (1 - correction.score) * 12),
    trackingMethod: 'template',
    surfaceConfidence: confidence,
    surfaceLockKind: 'template',
  };
}

function shouldPreferPatchObservation(
  existing: SurfaceTrackerResult,
  patch: SurfaceTrackerResult,
): boolean {
  if (existing.trackingMethod === 'prediction') return patch.confidence > existing.confidence;
  const existingConfidence = existing.surfaceConfidence ?? existing.confidence;
  return existingConfidence < 0.3 && patch.confidence > existingConfidence + 0.05;
}

function smooth(previous: number, next: number, alpha: number): number {
  const t = Math.max(0, Math.min(1, alpha));
  return previous + (next - previous) * t;
}

function normalizeSignedDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

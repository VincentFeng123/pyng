// Pure interpolation math for the overlay rAF tick. Extracted so it can be
// unit-tested without DOM globals (window, document, requestAnimationFrame).

export const INTERP_WINDOW_MS = 6;
export const MIN_DYNAMIC_INTERP_WINDOW_MS = 8;
export const MAX_DYNAMIC_INTERP_WINDOW_MS = 64;
const CADENCE_INTERP_MULTIPLIER = 0.8;
const MOUSE_CADENCE_INTERP_MULTIPLIER = 0.35;
const KEYBOARD_CADENCE_INTERP_MULTIPLIER = 0.55;
const OPTICAL_CADENCE_INTERP_MULTIPLIER = 0.65;
const VISUAL_LOCK_CADENCE_INTERP_MULTIPLIER = 0.45;
const MIN_MOUSE_INTERP_WINDOW_MS = 3;
const MIN_KEYBOARD_INTERP_WINDOW_MS = 5;
const MIN_VISUAL_LOCK_INTERP_WINDOW_MS = 4;
const SNAP_DISTANCE_PX = 1.5;

export type TrackingTarget = {
  targetX: number;
  targetY: number;
  targetConfidence: number;
  isEdgeArrow: boolean;
  arrowAngle?: number;
  trackingState?: 'exact' | 'uncertain' | 'directional' | 'lost';
  uncertaintyPx?: number;
  localConfidence?: number;
  globalConfidence?: number;
  trackingMethod?: 'homography' | 'shape' | 'template' | 'klt' | 'kcf' | 'prediction';
  surfaceConfidence?: number;
  surfaceLockKind?: 'circle' | 'plane' | 'template' | 'unknown';
  receivedAt: number;
  interpWindowMs?: number;
  sourceTimeNs?: number;
  predictedAtNs?: number;
  predictionLeadMs?: number;
  trackingMode?: 'mouse' | 'keyboard' | 'optical' | 'frame';
};

export function interpolate(
  last: { x: number; y: number; confidence: number },
  target: TrackingTarget,
  elapsedMs: number,
): { x: number; y: number; confidence: number } {
  if (
    Math.hypot(target.targetX - last.x, target.targetY - last.y) <= SNAP_DISTANCE_PX &&
    Math.abs(target.targetConfidence - last.confidence) <= 0.02
  ) {
    return {
      x: target.targetX,
      y: target.targetY,
      confidence: target.targetConfidence,
    };
  }

  const t = Math.min(Math.max(0, elapsedMs) / interpolationWindowMs(target), 1);
  return {
    x: last.x + (target.targetX - last.x) * t,
    y: last.y + (target.targetY - last.y) * t,
    confidence: last.confidence + (target.targetConfidence - last.confidence) * t,
  };
}

export function currentInterpolatedPosition(
  last: { x: number; y: number; confidence: number },
  target: TrackingTarget,
  nowMs: number,
): { x: number; y: number; confidence: number } {
  return interpolate(last, target, nowMs - target.receivedAt);
}

export function interpolationWindowMs(target: TrackingTarget): number {
  const windowMs = target.interpWindowMs ?? INTERP_WINDOW_MS;
  return clamp(windowMs, 1, MAX_DYNAMIC_INTERP_WINDOW_MS);
}

export function interpolationWindowForCadence(
  previousReceivedAtMs: number | null,
  nowMs: number,
  predictionLeadMs = 0,
  trackingMode: TrackingTarget['trackingMode'] = 'frame',
  trackingMethod: TrackingTarget['trackingMethod'] = 'prediction',
): number {
  const minWindowMs =
    trackingMode === 'mouse'
      ? MIN_MOUSE_INTERP_WINDOW_MS
      : trackingMode === 'keyboard'
        ? MIN_KEYBOARD_INTERP_WINDOW_MS
        : isVisualLockMethod(trackingMethod)
          ? MIN_VISUAL_LOCK_INTERP_WINDOW_MS
          : MIN_DYNAMIC_INTERP_WINDOW_MS;
  if (previousReceivedAtMs === null || !Number.isFinite(previousReceivedAtMs)) {
    return minWindowMs;
  }
  const intervalMs = nowMs - previousReceivedAtMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return minWindowMs;
  }
  const cadenceMultiplier = isVisualLockMethod(trackingMethod)
    ? VISUAL_LOCK_CADENCE_INTERP_MULTIPLIER
    : trackingMode === 'mouse'
      ? MOUSE_CADENCE_INTERP_MULTIPLIER
      : trackingMode === 'keyboard'
        ? KEYBOARD_CADENCE_INTERP_MULTIPLIER
        : trackingMode === 'optical'
          ? OPTICAL_CADENCE_INTERP_MULTIPLIER
          : CADENCE_INTERP_MULTIPLIER;
  const leadCreditMs = clamp(predictionLeadMs, 0, 16) * (trackingMode === 'mouse' ? 0.75 : 0.5);
  return clamp(
    intervalMs * cadenceMultiplier - leadCreditMs,
    minWindowMs,
    MAX_DYNAMIC_INTERP_WINDOW_MS,
  );
}

function isVisualLockMethod(method: TrackingTarget['trackingMethod']): boolean {
  return method === 'kcf' || method === 'shape' || method === 'homography';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

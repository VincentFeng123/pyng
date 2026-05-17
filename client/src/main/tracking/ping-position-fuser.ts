import type { OverlayUpdatePingPositionPayload } from '@pyng/shared';
import type { PingProjection } from './ping-tracker.js';
import type { SurfaceTrackerResult, SurfaceTrackingMethod } from './surface-tracking-types.js';
import { OneEuroFilter } from './one-euro-filter.js';

type FusionState = {
  filterX: OneEuroFilter;
  filterY: OneEuroFilter;
  filterConfidence: OneEuroFilter;
  lastStableX: number;
  lastStableY: number;
  lastGlobalX: number;
  lastGlobalY: number;
  lastUpdateNs: number;
  velocityPxPerMs: number;
};

const NS_PER_MS = 1_000_000;
const NS_PER_SEC = 1_000_000_000;
const LOCAL_OBSERVATION_MAX_AGE_MS = 120;
const DEADZONE_PX = 0.35;
const BASE_MAX_JUMP_PX = 40;
const UNCERTAINTY_MIN_PX = 8;
const UNCERTAINTY_RANGE_PX = 72;

export class PingPositionFuser {
  private states = new Map<string, FusionState>();

  reset(): void {
    this.states.clear();
  }

  update(
    projections: PingProjection[],
    localObservations: Map<string, SurfaceTrackerResult>,
    nowNs: number,
    trackingMode: OverlayUpdatePingPositionPayload['trackingMode'],
  ): OverlayUpdatePingPositionPayload[] {
    const liveIds = new Set(projections.map((p) => p.id));
    for (const id of this.states.keys()) {
      if (!liveIds.has(id)) this.states.delete(id);
    }

    return projections.map((projection) =>
      this.fuseProjection(projection, localObservations.get(projection.id), nowNs, trackingMode),
    );
  }

  private fuseProjection(
    projection: PingProjection,
    localObservation: SurfaceTrackerResult | undefined,
    nowNs: number,
    trackingMode: OverlayUpdatePingPositionPayload['trackingMode'],
  ): OverlayUpdatePingPositionPayload {
    if (projection.isEdgeArrow) {
      this.states.delete(projection.id);
      const confidence = clamp01(projection.confidence);
      return {
        ...projection,
        confidence,
        trackingState: confidence < 0.2 ? 'lost' : 'directional',
        uncertaintyPx: uncertaintyForConfidence(confidence),
        globalConfidence: confidence,
        trackingMethod: 'prediction',
        surfaceConfidence: 0,
        surfaceLockKind: 'unknown',
        trackingMode,
      };
    }

    let state = this.states.get(projection.id);
    if (!state) {
      state = createState(projection, nowNs);
      this.states.set(projection.id, state);
      const confidence = clamp01(projection.confidence);
      return {
        ...projection,
        confidence,
        trackingState: stateForConfidence(confidence),
        uncertaintyPx: uncertaintyForConfidence(confidence),
        localConfidence: 0,
        globalConfidence: confidence,
        trackingMethod: 'prediction',
        surfaceConfidence: 0,
        surfaceLockKind: 'unknown',
        trackingMode,
      };
    }

    const ageMs = Math.max(0, (nowNs - state.lastUpdateNs) / NS_PER_MS);
    const globalDx = projection.screenX - state.lastGlobalX;
    const globalDy = projection.screenY - state.lastGlobalY;
    const predictedX = state.lastStableX + globalDx;
    const predictedY = state.lastStableY + globalDy;

    const localConfidence = localConfidenceAt(localObservation, nowNs);
    const surfaceFields = surfaceFieldsAt(localObservation, nowNs, localConfidence);
    const trackingMethod = surfaceFields.trackingMethod ?? 'prediction';
    const globalConfidence = clamp01(projection.confidence);
    const weights = weightsFor(localConfidence, trackingMode, trackingMethod);
    const rawX =
      weights.local * (localObservation?.screenX ?? projection.screenX) +
      weights.global * projection.screenX +
      weights.memory * predictedX;
    const rawY =
      weights.local * (localObservation?.screenY ?? projection.screenY) +
      weights.global * projection.screenY +
      weights.memory * predictedY;

    const jumpDistance = Math.hypot(rawX - predictedX, rawY - predictedY);
    const allowedJump = allowedJumpFor(trackingMethod, state.velocityPxPerMs, ageMs);
    const jumpRejected = shouldRejectJump(
      trackingMethod,
      jumpDistance,
      allowedJump,
      localConfidence,
    );
    const guardBlend = jumpGuardBlendFor(trackingMethod);
    const guardedX = jumpRejected ? lerp(predictedX, rawX, guardBlend) : rawX;
    const guardedY = jumpRejected ? lerp(predictedY, rawY, guardBlend) : rawY;
    const deadzoned =
      Math.hypot(guardedX - state.lastStableX, guardedY - state.lastStableY) < DEADZONE_PX;
    const targetX = deadzoned ? state.lastStableX : guardedX;
    const targetY = deadzoned ? state.lastStableY : guardedY;

    const targetConfidence = clamp01(
      (localConfidence > 0
        ? (1 - localConfidenceWeightFor(trackingMethod)) * globalConfidence +
          localConfidenceWeightFor(trackingMethod) * localConfidence
        : globalConfidence * 0.9) * (jumpRejected ? 0.65 : 1),
    );
    const timeSec = nowNs / NS_PER_SEC;
    const screenX = state.filterX.filter(targetX, timeSec);
    const screenY = state.filterY.filter(targetY, timeSec);
    const confidence = clamp01(state.filterConfidence.filter(targetConfidence, timeSec));

    const dtMs = Math.max(1, ageMs);
    state.velocityPxPerMs =
      0.75 * state.velocityPxPerMs +
      0.25 * (Math.hypot(screenX - state.lastStableX, screenY - state.lastStableY) / dtMs);
    state.lastStableX = screenX;
    state.lastStableY = screenY;
    state.lastGlobalX = projection.screenX;
    state.lastGlobalY = projection.screenY;
    state.lastUpdateNs = nowNs;

    return {
      ...projection,
      screenX,
      screenY,
      confidence,
      trackingState: stateForConfidence(confidence),
      uncertaintyPx: uncertaintyForConfidence(confidence) + (jumpRejected ? 20 : 0),
      localConfidence,
      globalConfidence,
      ...surfaceFields,
      trackingMode,
    };
  }
}

function createState(projection: PingProjection, nowNs: number): FusionState {
  const confidence = clamp01(projection.confidence);
  const timeSec = nowNs / NS_PER_SEC;
  const state: FusionState = {
    filterX: new OneEuroFilter({ minCutoff: 1.6, beta: 0.24, dCutoff: 4 }),
    filterY: new OneEuroFilter({ minCutoff: 1.6, beta: 0.24, dCutoff: 4 }),
    filterConfidence: new OneEuroFilter({ minCutoff: 1.7, beta: 0.02, dCutoff: 1 }),
    lastStableX: projection.screenX,
    lastStableY: projection.screenY,
    lastGlobalX: projection.screenX,
    lastGlobalY: projection.screenY,
    lastUpdateNs: nowNs,
    velocityPxPerMs: 0,
  };
  state.filterX.reset(projection.screenX, timeSec);
  state.filterY.reset(projection.screenY, timeSec);
  state.filterConfidence.reset(confidence, timeSec);
  return state;
}

function weightsFor(
  localConfidence: number,
  trackingMode: OverlayUpdatePingPositionPayload['trackingMode'],
  method: SurfaceTrackingMethod,
): { local: number; global: number; memory: number } {
  if (method === 'homography' || method === 'shape') {
    if (localConfidence >= 0.65) {
      return normalizeWeights({ local: 0.94, global: 0.04, memory: 0.02 });
    }
    if (localConfidence >= 0.42) {
      return normalizeWeights({ local: 0.78, global: 0.14, memory: 0.08 });
    }
  }
  if (method === 'template') {
    if (trackingMode === 'keyboard' && localConfidence >= 0.4) {
      return normalizeWeights({ local: 0.82, global: 0.06, memory: 0.12 });
    }
    if (localConfidence >= 0.62) {
      return normalizeWeights({ local: 0.88, global: 0.08, memory: 0.04 });
    }
    if (localConfidence >= 0.4) {
      return normalizeWeights({ local: 0.72, global: 0.18, memory: 0.1 });
    }
  }
  if (method === 'kcf') {
    if (localConfidence >= 0.65) {
      return normalizeWeights({ local: 0.92, global: 0.06, memory: 0.02 });
    }
    if (localConfidence >= 0.45) {
      return normalizeWeights({ local: 0.82, global: 0.12, memory: 0.06 });
    }
    if (localConfidence >= 0.3) {
      return normalizeWeights({ local: 0.62, global: 0.25, memory: 0.13 });
    }
  }
  if (localConfidence >= 0.72) {
    return normalizeWeights({ local: 0.9 * localConfidence, global: 0.08, memory: 0.02 });
  }
  if (localConfidence >= 0.35) {
    return normalizeWeights({ local: 0.62 * localConfidence, global: 0.3, memory: 0.08 });
  }
  const global = trackingMode === 'mouse' ? 0.72 : trackingMode === 'keyboard' ? 0.45 : 0.65;
  return normalizeWeights({ local: 0, global, memory: 1 - global });
}

function allowedJumpFor(
  method: SurfaceTrackingMethod,
  velocityPxPerMs: number,
  ageMs: number,
): number {
  const base =
    method === 'kcf'
      ? 140
      : method === 'homography' || method === 'shape'
        ? 120
        : method === 'template'
          ? 112
          : BASE_MAX_JUMP_PX;
  return base + velocityPxPerMs * Math.max(1, ageMs) * 2.5;
}

function shouldRejectJump(
  method: SurfaceTrackingMethod,
  jumpDistance: number,
  allowedJump: number,
  localConfidence: number,
): boolean {
  if (jumpDistance <= allowedJump) return false;
  const requiredConfidence =
    method === 'kcf'
      ? 0.35
      : method === 'homography' || method === 'shape'
        ? 0.55
        : method === 'template'
          ? 0.6
          : 0.75;
  return localConfidence < requiredConfidence;
}

function jumpGuardBlendFor(method: SurfaceTrackingMethod): number {
  return method === 'kcf' ? 0.55 : method === 'template' ? 0.35 : 0.15;
}

function localConfidenceWeightFor(method: SurfaceTrackingMethod): number {
  return method === 'kcf'
    ? 0.68
    : method === 'homography' || method === 'shape'
      ? 0.7
      : method === 'template'
        ? 0.58
        : 0.48;
}

function normalizeWeights(weights: { local: number; global: number; memory: number }): {
  local: number;
  global: number;
  memory: number;
} {
  const total = Math.max(1e-6, weights.local + weights.global + weights.memory);
  return {
    local: weights.local / total,
    global: weights.global / total,
    memory: weights.memory / total,
  };
}

function localConfidenceAt(observation: SurfaceTrackerResult | undefined, nowNs: number): number {
  if (!observation) return 0;
  const ageMs = Math.max(0, (nowNs - observation.observedAtNs) / NS_PER_MS);
  if (ageMs >= LOCAL_OBSERVATION_MAX_AGE_MS) return 0;
  const ageWeight = 1 - ageMs / LOCAL_OBSERVATION_MAX_AGE_MS;
  return clamp01(observation.confidence * ageWeight);
}

function surfaceFieldsAt(
  observation: SurfaceTrackerResult | undefined,
  nowNs: number,
  localConfidence: number,
): Pick<
  OverlayUpdatePingPositionPayload,
  'trackingMethod' | 'surfaceConfidence' | 'surfaceLockKind'
> {
  if (!observation) {
    return { trackingMethod: 'prediction', surfaceConfidence: 0, surfaceLockKind: 'unknown' };
  }
  const ageMs = Math.max(0, (nowNs - observation.observedAtNs) / NS_PER_MS);
  if (ageMs >= LOCAL_OBSERVATION_MAX_AGE_MS) {
    return { trackingMethod: 'prediction', surfaceConfidence: 0, surfaceLockKind: 'unknown' };
  }
  return {
    trackingMethod: observation.trackingMethod ?? 'klt',
    surfaceConfidence: observation.surfaceConfidence ?? localConfidence,
    surfaceLockKind: observation.surfaceLockKind ?? 'unknown',
  };
}

function stateForConfidence(
  confidence: number,
): NonNullable<OverlayUpdatePingPositionPayload['trackingState']> {
  if (confidence >= 0.8) return 'exact';
  if (confidence >= 0.5) return 'uncertain';
  if (confidence >= 0.2) return 'directional';
  return 'lost';
}

function uncertaintyForConfidence(confidence: number): number {
  return UNCERTAINTY_MIN_PX + (1 - clamp01(confidence)) * UNCERTAINTY_RANGE_PX;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

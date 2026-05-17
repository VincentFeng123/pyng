export type Ping = {
  id: string;
  bearingDeg: number;
  pitchBearingDeg: number;
  createdAtMs: number;
  expiresAtMs: number;
  confidence: number;
};

export type FlowEstimate = {
  yawDeltaDeg: number;
  pitchDeltaDeg?: number;
  confidence: number;
  medianDxPx: number;
  medianDyPx?: number;
  trackedPointCount: number;
  minTrackedPoints?: number;
  rejectedReason?: string;
  opticalBlendWeight?: number;
};

export type TrackerConfig = {
  screenWidth: number;
  screenHeight: number;
  horizontalFovDeg: number;
  verticalFovDeg: number;
  mouseSensitivityDegPerPx: number;
  opticalFlowWeight: number;
  minTrackedPoints: number;
  maxReasonableDxPx: number;
  maxReasonableYawDeltaDeg: number;
  maxReasonablePitchDeltaDeg: number;
  flowSpreadRejectThresholdPx: number;
  pingLifetimeMs: number;
};

export type PingProjection = {
  id: string;
  screenX: number;
  screenY: number;
  confidence: number;
  isEdgeArrow: boolean;
  arrowAngle?: number;
};

type StoredPing = Ping & {
  initialScreenX: number;
  initialScreenY: number;
  sourceUsername?: string;
};

type FlowValidation = { ok: true; confidence: number } | { ok: false; rejectedReason: string };

type MotionLike = {
  yawDelta: number;
  pitchDelta: number;
  confidence: number;
  inlierCount: number;
  dxPx: number;
  dyPx: number;
};

const DEG = Math.PI / 180;
const INSET = 40;
const EPSILON = 1e-6;
const MOUSE_PREDICTION_EPSILON_DEG = 0.08;
const OPTICAL_STATIONARY_DEADZONE_DEG = 0.32;
const OPTICAL_STATIONARY_MIN_INCREMENT_DEG = 0.1;
const OPTICAL_MOUSE_CORRECTION_DEADZONE_DEG = 0.35;
const AUTHORITATIVE_OPTICAL_WEIGHT = 0.5;
const DEFAULT_CONFIG: TrackerConfig = {
  screenWidth: 1920,
  screenHeight: 1080,
  horizontalFovDeg: 70,
  verticalFovDeg: 43,
  mouseSensitivityDegPerPx: 1 / 8,
  opticalFlowWeight: 0.08,
  minTrackedPoints: 24,
  maxReasonableDxPx: 160,
  maxReasonableYawDeltaDeg: 45,
  maxReasonablePitchDeltaDeg: 35,
  flowSpreadRejectThresholdPx: 42,
  pingLifetimeMs: 2500,
};

export class DirectionalPingTracker {
  private active: Map<string, StoredPing> = new Map();
  private config: TrackerConfig;
  private yawDeg = 0;
  private pitchDeg = 0;
  private mouseYawSinceLastFlowDeg = 0;
  private mousePitchSinceLastFlowDeg = 0;
  private pendingOpticalYawDeg = 0;
  private pendingOpticalPitchDeg = 0;

  constructor(config: Partial<TrackerConfig> = {}) {
    this.config = normalizeConfig({ ...DEFAULT_CONFIG, ...config });
  }

  updateConfig(config: Partial<TrackerConfig>): void {
    this.config = normalizeConfig({ ...this.config, ...config });
  }

  getConfig(): TrackerConfig {
    return { ...this.config };
  }

  getYawDeg(): number {
    return this.yawDeg;
  }

  setYawDeg(yawDeg: number): void {
    this.yawDeg = normalizeSignedDeg(yawDeg);
    this.mouseYawSinceLastFlowDeg = 0;
    this.resetPendingOptical();
  }

  getPitchDeg(): number {
    return this.pitchDeg;
  }

  setPitchDeg(pitchDeg: number): void {
    this.pitchDeg = finiteOr(pitchDeg, 0);
    this.mousePitchSinceLastFlowDeg = 0;
    this.resetPendingOptical();
  }

  getActiveCount(): number {
    return this.active.size;
  }

  getPing(id: string): Ping | null {
    const ping = this.active.get(id);
    if (!ping) return null;
    return toPublicPing(ping);
  }

  getPings(): Ping[] {
    return Array.from(this.active.values(), toPublicPing);
  }

  addPingAtBearing(
    id: string,
    relativeBearingDeg: number,
    relativePitchDeg = 0,
    nowMs = Date.now(),
    ttlMs = this.config.pingLifetimeMs,
    sourceUsername?: string,
  ): void {
    const bearingDeg = normalizeSignedDeg(this.yawDeg + relativeBearingDeg);
    const pitchBearingDeg = this.pitchDeg + relativePitchDeg;
    const screenX = this.screenXFromRelativeBearing(relativeBearingDeg);
    const screenY = this.screenYFromRelativePitch(relativePitchDeg);
    this.active.set(id, {
      id,
      bearingDeg,
      pitchBearingDeg,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      confidence: 1,
      initialScreenX: screenX,
      initialScreenY: screenY,
      sourceUsername,
    });
  }

  addPingAtScreen(
    id: string,
    screenX: number,
    screenY = this.config.screenHeight / 2,
    nowMs = Date.now(),
    ttlMs = this.config.pingLifetimeMs,
    sourceUsername?: string,
  ): void {
    const relativeBearingDeg = this.relativeBearingFromScreenX(screenX);
    const relativePitchDeg = this.relativePitchFromScreenY(screenY);
    this.active.set(id, {
      id,
      bearingDeg: normalizeSignedDeg(this.yawDeg + relativeBearingDeg),
      pitchBearingDeg: this.pitchDeg + relativePitchDeg,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      confidence: 1,
      initialScreenX: screenX,
      initialScreenY: screenY,
      sourceUsername,
    });
  }

  addPing(
    id: string,
    screenX: number,
    screenY: number,
    screenW: number,
    screenH: number,
    fovH: number,
    fovV: number,
    ttlMs: number,
    sourceUsername?: string,
  ): void {
    this.updateConfig({
      screenWidth: screenW,
      screenHeight: screenH,
      horizontalFovDeg: fovH,
      verticalFovDeg: fovV,
      pingLifetimeMs: ttlMs,
    });
    this.addPingAtScreen(id, screenX, screenY, Date.now(), ttlMs, sourceUsername);
  }

  removePing(id: string): void {
    this.active.delete(id);
  }

  clear(): void {
    this.active.clear();
    this.mouseYawSinceLastFlowDeg = 0;
    this.mousePitchSinceLastFlowDeg = 0;
    this.resetPendingOptical();
  }

  applyMouseDelta(dxPx: number, dyPx = 0): boolean {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return false;
    const yawDeltaDeg = dxPx * this.config.mouseSensitivityDegPerPx;
    const pitchDeltaDeg = -dyPx * this.config.mouseSensitivityDegPerPx;
    if (Math.abs(yawDeltaDeg) < EPSILON && Math.abs(pitchDeltaDeg) < EPSILON) return false;

    if (Math.abs(yawDeltaDeg) >= EPSILON) {
      this.yawDeg = normalizeSignedDeg(this.yawDeg + yawDeltaDeg);
      this.mouseYawSinceLastFlowDeg += yawDeltaDeg;
    }
    if (Math.abs(pitchDeltaDeg) >= EPSILON) {
      this.pitchDeg += pitchDeltaDeg;
      this.mousePitchSinceLastFlowDeg += pitchDeltaDeg;
    }
    this.resetPendingOptical();
    return true;
  }

  applyOpticalFlow(flow: FlowEstimate): boolean {
    const validation = this.validateFlow(flow);
    if (!validation.ok) {
      this.mouseYawSinceLastFlowDeg = 0;
      this.mousePitchSinceLastFlowDeg = 0;
      this.resetPendingOptical();
      this.fadeConfidence(0.9);
      return false;
    }

    const opticalWeight =
      flow.opticalBlendWeight !== undefined
        ? clamp01(flow.opticalBlendWeight)
        : clamp01(this.config.opticalFlowWeight * validation.confidence);
    const mouseYawDelta = this.mouseYawSinceLastFlowDeg;
    let visualYawDelta = flow.yawDeltaDeg;
    const hasMousePrediction =
      Math.abs(mouseYawDelta) > MOUSE_PREDICTION_EPSILON_DEG ||
      Math.abs(this.mousePitchSinceLastFlowDeg) > MOUSE_PREDICTION_EPSILON_DEG;

    if (!hasMousePrediction && opticalWeight >= AUTHORITATIVE_OPTICAL_WEIGHT) {
      const stabilized = this.stabilizeAuthoritativeOpticalFlow(
        visualYawDelta,
        flow.pitchDeltaDeg ?? this.mousePitchSinceLastFlowDeg,
        validation.confidence,
      );
      visualYawDelta = stabilized.yawDeltaDeg;
      flow = { ...flow, pitchDeltaDeg: stabilized.pitchDeltaDeg };
    } else {
      this.resetPendingOptical();
      if (hasMousePrediction) {
        const yawDisagreementDeg = normalizeSignedDeg(visualYawDelta - mouseYawDelta);
        visualYawDelta = normalizeSignedDeg(
          mouseYawDelta + removeDeadzone(yawDisagreementDeg, OPTICAL_MOUSE_CORRECTION_DEADZONE_DEG),
        );
      }
    }

    const blendedYawDelta = lerp(mouseYawDelta, visualYawDelta, opticalWeight);
    const yawCorrectionDeg = blendedYawDelta - mouseYawDelta;

    const mousePitchDelta = this.mousePitchSinceLastFlowDeg;
    let visualPitchDelta = flow.pitchDeltaDeg ?? mousePitchDelta;
    if (hasMousePrediction) {
      const pitchDisagreementDeg = visualPitchDelta - mousePitchDelta;
      visualPitchDelta =
        mousePitchDelta +
        removeDeadzone(pitchDisagreementDeg, OPTICAL_MOUSE_CORRECTION_DEADZONE_DEG);
    }
    const blendedPitchDelta = lerp(mousePitchDelta, visualPitchDelta, opticalWeight);
    const pitchCorrectionDeg = blendedPitchDelta - mousePitchDelta;

    if (Math.abs(yawCorrectionDeg) >= EPSILON) {
      this.yawDeg = normalizeSignedDeg(this.yawDeg + yawCorrectionDeg);
    }
    if (Math.abs(pitchCorrectionDeg) >= EPSILON) {
      this.pitchDeg += pitchCorrectionDeg;
    }

    this.mouseYawSinceLastFlowDeg = 0;
    this.mousePitchSinceLastFlowDeg = 0;
    this.updatePingConfidence(validation.confidence);
    return true;
  }

  private stabilizeAuthoritativeOpticalFlow(
    yawDeltaDeg: number,
    pitchDeltaDeg: number,
    confidence: number,
  ): { yawDeltaDeg: number; pitchDeltaDeg: number } {
    const deadzoneDeg = OPTICAL_STATIONARY_DEADZONE_DEG + (1 - clamp01(confidence)) * 0.18;

    const yaw = stabilizeOpticalAxis(this.pendingOpticalYawDeg, yawDeltaDeg, deadzoneDeg, true);
    const pitch = stabilizeOpticalAxis(
      this.pendingOpticalPitchDeg,
      pitchDeltaDeg,
      deadzoneDeg,
      false,
    );
    this.pendingOpticalYawDeg = yaw.pendingDeg;
    this.pendingOpticalPitchDeg = pitch.pendingDeg;

    return {
      yawDeltaDeg: yaw.outputDeg,
      pitchDeltaDeg: pitch.outputDeg,
    };
  }

  private resetPendingOptical(): void {
    this.pendingOpticalYawDeg = 0;
    this.pendingOpticalPitchDeg = 0;
  }

  applyVisualBearingCorrection(
    id: string,
    observedScreenX: number,
    observedScreenY: number,
    confidence: number,
    gain = 0.45,
    maxCorrectionDeg = 3,
  ): boolean {
    const ping = this.active.get(id);
    if (!ping) return false;
    if (!Number.isFinite(observedScreenX) || !Number.isFinite(observedScreenY)) return false;

    const currentRelativeYawDeg = normalizeSignedDeg(ping.bearingDeg - this.yawDeg);
    const observedRelativeYawDeg = this.relativeBearingFromScreenX(observedScreenX);
    const rawYawCorrectionDeg = normalizeSignedDeg(currentRelativeYawDeg - observedRelativeYawDeg);
    const yawCorrectionDeg = clamp(
      rawYawCorrectionDeg * clamp01(confidence) * clamp(gain, 0, 1),
      -Math.abs(maxCorrectionDeg),
      Math.abs(maxCorrectionDeg),
    );

    const currentRelativePitchDeg = ping.pitchBearingDeg - this.pitchDeg;
    const observedRelativePitchDeg = this.relativePitchFromScreenY(observedScreenY);
    const rawPitchCorrectionDeg = currentRelativePitchDeg - observedRelativePitchDeg;
    const pitchCorrectionDeg = clamp(
      rawPitchCorrectionDeg * clamp01(confidence) * clamp(gain, 0, 1),
      -Math.abs(maxCorrectionDeg),
      Math.abs(maxCorrectionDeg),
    );

    if (Math.abs(yawCorrectionDeg) < EPSILON && Math.abs(pitchCorrectionDeg) < EPSILON) {
      return false;
    }

    if (Math.abs(yawCorrectionDeg) >= EPSILON) {
      this.yawDeg = normalizeSignedDeg(this.yawDeg + yawCorrectionDeg);
    }
    if (Math.abs(pitchCorrectionDeg) >= EPSILON) {
      this.pitchDeg += pitchCorrectionDeg;
    }
    ping.confidence = clamp01(0.84 * ping.confidence + 0.16 * clamp01(confidence));
    return true;
  }

  applyMotion(motion: MotionLike): void {
    this.applyOpticalFlow({
      yawDeltaDeg: motion.yawDelta,
      pitchDeltaDeg: motion.pitchDelta,
      confidence: motion.confidence,
      medianDxPx: motion.dxPx,
      medianDyPx: motion.dyPx,
      trackedPointCount: motion.inlierCount,
    });
  }

  fadeConfidence(factor = 0.92): void {
    const safeFactor = clamp(factor, 0, 1);
    for (const ping of this.active.values()) {
      ping.confidence *= safeFactor;
    }
  }

  projectAll(
    nowMs: number,
    screenW = this.config.screenWidth,
    screenH = this.config.screenHeight,
    fovH = this.config.horizontalFovDeg,
    fovV = this.config.verticalFovDeg,
  ): PingProjection[] {
    this.updateConfig({
      screenWidth: screenW,
      screenHeight: screenH,
      horizontalFovDeg: fovH,
      verticalFovDeg: fovV,
    });
    this.pruneExpired(nowMs);

    const projections: PingProjection[] = [];
    for (const ping of this.active.values()) {
      projections.push(this.projectPing(ping));
    }
    return projections;
  }

  projectAllAtPose(
    nowMs: number,
    yawDeg: number,
    pitchDeg: number,
    screenW = this.config.screenWidth,
    screenH = this.config.screenHeight,
    fovH = this.config.horizontalFovDeg,
    fovV = this.config.verticalFovDeg,
  ): PingProjection[] {
    this.updateConfig({
      screenWidth: screenW,
      screenHeight: screenH,
      horizontalFovDeg: fovH,
      verticalFovDeg: fovV,
    });
    this.pruneExpired(nowMs);

    const projections: PingProjection[] = [];
    for (const ping of this.active.values()) {
      projections.push(this.projectPing(ping, normalizeSignedDeg(yawDeg), finiteOr(pitchDeg, 0)));
    }
    return projections;
  }

  private validateFlow(flow: FlowEstimate): FlowValidation {
    if (flow.rejectedReason) {
      return { ok: false, rejectedReason: flow.rejectedReason };
    }
    const pitchDeltaDeg = flow.pitchDeltaDeg ?? 0;
    const medianDyPx = flow.medianDyPx ?? 0;
    if (
      !Number.isFinite(flow.yawDeltaDeg) ||
      !Number.isFinite(pitchDeltaDeg) ||
      !Number.isFinite(flow.medianDxPx) ||
      !Number.isFinite(medianDyPx)
    ) {
      return { ok: false, rejectedReason: 'non-finite-flow' };
    }
    const minTrackedPoints = Math.max(1, flow.minTrackedPoints ?? this.config.minTrackedPoints);
    if (flow.trackedPointCount < minTrackedPoints) {
      return { ok: false, rejectedReason: 'too-few-tracked-points' };
    }
    if (
      Math.abs(flow.yawDeltaDeg) > this.config.maxReasonableYawDeltaDeg ||
      Math.abs(pitchDeltaDeg) > this.config.maxReasonablePitchDeltaDeg
    ) {
      return { ok: false, rejectedReason: 'unreasonable-angular-flow' };
    }

    const confidence = clamp01(flow.confidence);
    const hasMousePrediction =
      Math.abs(this.mouseYawSinceLastFlowDeg) > 0.1 ||
      Math.abs(this.mousePitchSinceLastFlowDeg) > 0.1;
    const yawDisagreementDeg = Math.abs(
      normalizeSignedDeg(flow.yawDeltaDeg - this.mouseYawSinceLastFlowDeg),
    );
    const pitchDisagreementDeg = Math.abs(pitchDeltaDeg - this.mousePitchSinceLastFlowDeg);
    const yawRejectThresholdDeg = Math.max(
      2,
      this.config.flowSpreadRejectThresholdPx *
        (this.config.horizontalFovDeg / this.config.screenWidth),
    );
    const pitchRejectThresholdDeg = Math.max(
      2,
      this.config.flowSpreadRejectThresholdPx *
        (this.config.verticalFovDeg / this.config.screenHeight),
    );
    const yawSignFlipped = signsStronglyDisagree(
      this.mouseYawSinceLastFlowDeg,
      flow.yawDeltaDeg,
      yawDisagreementDeg,
      yawRejectThresholdDeg,
    );
    const pitchSignFlipped = signsStronglyDisagree(
      this.mousePitchSinceLastFlowDeg,
      pitchDeltaDeg,
      pitchDisagreementDeg,
      pitchRejectThresholdDeg,
    );
    if (hasMousePrediction && (yawSignFlipped || pitchSignFlipped)) {
      return { ok: false, rejectedReason: 'mouse-flow-disagreement' };
    }

    if (confidence <= EPSILON) {
      return { ok: false, rejectedReason: 'zero-confidence-flow' };
    }
    return { ok: true, confidence };
  }

  private updatePingConfidence(flowConfidence: number): void {
    const target = clamp01(flowConfidence);
    for (const ping of this.active.values()) {
      ping.confidence = clamp01(0.9 * ping.confidence + 0.1 * target);
    }
  }

  private pruneExpired(nowMs: number): void {
    for (const ping of this.active.values()) {
      if (nowMs > ping.expiresAtMs) {
        this.active.delete(ping.id);
      }
    }
  }

  private projectPing(
    ping: StoredPing,
    yawDeg = this.yawDeg,
    pitchDeg = this.pitchDeg,
  ): PingProjection {
    const relativeYawDeg = normalizeSignedDeg(ping.bearingDeg - yawDeg);
    const relativePitchDeg = ping.pitchBearingDeg - pitchDeg;
    const halfFovH = this.config.horizontalFovDeg / 2;
    const halfFovV = this.config.verticalFovDeg / 2;

    if (Math.abs(relativeYawDeg) <= halfFovH && Math.abs(relativePitchDeg) <= halfFovV) {
      return {
        id: ping.id,
        screenX: this.screenXFromRelativeBearing(relativeYawDeg),
        screenY: this.screenYFromRelativePitch(relativePitchDeg),
        confidence: ping.confidence,
        isEdgeArrow: false,
      };
    }

    const edge = this.edgePointAndAngle(relativeYawDeg, relativePitchDeg);
    return {
      id: ping.id,
      screenX: edge.x,
      screenY: edge.y,
      confidence: ping.confidence,
      isEdgeArrow: true,
      arrowAngle: edge.angle,
    };
  }

  private relativeBearingFromScreenX(screenX: number): number {
    const fx = focalX(this.config.screenWidth, this.config.horizontalFovDeg);
    return Math.atan2(screenX - this.config.screenWidth / 2, fx) / DEG;
  }

  private screenXFromRelativeBearing(relativeBearingDeg: number): number {
    const fx = focalX(this.config.screenWidth, this.config.horizontalFovDeg);
    return this.config.screenWidth / 2 + Math.tan(relativeBearingDeg * DEG) * fx;
  }

  private relativePitchFromScreenY(screenY: number): number {
    const fy = focalY(this.config.screenHeight, this.config.verticalFovDeg);
    return Math.atan2(this.config.screenHeight / 2 - screenY, fy) / DEG;
  }

  private screenYFromRelativePitch(relativePitchDeg: number): number {
    const fy = focalY(this.config.screenHeight, this.config.verticalFovDeg);
    return this.config.screenHeight / 2 - Math.tan(relativePitchDeg * DEG) * fy;
  }

  private edgePointAndAngle(
    relativeYawDeg: number,
    relativePitchDeg: number,
  ): { x: number; y: number; angle: number } {
    const halfFovH = this.config.horizontalFovDeg / 2;
    const halfFovV = this.config.verticalFovDeg / 2;
    const nx = safeRatio(relativeYawDeg, halfFovH);
    const ny = -safeRatio(relativePitchDeg, halfFovV);
    const scale = Math.max(Math.abs(nx), Math.abs(ny), 1);
    const edgeNx = nx / scale;
    const edgeNy = ny / scale;
    const halfUsableW = Math.max(1, this.config.screenWidth / 2 - INSET);
    const halfUsableH = Math.max(1, this.config.screenHeight / 2 - INSET);

    return {
      x: this.config.screenWidth / 2 + edgeNx * halfUsableW,
      y: this.config.screenHeight / 2 + edgeNy * halfUsableH,
      angle: Math.atan2(edgeNy, edgeNx) / DEG,
    };
  }
}

function normalizeConfig(config: TrackerConfig): TrackerConfig {
  return {
    screenWidth: Math.max(1, finiteOr(config.screenWidth, DEFAULT_CONFIG.screenWidth)),
    screenHeight: Math.max(1, finiteOr(config.screenHeight, DEFAULT_CONFIG.screenHeight)),
    horizontalFovDeg: clamp(
      finiteOr(config.horizontalFovDeg, DEFAULT_CONFIG.horizontalFovDeg),
      30,
      140,
    ),
    verticalFovDeg: clamp(finiteOr(config.verticalFovDeg, DEFAULT_CONFIG.verticalFovDeg), 20, 120),
    mouseSensitivityDegPerPx: Math.max(
      EPSILON,
      finiteOr(config.mouseSensitivityDegPerPx, DEFAULT_CONFIG.mouseSensitivityDegPerPx),
    ),
    opticalFlowWeight: clamp01(
      finiteOr(config.opticalFlowWeight, DEFAULT_CONFIG.opticalFlowWeight),
    ),
    minTrackedPoints: Math.max(
      1,
      Math.round(finiteOr(config.minTrackedPoints, DEFAULT_CONFIG.minTrackedPoints)),
    ),
    maxReasonableDxPx: Math.max(
      1,
      finiteOr(config.maxReasonableDxPx, DEFAULT_CONFIG.maxReasonableDxPx),
    ),
    maxReasonableYawDeltaDeg: Math.max(
      1,
      finiteOr(config.maxReasonableYawDeltaDeg, DEFAULT_CONFIG.maxReasonableYawDeltaDeg),
    ),
    maxReasonablePitchDeltaDeg: Math.max(
      1,
      finiteOr(config.maxReasonablePitchDeltaDeg, DEFAULT_CONFIG.maxReasonablePitchDeltaDeg),
    ),
    flowSpreadRejectThresholdPx: Math.max(
      1,
      finiteOr(config.flowSpreadRejectThresholdPx, DEFAULT_CONFIG.flowSpreadRejectThresholdPx),
    ),
    pingLifetimeMs: Math.max(1, finiteOr(config.pingLifetimeMs, DEFAULT_CONFIG.pingLifetimeMs)),
  };
}

function toPublicPing(ping: StoredPing): Ping {
  return {
    id: ping.id,
    bearingDeg: ping.bearingDeg,
    pitchBearingDeg: ping.pitchBearingDeg,
    createdAtMs: ping.createdAtMs,
    expiresAtMs: ping.expiresAtMs,
    confidence: ping.confidence,
  };
}

function focalX(screenW: number, fovH: number): number {
  return screenW / 2 / Math.tan((fovH / 2) * DEG);
}

function focalY(screenH: number, fovV: number): number {
  return screenH / 2 / Math.tan((fovV / 2) * DEG);
}

function normalizeSignedDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
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

function signsStronglyDisagree(
  expected: number,
  actual: number,
  disagreementDeg: number,
  thresholdDeg: number,
): boolean {
  if (Math.abs(expected) <= 0.5 || Math.abs(actual) <= 0.5) return false;
  if (Math.sign(expected) === Math.sign(actual)) return false;
  return disagreementDeg > thresholdDeg;
}

function removeDeadzone(value: number, deadzone: number): number {
  const safeDeadzone = Math.max(0, finiteOr(deadzone, 0));
  const magnitude = Math.abs(value);
  if (magnitude <= safeDeadzone) return 0;
  return Math.sign(value) * (magnitude - safeDeadzone);
}

function stabilizeOpticalAxis(
  pendingDeg: number,
  deltaDeg: number,
  deadzoneDeg: number,
  wrap: boolean,
): { pendingDeg: number; outputDeg: number } {
  if (Math.abs(deltaDeg) < OPTICAL_STATIONARY_MIN_INCREMENT_DEG) {
    return { pendingDeg: pendingDeg * 0.5, outputDeg: 0 };
  }

  const sameDirection =
    Math.abs(pendingDeg) < EPSILON || Math.sign(pendingDeg) === Math.sign(deltaDeg);
  const nextPendingDeg = sameDirection ? pendingDeg + deltaDeg : deltaDeg;
  if (Math.abs(nextPendingDeg) < deadzoneDeg) {
    return { pendingDeg: wrap ? normalizeSignedDeg(nextPendingDeg) : nextPendingDeg, outputDeg: 0 };
  }

  return { pendingDeg: 0, outputDeg: wrap ? normalizeSignedDeg(nextPendingDeg) : nextPendingDeg };
}

function safeRatio(value: number, divisor: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(divisor) || Math.abs(divisor) < EPSILON) return Math.sign(value);
  return value / divisor;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

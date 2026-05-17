const NS_PER_MS = 1_000_000;
const DEFAULT_LEAD_MS = 5;
const MAX_LEAD_MS = 9;
const MAX_INPUT_AGE_CREDIT_MS = 10;
const MAX_PREDICTION_HORIZON_MS = 18;
const STALE_INPUT_MS = 60;
const DECAY_START_MS = 8;
const VELOCITY_ALPHA = 0.38;
const MAX_PREDICTED_DELTA_DEG = 3;
const MIN_VELOCITY_DT_MS = 0.25;
const MAX_VELOCITY_DT_MS = 50;
const DEG_WRAP = 360;

export type MotionPredictorPose = {
  yawDeg: number;
  pitchDeg: number;
  predictedAtNs: number;
  leadMs: number;
};

export class MotionPredictor {
  private lastInputTimeNs: number | null = null;
  private yawVelocityDegPerMs = 0;
  private pitchVelocityDegPerMs = 0;
  private leadMs = DEFAULT_LEAD_MS;

  reset(): void {
    this.lastInputTimeNs = null;
    this.yawVelocityDegPerMs = 0;
    this.pitchVelocityDegPerMs = 0;
    this.leadMs = DEFAULT_LEAD_MS;
  }

  recordMouseDelta(
    dxPx: number,
    dyPx: number,
    sensitivityDegPerPx: number,
    eventTimeNs = monotonicNowNs(),
  ): void {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    if (!Number.isFinite(sensitivityDegPerPx) || sensitivityDegPerPx <= 0) return;
    if (!Number.isFinite(eventTimeNs) || eventTimeNs <= 0) eventTimeNs = monotonicNowNs();

    const yawDeltaDeg = dxPx * sensitivityDegPerPx;
    const pitchDeltaDeg = -dyPx * sensitivityDegPerPx;
    if (yawDeltaDeg === 0 && pitchDeltaDeg === 0) return;

    if (this.lastInputTimeNs !== null) {
      const dtMs = (eventTimeNs - this.lastInputTimeNs) / NS_PER_MS;
      if (dtMs >= MIN_VELOCITY_DT_MS && dtMs <= MAX_VELOCITY_DT_MS) {
        this.yawVelocityDegPerMs = smooth(
          this.yawVelocityDegPerMs,
          yawDeltaDeg / dtMs,
          VELOCITY_ALPHA,
        );
        this.pitchVelocityDegPerMs = smooth(
          this.pitchVelocityDegPerMs,
          pitchDeltaDeg / dtMs,
          VELOCITY_ALPHA,
        );
        this.leadMs = clamp(dtMs * 0.65, 3.5, MAX_LEAD_MS);
      } else if (dtMs > MAX_VELOCITY_DT_MS) {
        this.dampenVelocity(0);
        this.leadMs = DEFAULT_LEAD_MS;
      }
    }

    this.lastInputTimeNs = eventTimeNs;
  }

  dampenVelocity(factor: number): void {
    const safeFactor = clamp(factor, 0, 1);
    this.yawVelocityDegPerMs *= safeFactor;
    this.pitchVelocityDegPerMs *= safeFactor;
  }

  predictPose(
    baseYawDeg: number,
    basePitchDeg: number,
    nowNs = monotonicNowNs(),
  ): MotionPredictorPose {
    const leadMs = clamp(this.leadMs, 0, MAX_LEAD_MS);
    const predictedAtNs = nowNs + leadMs * NS_PER_MS;
    if (this.lastInputTimeNs === null) {
      return {
        yawDeg: normalizeSignedDeg(baseYawDeg),
        pitchDeg: basePitchDeg,
        predictedAtNs,
        leadMs: 0,
      };
    }

    const inputAgeMs = Math.max(0, (nowNs - this.lastInputTimeNs) / NS_PER_MS);
    if (inputAgeMs >= STALE_INPUT_MS) {
      this.dampenVelocity(0);
      return {
        yawDeg: normalizeSignedDeg(baseYawDeg),
        pitchDeg: basePitchDeg,
        predictedAtNs,
        leadMs: 0,
      };
    }

    const freshness =
      1 - clamp((inputAgeMs - DECAY_START_MS) / (STALE_INPUT_MS - DECAY_START_MS), 0, 1);
    const horizonMs = clamp(
      leadMs + Math.min(inputAgeMs, MAX_INPUT_AGE_CREDIT_MS),
      0,
      MAX_PREDICTION_HORIZON_MS,
    );
    const predictedYawDelta = clamp(
      this.yawVelocityDegPerMs * horizonMs * freshness,
      -MAX_PREDICTED_DELTA_DEG,
      MAX_PREDICTED_DELTA_DEG,
    );
    const predictedPitchDelta = clamp(
      this.pitchVelocityDegPerMs * horizonMs * freshness,
      -MAX_PREDICTED_DELTA_DEG,
      MAX_PREDICTED_DELTA_DEG,
    );

    return {
      yawDeg: normalizeSignedDeg(baseYawDeg + predictedYawDelta),
      pitchDeg: basePitchDeg + predictedPitchDelta,
      predictedAtNs,
      leadMs,
    };
  }
}

export function monotonicNowNs(): number {
  return Number(process.hrtime.bigint());
}

function smooth(previous: number, next: number, alpha: number): number {
  return previous + (next - previous) * clamp(alpha, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeSignedDeg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  let next = value % DEG_WRAP;
  if (next > 180) next -= DEG_WRAP;
  if (next <= -180) next += DEG_WRAP;
  return next;
}

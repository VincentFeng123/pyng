// MotionResult is produced by the motion estimator (task #92). Stubbed here so
// this module compiles independently.
export type MotionResult = {
  yawDelta: number;
  pitchDelta: number;
  inlierCount: number;
  dxPx?: number;
  dyPx?: number;
};

type DeltaSample = {
  dx: number;
  dy: number;
  ts: number;
};

export type DeltaSummary = {
  dx: number;
  dy: number;
  absDx: number;
  absDy: number;
  eventCount: number;
  ageMs: number | null;
};

export type ConfidenceEstimatorOptions = {
  bufferSize?: number;
};

export class ConfidenceEstimator {
  private readonly bufferSize: number;
  private buffer: DeltaSample[];
  private lastEventAt: number = 0;

  constructor(options?: ConfidenceEstimatorOptions) {
    this.bufferSize = options?.bufferSize ?? 512;
    this.buffer = [];
  }

  recordMouseDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) {
      return;
    }

    const ts = Date.now();
    if (this.buffer.length >= this.bufferSize) {
      // Drop oldest entry to keep ring buffer bounded.
      this.buffer.shift();
    }
    this.buffer.push({ dx, dy, ts });
    this.lastEventAt = ts;
  }

  score(motionResult: MotionResult, mousePixelsPerDegree: number = 8.0): number {
    const now = Date.now();
    const hasRecentEvents = this.lastEventAt > 0 && now - this.lastEventAt <= 1000;

    if (!hasRecentEvents) {
      this.reset();
      return inlierFallback(motionResult);
    }

    let accDx = 0;
    let accDy = 0;
    let absDx = 0;
    let absDy = 0;
    for (const s of this.buffer) {
      accDx += s.dx;
      accDy += s.dy;
      absDx += Math.abs(s.dx);
      absDy += Math.abs(s.dy);
    }

    this.reset();

    // Fullscreen games often confine or recenter the OS cursor while the camera
    // moves. In that mode uIOhook can report zero/cancelling absolute deltas,
    // which is not a trustworthy mouse signal. Fall back to optical-flow
    // confidence instead of vetoing real camera motion.
    if (Math.hypot(accDx, accDy) < 2 || Math.hypot(absDx, absDy) < 2) {
      return inlierFallback(motionResult);
    }

    // Rightward mouse movement rotates the camera right, which is positive yaw
    // in PingTracker.applyMotion(). Upward mouse movement has negative screen
    // dy, but positive camera pitch.
    const expectedYaw = accDx / mousePixelsPerDegree;
    const expectedPitch = -accDy / mousePixelsPerDegree;

    const actualYaw = motionResult.yawDelta;
    const actualPitch = motionResult.pitchDelta;

    // Use the axis with larger magnitude to avoid division-near-zero noise.
    const useYaw = Math.abs(expectedYaw) >= Math.abs(expectedPitch);
    const expected = useYaw ? expectedYaw : expectedPitch;
    const actual = useYaw ? actualYaw : actualPitch;

    if (Math.abs(expected) < 1e-9 && Math.abs(actual) < 1e-9) {
      // Both near-zero: no motion on either side, treat as agreement.
      return 1.0;
    }

    if (Math.abs(expected) < 1e-9) {
      // Mouse held still but camera moved — likely a scene cut.
      return 0.0;
    }

    const signsAgree = Math.sign(expected) === Math.sign(actual);

    if (!signsAgree) {
      return 0.0;
    }

    const ratio = Math.abs(actual) / Math.abs(expected);
    if (ratio >= 0.8 && ratio <= 1.2) {
      return 1.0;
    }

    // Signs agree but magnitude disagrees.
    const raw = 0.3 + 0.4 * (1 - Math.abs(ratio - 1));
    return Math.max(0.3, Math.min(0.7, raw));
  }

  getAccumulatedDelta(): { dx: number; dy: number; eventCount: number } {
    let dx = 0;
    let dy = 0;
    for (const s of this.buffer) {
      dx += s.dx;
      dy += s.dy;
    }
    return { dx, dy, eventCount: this.buffer.length };
  }

  consumeAccumulatedDelta(): DeltaSummary {
    const now = Date.now();
    let dx = 0;
    let dy = 0;
    let absDx = 0;
    let absDy = 0;
    for (const s of this.buffer) {
      dx += s.dx;
      dy += s.dy;
      absDx += Math.abs(s.dx);
      absDy += Math.abs(s.dy);
    }
    const eventCount = this.buffer.length;
    const ageMs = this.lastEventAt > 0 ? now - this.lastEventAt : null;
    this.reset();
    return { dx, dy, absDx, absDy, eventCount, ageMs };
  }

  reset(): void {
    this.buffer = [];
    this.lastEventAt = 0;
  }
}

function inlierFallback(motionResult: MotionResult): number {
  return Math.min(motionResult.inlierCount / 100, 0.8);
}

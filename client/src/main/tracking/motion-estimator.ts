import type { NormalizedRect } from '@pyng/shared';
import { getNativeOpenCv } from './native-opencv.js';

export type MotionResult = {
  yawDelta: number;
  pitchDelta: number;
  confidence: number;
  inlierCount: number;
  dxPx: number;
  dyPx: number;
  model?: 'lk-rotation' | 'patch-rotation';
  residualDeg?: number;
};

export type MotionEstimatorOptions = {
  pixelsPerDegree?: number;
  horizontalFovDeg?: number;
  verticalFovDeg?: number;
  expectedYawDeltaDeg?: number;
  expectedPitchDeltaDeg?: number;
};

type NormalizedMotionOptions = {
  pixelsPerDegree: number;
  horizontalFovDeg: number;
  verticalFovDeg: number;
  expectedYawDeltaDeg?: number;
  expectedPitchDeltaDeg?: number;
};

// Minimal cv surface used by estimateMotion — injectable for tests.
export type CvApi = {
  CV_8UC1: number;
  Mat: {
    ones(rows: number, cols: number, type: number): MatLike;
    new (): MatLike;
  };
  matFromArray(rows: number, cols: number, type: number, data: ArrayBufferView): MatLike;
  Point: new (x: number, y: number) => object;
  Scalar: new (...v: number[]) => object;
  Size: new (width: number, height: number) => object;
  TermCriteria: new (type: number, maxCount: number, epsilon: number) => object;
  rectangle(mat: MatLike, pt1: object, pt2: object, color: object, thickness: number): void;
  goodFeaturesToTrack(
    src: MatLike,
    dst: MatLike,
    maxCorners: number,
    qualityLevel: number,
    minDistance: number,
    mask?: MatLike,
  ): void;
  calcOpticalFlowPyrLK(
    prev: MatLike,
    next: MatLike,
    prevPts: MatLike,
    nextPts: MatLike,
    status: MatLike,
    err: MatLike,
    winSize?: object,
    maxLevel?: number,
    criteria?: object,
    flags?: number,
    minEigThreshold?: number,
  ): void;
};

export type MatLike = {
  rows: number;
  data: Uint8Array;
  data32F: Float32Array;
  delete(): void;
};

let _warmedUp = false;

export async function warmup(): Promise<void> {
  if (_warmedUp) return;
  getNativeOpenCv();
  _warmedUp = true;
}

// Exposed for testing only.
export function _resetWarmup(): void {
  _warmedUp = false;
}

type FlowPair = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dx: number;
  dy: number;
  err: number;
};

type SearchMatch = {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  score: number;
};

type ScaledFrame = {
  buffer: Uint8Array;
  width: number;
  height: number;
  scale: number;
};

type RotationCandidate = FlowPair & {
  yawDelta: number;
  pitchDelta: number;
};

type RotationConsensus = {
  yawDelta: number;
  pitchDelta: number;
  residualDeg: number;
  inliers: FlowPair[];
};

type RotationConsensusOptions = {
  minInliers: number;
  minRadiusDeg: number;
  maxRadiusDeg: number;
};

const MAX_CORNERS = 1400;
const MIN_CORNERS = 24;
const QUALITY_LEVEL = 0.003;
const MIN_DISTANCE_PX = 4;
const INLIER_RADIUS_PX = 4;
const MAX_INLIER_RADIUS_PX = 14;
const LK_ERROR_KEEP_FRACTION = 0.85;
const LK_WINDOW_SIZE_PX = 31;
const LK_MAX_LEVEL = 4;
const LK_TERM_CRITERIA_TYPE = 3;
const LK_TERM_CRITERIA_MAX_COUNT = 30;
const LK_TERM_CRITERIA_EPSILON = 0.01;
const LK_MIN_EIG_THRESHOLD = 1e-4;
const FRAME_RELATIVE_FLOW_CAP = 0.75;
const MAX_REASONABLE_YAW_DELTA_DEG = 45;
const MAX_REASONABLE_PITCH_DELTA_DEG = 35;
const MIN_ROTATION_INLIER_RADIUS_DEG = 0.35;
const MAX_ROTATION_INLIER_RADIUS_DEG = 2.8;
const LARGE_SEARCH_SCALE = 4;
const LARGE_SEARCH_GRID_COLS = 5;
const LARGE_SEARCH_GRID_ROWS = 3;
const LARGE_SEARCH_PATCH_PX = 15;
const LARGE_SEARCH_RADIUS_PX = 84;
const LARGE_SEARCH_EXPECTED_RADIUS_PX = 32;
const LARGE_SEARCH_COARSE_STEP_PX = 4;
const LARGE_SEARCH_MIN_SCORE = 0.48;
const LARGE_SEARCH_MIN_MATCHES = 5;
const LARGE_SEARCH_MIN_INLIER_RADIUS_DEG = 0.7;
const LARGE_SEARCH_MAX_INLIER_RADIUS_DEG = 8;
const MIN_PATCH_NORM = 24;
const DEG = Math.PI / 180;

export function estimateMotion(
  prevGray: Buffer,
  currGray: Buffer,
  width: number,
  height: number,
  maskRegions: NormalizedRect[],
  calibration: number | MotionEstimatorOptions,
  // Injectable for tests. Production uses native @u4/opencv4nodejs elsewhere;
  // this LK path only runs when an OpenCV.js-shaped test double is supplied.
  _cv: CvApi | null = getNativeOpenCv() as CvApi | null,
): MotionResult | null {
  const motionOptions = normalizeMotionOptions(calibration);
  const largeMotionFallback = (): MotionResult | null =>
    estimateRotationPatchFallback(prevGray, currGray, width, height, maskRegions, motionOptions);
  if (!cvReady(_cv)) return largeMotionFallback();

  const mats: MatLike[] = [];
  const track = <T extends MatLike>(m: T): T => {
    mats.push(m);
    return m;
  };

  try {
    // Step 1 — wrap Buffers as single-channel 8-bit Mats.
    const prevGrayMat = track(_cv.matFromArray(height, width, _cv.CV_8UC1, prevGray));
    const currGrayMat = track(_cv.matFromArray(height, width, _cv.CV_8UC1, currGray));

    // Step 2 — build mask Mat (CV_8UC1, white = valid, black = HUD).
    const maskMat = track(_cv.Mat.ones(height, width, _cv.CV_8UC1));
    for (const r of maskRegions) {
      const px = Math.round(r.x * width);
      const py = Math.round(r.y * height);
      const pw = Math.round(r.w * width);
      const ph = Math.round(r.h * height);
      _cv.rectangle(
        maskMat,
        new _cv.Point(px, py),
        new _cv.Point(px + pw, py + ph),
        new _cv.Scalar(0, 0, 0, 0),
        -1,
      );
    }

    // Step 3 — Shi-Tomasi corners on prevGray within mask.
    const corners = track(new _cv.Mat());
    _cv.goodFeaturesToTrack(
      prevGrayMat,
      corners,
      MAX_CORNERS,
      QUALITY_LEVEL,
      MIN_DISTANCE_PX,
      maskMat,
    );

    // Step 4 — fall back to coarse image registration if LK has too few corners.
    if (corners.rows < MIN_CORNERS) return largeMotionFallback();

    // Step 5 — Lucas-Kanade pyramidal optical flow.
    const nextPts = track(new _cv.Mat());
    const status = track(new _cv.Mat());
    const err = track(new _cv.Mat());
    _cv.calcOpticalFlowPyrLK(
      prevGrayMat,
      currGrayMat,
      corners,
      nextPts,
      status,
      err,
      new _cv.Size(LK_WINDOW_SIZE_PX, LK_WINDOW_SIZE_PX),
      LK_MAX_LEVEL,
      new _cv.TermCriteria(
        LK_TERM_CRITERIA_TYPE,
        LK_TERM_CRITERIA_MAX_COUNT,
        LK_TERM_CRITERIA_EPSILON,
      ),
      0,
      LK_MIN_EIG_THRESHOLD,
    );

    // Step 6 — collect valid pairs: status=1 AND flow magnitude is plausible.
    // Float32Array index access types as `number | undefined` under
    // noUncheckedIndexedAccess; the loop bound `i < corners.rows`
    // guarantees the (i*2 + 1) slot is within the typed-array storage.
    // Non-null assertion satisfies the type checker without a perf cost.
    const pairs: FlowPair[] = [];
    const maxFlowMagnitudePx = Math.max(32, width * FRAME_RELATIVE_FLOW_CAP);
    for (let i = 0; i < corners.rows; i++) {
      if (status.data[i] === 0) continue;
      const x0 = corners.data32F[i * 2]!;
      const y0 = corners.data32F[i * 2 + 1]!;
      const x1 = nextPts.data32F[i * 2]!;
      const y1 = nextPts.data32F[i * 2 + 1]!;
      const dx = x1 - x0;
      const dy = y1 - y0;
      if (![x0, y0, x1, y1, dx, dy].every((value) => Number.isFinite(value))) continue;
      if (Math.hypot(dx, dy) > maxFlowMagnitudePx) continue;
      const lkErr = err.data32F.length > i ? err.data32F[i]! : 0;
      const pair = { x0, y0, x1, y1, dx, dy, err: Number.isFinite(lkErr) ? lkErr : 0 };
      if (!isReasonableAngularPair(pair, width, height, motionOptions)) continue;
      pairs.push(pair);
    }

    // Step 7 — fall back if too few valid LK pairs survived.
    if (pairs.length < MIN_CORNERS) return largeMotionFallback();

    const lowErrorPairs = filterByLkError(pairs);
    const candidatePairs = lowErrorPairs.length >= MIN_CORNERS ? lowErrorPairs : pairs;

    // Step 8 — fit a deterministic rotation model in angular space.
    //
    // Fast yaw does not move every feature by the same number of pixels; edge
    // features can have a very different dx than center features. Select
    // consensus by angular reprojection residual, and leave dx/dy as telemetry.
    const consensus = estimateRotationConsensus(candidatePairs, width, height, motionOptions, {
      minInliers: MIN_CORNERS,
      minRadiusDeg: MIN_ROTATION_INLIER_RADIUS_DEG,
      maxRadiusDeg: MAX_ROTATION_INLIER_RADIUS_DEG,
    });

    if (consensus === null) return largeMotionFallback();

    const medianDx = median(consensus.inliers.map((p) => p.dx));
    const medianDy = median(consensus.inliers.map((p) => p.dy));
    const radius = adaptiveInlierRadius(consensus.inliers, medianDx, medianDy);
    const refined = robustFlowMean(consensus.inliers, medianDx, medianDy, radius);

    // Step 9 — raw inlier-based confidence (ConfidenceEstimator further refines with mouse cross-check).
    const confidence = Math.min(consensus.inliers.length / 100, 1.0);

    return {
      yawDelta: consensus.yawDelta,
      pitchDelta: consensus.pitchDelta,
      confidence,
      inlierCount: consensus.inliers.length,
      dxPx: refined.dx,
      dyPx: refined.dy,
      model: 'lk-rotation',
      residualDeg: consensus.residualDeg,
    };
  } finally {
    // Step 11 — CRITICAL: free all native/test Mat allocations regardless of outcome.
    for (const m of mats) {
      try {
        m.delete();
      } catch {
        /* suppress double-free */
      }
    }
  }
}

function estimateRotationPatchFallback(
  prevGray: Buffer,
  currGray: Buffer,
  width: number,
  height: number,
  maskRegions: NormalizedRect[],
  options: NormalizedMotionOptions,
): MotionResult | null {
  if (width < 64 || height < 64) return null;

  const prev = downsampleGray(prevGray, width, height, LARGE_SEARCH_SCALE);
  const curr = downsampleGray(currGray, width, height, LARGE_SEARCH_SCALE);
  const scaledOptions = scaleMotionOptions(options, prev.scale);
  const halfPatch = Math.floor(LARGE_SEARCH_PATCH_PX / 2);
  const matches: SearchMatch[] = [];

  for (let gy = 0; gy < LARGE_SEARCH_GRID_ROWS; gy++) {
    const y = Math.round(((gy + 1) * prev.height) / (LARGE_SEARCH_GRID_ROWS + 1));
    for (let gx = 0; gx < LARGE_SEARCH_GRID_COLS; gx++) {
      const x = Math.round(((gx + 1) * prev.width) / (LARGE_SEARCH_GRID_COLS + 1));
      if (!patchFits(prev.width, prev.height, x, y, halfPatch)) continue;
      if (isMaskedAtScale(x, y, prev, maskRegions)) continue;

      const expected = expectedPatchDelta(x, y, prev.width, prev.height, scaledOptions);
      const match = findPatchMatch(prev, curr, x, y, {
        halfPatch,
        radius: expected === null ? LARGE_SEARCH_RADIUS_PX : LARGE_SEARCH_EXPECTED_RADIUS_PX,
        step: LARGE_SEARCH_COARSE_STEP_PX,
        expectedDx: expected?.dx,
        expectedDy: expected?.dy,
      });
      if (match !== null && match.score >= LARGE_SEARCH_MIN_SCORE) {
        matches.push(match);
      }
    }
  }

  if (matches.length < LARGE_SEARCH_MIN_MATCHES) return null;

  const pairs = matches.map((m) => ({
    x0: m.x0 * prev.scale,
    y0: m.y0 * prev.scale,
    x1: (m.x0 + m.dx) * prev.scale,
    y1: (m.y0 + m.dy) * prev.scale,
    dx: m.dx * prev.scale,
    dy: m.dy * prev.scale,
    err: 1 - m.score,
  }));
  const consensus = estimateRotationConsensus(pairs, width, height, options, {
    minInliers: LARGE_SEARCH_MIN_MATCHES,
    minRadiusDeg: LARGE_SEARCH_MIN_INLIER_RADIUS_DEG,
    maxRadiusDeg: LARGE_SEARCH_MAX_INLIER_RADIUS_DEG,
  });
  if (consensus === null) return null;

  const inlierScores = consensus.inliers.map((p) => 1 - p.err);
  const meanScore = inlierScores.reduce((sum, score) => sum + score, 0) / inlierScores.length;
  const refinedDx = median(consensus.inliers.map((m) => m.dx));
  const refinedDy = median(consensus.inliers.map((m) => m.dy));

  return {
    yawDelta: consensus.yawDelta,
    pitchDelta: consensus.pitchDelta,
    confidence: clamp(meanScore * Math.min(1, consensus.inliers.length / 10), 0.25, 0.82),
    inlierCount: consensus.inliers.length,
    dxPx: refinedDx,
    dyPx: refinedDy,
    model: 'patch-rotation',
    residualDeg: consensus.residualDeg,
  };
}

function downsampleGray(buffer: Buffer, width: number, height: number, scale: number): ScaledFrame {
  const outWidth = Math.max(1, Math.floor(width / scale));
  const outHeight = Math.max(1, Math.floor(height / scale));
  const out = new Uint8Array(outWidth * outHeight);

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sum = 0;
      let count = 0;
      const srcX0 = x * scale;
      const srcY0 = y * scale;
      for (let yy = 0; yy < scale; yy++) {
        const srcY = srcY0 + yy;
        if (srcY >= height) continue;
        const row = srcY * width;
        for (let xx = 0; xx < scale; xx++) {
          const srcX = srcX0 + xx;
          if (srcX >= width) continue;
          sum += buffer[row + srcX]!;
          count += 1;
        }
      }
      out[y * outWidth + x] = Math.round(sum / Math.max(1, count));
    }
  }

  return { buffer: out, width: outWidth, height: outHeight, scale };
}

function findPatchMatch(
  prev: ScaledFrame,
  curr: ScaledFrame,
  x: number,
  y: number,
  opts: {
    halfPatch: number;
    radius: number;
    step: number;
    expectedDx?: number;
    expectedDy?: number;
  },
): SearchMatch | null {
  const template = patchStats(prev, x, y, opts.halfPatch);
  if (template === null || template.norm < MIN_PATCH_NORM) return null;

  const searchCenterX = x + (opts.expectedDx ?? 0);
  const searchCenterY = y + (opts.expectedDy ?? 0);
  const minX = Math.max(opts.halfPatch, Math.round(searchCenterX - opts.radius));
  const maxX = Math.min(curr.width - opts.halfPatch - 1, Math.round(searchCenterX + opts.radius));
  const minY = Math.max(opts.halfPatch, Math.round(searchCenterY - opts.radius));
  const maxY = Math.min(curr.height - opts.halfPatch - 1, Math.round(searchCenterY + opts.radius));

  let bestX = x;
  let bestY = y;
  let bestScore = -1;
  for (let oy = -opts.radius; oy <= opts.radius; oy += opts.step) {
    const cy = Math.round(searchCenterY + oy);
    if (cy < minY || cy > maxY) continue;
    for (let ox = -opts.radius; ox <= opts.radius; ox += opts.step) {
      const cx = Math.round(searchCenterX + ox);
      if (cx < minX || cx > maxX) continue;
      for (let localY = Math.max(minY, cy - 1); localY <= Math.min(maxY, cy + 1); localY++) {
        for (let localX = Math.max(minX, cx - 1); localX <= Math.min(maxX, cx + 1); localX++) {
          const score = patchCorrelation(
            prev,
            curr,
            x,
            y,
            localX,
            localY,
            opts.halfPatch,
            template,
          );
          if (score > bestScore) {
            bestScore = score;
            bestX = localX;
            bestY = localY;
          }
        }
      }
    }
  }

  // One-pixel local refinement around the coarse best score.
  for (let cy = Math.max(minY, bestY - 1); cy <= Math.min(maxY, bestY + 1); cy++) {
    for (let cx = Math.max(minX, bestX - 1); cx <= Math.min(maxX, bestX + 1); cx++) {
      const score = patchCorrelation(prev, curr, x, y, cx, cy, opts.halfPatch, template);
      if (score > bestScore) {
        bestScore = score;
        bestX = cx;
        bestY = cy;
      }
    }
  }

  if (bestScore < -0.5) return null;
  return { x0: x, y0: y, dx: bestX - x, dy: bestY - y, score: bestScore };
}

function patchStats(
  frame: ScaledFrame,
  centerX: number,
  centerY: number,
  halfPatch: number,
): { mean: number; norm: number } | null {
  if (!patchFits(frame.width, frame.height, centerX, centerY, halfPatch)) return null;

  let sum = 0;
  let count = 0;
  for (let y = centerY - halfPatch; y <= centerY + halfPatch; y++) {
    const row = y * frame.width;
    for (let x = centerX - halfPatch; x <= centerX + halfPatch; x++) {
      sum += frame.buffer[row + x]!;
      count += 1;
    }
  }
  const mean = sum / Math.max(1, count);

  let normSq = 0;
  for (let y = centerY - halfPatch; y <= centerY + halfPatch; y++) {
    const row = y * frame.width;
    for (let x = centerX - halfPatch; x <= centerX + halfPatch; x++) {
      const centered = frame.buffer[row + x]! - mean;
      normSq += centered * centered;
    }
  }

  return { mean, norm: Math.sqrt(normSq) };
}

function patchCorrelation(
  prev: ScaledFrame,
  curr: ScaledFrame,
  prevX: number,
  prevY: number,
  currX: number,
  currY: number,
  halfPatch: number,
  template: { mean: number; norm: number },
): number {
  const candidate = patchStats(curr, currX, currY, halfPatch);
  if (candidate === null || candidate.norm < MIN_PATCH_NORM || template.norm < MIN_PATCH_NORM) {
    return -1;
  }

  let numerator = 0;
  for (let py = -halfPatch; py <= halfPatch; py++) {
    const prevRow = (prevY + py) * prev.width;
    const currRow = (currY + py) * curr.width;
    for (let px = -halfPatch; px <= halfPatch; px++) {
      numerator +=
        (prev.buffer[prevRow + prevX + px]! - template.mean) *
        (curr.buffer[currRow + currX + px]! - candidate.mean);
    }
  }

  return numerator / (template.norm * candidate.norm);
}

function patchFits(
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  halfPatch: number,
): boolean {
  return (
    centerX - halfPatch >= 0 &&
    centerY - halfPatch >= 0 &&
    centerX + halfPatch < width &&
    centerY + halfPatch < height
  );
}

function isMaskedAtScale(
  x: number,
  y: number,
  frame: ScaledFrame,
  masks: NormalizedRect[],
): boolean {
  const nx = x / frame.width;
  const ny = y / frame.height;
  return masks.some((r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h);
}

function normalizeMotionOptions(
  calibration: number | MotionEstimatorOptions,
): NormalizedMotionOptions {
  if (typeof calibration === 'number') {
    return {
      pixelsPerDegree: finitePositiveOr(calibration, 8),
      horizontalFovDeg: 0,
      verticalFovDeg: 0,
    };
  }
  return {
    pixelsPerDegree: finitePositiveOr(calibration.pixelsPerDegree, 8),
    horizontalFovDeg: finitePositiveOr(calibration.horizontalFovDeg, 0),
    verticalFovDeg: finitePositiveOr(calibration.verticalFovDeg, 0),
    expectedYawDeltaDeg: finiteOrUndefined(calibration.expectedYawDeltaDeg),
    expectedPitchDeltaDeg: finiteOrUndefined(calibration.expectedPitchDeltaDeg),
  };
}

function cvReady(cv: CvApi | null | undefined): cv is CvApi {
  return (
    typeof cv?.matFromArray === 'function' &&
    typeof cv?.goodFeaturesToTrack === 'function' &&
    typeof cv?.calcOpticalFlowPyrLK === 'function' &&
    typeof cv?.CV_8UC1 === 'number'
  );
}

function filterByLkError(pairs: FlowPair[]): FlowPair[] {
  const positiveErrors = pairs.map((p) => p.err).filter((err) => Number.isFinite(err) && err > 0);
  if (positiveErrors.length < MIN_CORNERS) return pairs;
  const cutoff = percentile(positiveErrors, LK_ERROR_KEEP_FRACTION);
  return pairs.filter((p) => p.err <= cutoff);
}

function adaptiveInlierRadius(pairs: FlowPair[], medianDx: number, medianDy: number): number {
  const distances = pairs.map((p) => Math.hypot(p.dx - medianDx, p.dy - medianDy));
  const mad = median(distances);
  return clamp(Math.max(INLIER_RADIUS_PX, mad * 2.5), INLIER_RADIUS_PX, MAX_INLIER_RADIUS_PX);
}

function robustFlowMean(
  pairs: FlowPair[],
  medianDx: number,
  medianDy: number,
  radius: number,
): { dx: number; dy: number } {
  let sumW = 0;
  let sumDx = 0;
  let sumDy = 0;
  const safeRadius = Math.max(1, radius);

  for (const p of pairs) {
    const d = Math.hypot(p.dx - medianDx, p.dy - medianDy);
    const u = d / safeRadius;
    if (u >= 1) continue;
    const w = Math.pow(1 - u * u, 2);
    sumW += w;
    sumDx += p.dx * w;
    sumDy += p.dy * w;
  }

  if (sumW <= 1e-9) {
    let dx = 0;
    let dy = 0;
    for (const p of pairs) {
      dx += p.dx;
      dy += p.dy;
    }
    return { dx: dx / pairs.length, dy: dy / pairs.length };
  }

  return { dx: sumDx / sumW, dy: sumDy / sumW };
}

function estimateRotationConsensus(
  pairs: FlowPair[],
  width: number,
  height: number,
  options: NormalizedMotionOptions,
  consensusOptions: RotationConsensusOptions,
): RotationConsensus | null {
  const candidates = pairs
    .map((pair) => toRotationCandidate(pair, width, height, options))
    .filter((pair): pair is RotationCandidate => pair !== null);
  if (candidates.length < consensusOptions.minInliers) return null;

  const seedYaw = median(candidates.map((p) => p.yawDelta));
  const seedPitch = median(candidates.map((p) => p.pitchDelta));
  const radius = adaptiveAngularInlierRadius(
    candidates,
    seedYaw,
    seedPitch,
    width,
    height,
    options,
    consensusOptions,
  );
  const seedInliers = candidates.filter(
    (p) => angularResidualDeg(p, seedYaw, seedPitch, width, height, options) <= radius,
  );
  if (seedInliers.length < consensusOptions.minInliers) return null;

  const refined = refineRotationModel(seedInliers, seedYaw, seedPitch, width, height, options);
  const refinedRadius = adaptiveAngularInlierRadius(
    candidates,
    refined.yawDelta,
    refined.pitchDelta,
    width,
    height,
    options,
    consensusOptions,
  );
  const refinedInliers = candidates.filter(
    (p) =>
      angularResidualDeg(p, refined.yawDelta, refined.pitchDelta, width, height, options) <=
      refinedRadius,
  );
  if (refinedInliers.length < consensusOptions.minInliers) return null;

  const finalModel = refineRotationModel(
    refinedInliers,
    refined.yawDelta,
    refined.pitchDelta,
    width,
    height,
    options,
  );
  if (
    Math.abs(finalModel.yawDelta) > MAX_REASONABLE_YAW_DELTA_DEG ||
    Math.abs(finalModel.pitchDelta) > MAX_REASONABLE_PITCH_DELTA_DEG
  ) {
    return null;
  }

  const residuals = refinedInliers.map((p) =>
    angularResidualDeg(p, finalModel.yawDelta, finalModel.pitchDelta, width, height, options),
  );

  return {
    yawDelta: finalModel.yawDelta,
    pitchDelta: finalModel.pitchDelta,
    residualDeg: median(residuals),
    inliers: refinedInliers,
  };
}

function toRotationCandidate(
  pair: FlowPair,
  width: number,
  height: number,
  options: NormalizedMotionOptions,
): RotationCandidate | null {
  const yawDelta = yawDeltaFromPair(pair, width, options);
  const pitchDelta = pitchDeltaFromPair(pair, height, options);
  if (!Number.isFinite(yawDelta) || !Number.isFinite(pitchDelta)) return null;
  if (Math.abs(yawDelta) > MAX_REASONABLE_YAW_DELTA_DEG) return null;
  if (Math.abs(pitchDelta) > MAX_REASONABLE_PITCH_DELTA_DEG) return null;
  return { ...pair, yawDelta, pitchDelta };
}

function isReasonableAngularPair(
  pair: FlowPair,
  width: number,
  height: number,
  options: NormalizedMotionOptions,
): boolean {
  return toRotationCandidate(pair, width, height, options) !== null;
}

function adaptiveAngularInlierRadius(
  pairs: RotationCandidate[],
  yawDelta: number,
  pitchDelta: number,
  width: number,
  height: number,
  options: NormalizedMotionOptions,
  consensusOptions: RotationConsensusOptions,
): number {
  const residuals = pairs.map((p) =>
    angularResidualDeg(p, yawDelta, pitchDelta, width, height, options),
  );
  const mad = median(residuals);
  return clamp(
    Math.max(consensusOptions.minRadiusDeg, mad * 2.5),
    consensusOptions.minRadiusDeg,
    consensusOptions.maxRadiusDeg,
  );
}

function refineRotationModel(
  pairs: FlowPair[],
  yawDelta: number,
  pitchDelta: number,
  width: number,
  height: number,
  options: NormalizedMotionOptions,
): { yawDelta: number; pitchDelta: number } {
  let bestYaw = yawDelta;
  let bestPitch = pitchDelta;
  let bestCost = rotationCost(pairs, bestYaw, bestPitch, width, height, options);

  for (const step of [1, 0.5, 0.25, 0.1, 0.05]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const dyaw of [-step, 0, step]) {
        for (const dpitch of [-step, 0, step]) {
          if (dyaw === 0 && dpitch === 0) continue;
          const candidateYaw = bestYaw + dyaw;
          const candidatePitch = bestPitch + dpitch;
          const cost = rotationCost(pairs, candidateYaw, candidatePitch, width, height, options);
          if (cost + 1e-9 < bestCost) {
            bestYaw = candidateYaw;
            bestPitch = candidatePitch;
            bestCost = cost;
            improved = true;
          }
        }
      }
    }
  }

  return { yawDelta: bestYaw, pitchDelta: bestPitch };
}

function rotationCost(
  pairs: FlowPair[],
  yawDelta: number,
  pitchDelta: number,
  width: number,
  height: number,
  options: NormalizedMotionOptions,
): number {
  if (pairs.length === 0) return Number.POSITIVE_INFINITY;
  let cost = 0;
  for (const pair of pairs) {
    const residual = Math.min(
      6,
      angularResidualDeg(pair, yawDelta, pitchDelta, width, height, options),
    );
    cost += residual * residual;
  }
  return cost / pairs.length;
}

function angularResidualDeg(
  pair: FlowPair,
  yawDelta: number,
  pitchDelta: number,
  width: number,
  height: number,
  options: NormalizedMotionOptions,
): number {
  const before = angularPoint(pair.x0, pair.y0, width, height, options);
  const after = angularPoint(pair.x1, pair.y1, width, height, options);
  const expectedYaw = before.yawRad - yawDelta * DEG;
  const expectedPitch = before.pitchRad + pitchDelta * DEG;
  return (
    Math.hypot(normalizeSignedRad(after.yawRad - expectedYaw), after.pitchRad - expectedPitch) / DEG
  );
}

function angularPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  options: NormalizedMotionOptions,
): { yawRad: number; pitchRad: number } {
  const cx = width / 2;
  const cy = height / 2;
  const yawRad =
    options.horizontalFovDeg > 0
      ? Math.atan2(x - cx, cx / Math.tan((options.horizontalFovDeg / 2) * DEG))
      : ((x - cx) / options.pixelsPerDegree) * DEG;
  const pitchRad =
    options.verticalFovDeg > 0
      ? Math.atan2(cy - y, cy / Math.tan((options.verticalFovDeg / 2) * DEG))
      : ((cy - y) / options.pixelsPerDegree) * DEG;
  return {
    yawRad,
    pitchRad,
  };
}

function expectedPatchDelta(
  x: number,
  y: number,
  width: number,
  height: number,
  options: NormalizedMotionOptions,
): { dx: number; dy: number } | null {
  const yawDelta = options.expectedYawDeltaDeg ?? 0;
  const pitchDelta = options.expectedPitchDeltaDeg ?? 0;
  if (Math.abs(yawDelta) < 1e-6 && Math.abs(pitchDelta) < 1e-6) return null;
  const projected = projectPointWithRotation(x, y, width, height, yawDelta, pitchDelta, options);
  if (projected === null) return null;
  return { dx: projected.x - x, dy: projected.y - y };
}

function projectPointWithRotation(
  x: number,
  y: number,
  width: number,
  height: number,
  yawDelta: number,
  pitchDelta: number,
  options: NormalizedMotionOptions,
): { x: number; y: number } | null {
  if (![x, y, yawDelta, pitchDelta].every((value) => Number.isFinite(value))) return null;

  let projectedX: number;
  if (options.horizontalFovDeg > 0) {
    const cx = width / 2;
    const fx = cx / Math.tan((options.horizontalFovDeg / 2) * DEG);
    const nextYaw = Math.atan2(x - cx, fx) - yawDelta * DEG;
    projectedX = cx + Math.tan(nextYaw) * fx;
  } else {
    projectedX = x - yawDelta * options.pixelsPerDegree;
  }

  let projectedY: number;
  if (options.verticalFovDeg > 0) {
    const cy = height / 2;
    const fy = cy / Math.tan((options.verticalFovDeg / 2) * DEG);
    const nextPitch = Math.atan2(cy - y, fy) + pitchDelta * DEG;
    projectedY = cy - Math.tan(nextPitch) * fy;
  } else {
    projectedY = y - pitchDelta * options.pixelsPerDegree;
  }

  if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY)) return null;
  return { x: projectedX, y: projectedY };
}

function scaleMotionOptions(
  options: NormalizedMotionOptions,
  scale: number,
): NormalizedMotionOptions {
  return {
    ...options,
    pixelsPerDegree: options.pixelsPerDegree / Math.max(1, scale),
  };
}

function yawDeltaFromPair(pair: FlowPair, width: number, options: NormalizedMotionOptions): number {
  if (options.horizontalFovDeg <= 0) {
    return yawDeltaFromPixels(pair.dx, width, options);
  }
  const cx = width / 2;
  const fx = cx / Math.tan((options.horizontalFovDeg / 2) * DEG);
  const before = Math.atan2(pair.x0 - cx, fx);
  const after = Math.atan2(pair.x1 - cx, fx);
  return (before - after) / DEG;
}

function pitchDeltaFromPair(
  pair: FlowPair,
  height: number,
  options: NormalizedMotionOptions,
): number {
  if (options.verticalFovDeg <= 0) {
    return pitchDeltaFromPixels(pair.dy, height, options);
  }
  const cy = height / 2;
  const fy = cy / Math.tan((options.verticalFovDeg / 2) * DEG);
  const before = Math.atan2(cy - pair.y0, fy);
  const after = Math.atan2(cy - pair.y1, fy);
  return (after - before) / DEG;
}

function yawDeltaFromPixels(dxPx: number, width: number, options: NormalizedMotionOptions): number {
  if (options.horizontalFovDeg > 0) {
    const fx = width / 2 / Math.tan((options.horizontalFovDeg / 2) * DEG);
    return -(Math.atan2(dxPx, fx) / DEG);
  }
  return -dxPx / options.pixelsPerDegree;
}

function pitchDeltaFromPixels(
  dyPx: number,
  height: number,
  options: NormalizedMotionOptions,
): number {
  if (options.verticalFovDeg > 0) {
    const fy = height / 2 / Math.tan((options.verticalFovDeg / 2) * DEG);
    return -(Math.atan2(dyPx, fy) / DEG);
  }
  return -dyPx / options.pixelsPerDegree;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.ceil(sorted.length * fraction) - 1, 0, sorted.length - 1);
  return sorted[idx]!;
}

function finitePositiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function normalizeSignedRad(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const fullTurn = Math.PI * 2;
  return ((((value + Math.PI) % fullTurn) + fullTurn) % fullTurn) - Math.PI;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

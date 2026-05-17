import type { NormalizedRect } from '@pyng/shared';
import type { GrayFrame } from './capture-loop.js';
import type { PingProjection } from './ping-tracker.js';
import { getNativeOpenCv } from './native-opencv.js';
import type { SurfaceTrackerResult } from './surface-tracking-types.js';

export type LocalPingAnchorObservation = SurfaceTrackerResult;

export type LocalPingAnchorTrackerOptions = {
  localRadiusScreenPx?: number;
  maxFeatures?: number;
  minInliers?: number;
  refreshEveryFrames?: number;
  _cv?: LocalCvApi;
};

type Bounds = {
  width: number;
  height: number;
};

type LocalCvApi = {
  CV_8UC1: number;
  CV_32FC2: number;
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

type MatLike = {
  rows: number;
  data: Uint8Array;
  data32F: Float32Array;
  delete(): void;
};

type TrackedPoint = {
  x: number;
  y: number;
};

type FlowPair = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dx: number;
  dy: number;
  err: number;
};

type LocalTrack = {
  id: string;
  points: TrackedPoint[];
  lastFrameX: number;
  lastFrameY: number;
  lostFrames: number;
  ageFrames: number;
  confidence: number;
};

type SimilarityTransform = {
  a: number;
  b: number;
  tx: number;
  ty: number;
};

type SimilarityConsensus = {
  transform: SimilarityTransform;
  inliers: FlowPair[];
  residualPx: number;
};

const DEFAULT_LOCAL_RADIUS_SCREEN_PX = 190;
const DEFAULT_MAX_FEATURES = 72;
const DEFAULT_MIN_INLIERS = 8;
const DEFAULT_REFRESH_EVERY_FRAMES = 20;
const MIN_DETECT_FRAME_SIZE = 32;
const MIN_FEATURE_DISTANCE_PX = 5;
const FEATURE_QUALITY = 0.004;
const EXPANDED_FEATURE_QUALITY = 0.002;
const PIN_MARKER_MASK_WIDTH_SCREEN_PX = 58;
const PIN_MARKER_MASK_HEIGHT_SCREEN_PX = 58;
const PIN_MARKER_MASK_BELOW_TIP_SCREEN_PX = 6;
const LK_WINDOW_SIZE_PX = 31;
const LK_MAX_LEVEL = 4;
const LK_TERM_CRITERIA_TYPE = 3;
const LK_TERM_CRITERIA_MAX_COUNT = 30;
const LK_TERM_CRITERIA_EPSILON = 0.01;
const LK_MIN_EIG_THRESHOLD = 1e-4;
const LK_ERROR_KEEP_FRACTION = 0.85;
const RANSAC_THRESHOLD_PX = 4.5;
const MAX_LOCAL_PULL_RADIUS_MULTIPLIER = 1.8;
const MAX_REASONABLE_SCALE_DELTA = 0.35;
const MAX_TRACK_RADIUS_MULTIPLIER = 1.25;
const DETECT_FEATURE_MULTIPLIER = 3;

export class LocalPingAnchorTracker {
  private readonly localRadiusScreenPx: number;
  private readonly maxFeatures: number;
  private readonly minInliers: number;
  private readonly refreshEveryFrames: number;
  private readonly cv: LocalCvApi;
  private tracks = new Map<string, LocalTrack>();

  constructor(options: LocalPingAnchorTrackerOptions = {}) {
    this.localRadiusScreenPx = Math.max(
      80,
      Math.round(options.localRadiusScreenPx ?? DEFAULT_LOCAL_RADIUS_SCREEN_PX),
    );
    this.maxFeatures = Math.max(16, Math.round(options.maxFeatures ?? DEFAULT_MAX_FEATURES));
    this.minInliers = Math.max(4, Math.round(options.minInliers ?? DEFAULT_MIN_INLIERS));
    this.refreshEveryFrames = Math.max(
      4,
      Math.round(options.refreshEveryFrames ?? DEFAULT_REFRESH_EVERY_FRAMES),
    );
    this.cv = options._cv ?? (getNativeOpenCv() as unknown as LocalCvApi);
  }

  reset(): void {
    this.tracks.clear();
  }

  update(
    prevFrame: GrayFrame | null,
    frame: GrayFrame,
    projections: PingProjection[],
    bounds: Bounds,
    maskRegions: NormalizedRect[],
    observedAtNs: number,
  ): LocalPingAnchorObservation[] {
    if (!cvReady(this.cv) || !usableFrame(frame) || bounds.width <= 0 || bounds.height <= 0) {
      this.reset();
      return [];
    }

    const liveIds = new Set(projections.map((p) => p.id));
    for (const id of this.tracks.keys()) {
      if (!liveIds.has(id)) this.tracks.delete(id);
    }

    const sameFrameShape =
      prevFrame !== null && prevFrame.width === frame.width && prevFrame.height === frame.height;
    if (!sameFrameShape) {
      for (const track of this.tracks.values()) {
        track.points = [];
      }
    }

    const scaleX = frame.width / bounds.width;
    const scaleY = frame.height / bounds.height;
    const observations: LocalPingAnchorObservation[] = [];

    for (const projection of projections) {
      if (projection.isEdgeArrow) continue;

      const predictedFrameX = projection.screenX * scaleX;
      const predictedFrameY = projection.screenY * scaleY;
      let track = this.tracks.get(projection.id);
      if (!track) {
        track = createTrack(projection.id, predictedFrameX, predictedFrameY);
        this.tracks.set(projection.id, track);
      }

      if (!sameFrameShape || prevFrame === null || track.points.length < this.minInliers) {
        this.detectIntoTrack(frame, track, predictedFrameX, predictedFrameY, bounds, maskRegions);
        continue;
      }

      const observation = this.trackExisting(
        prevFrame,
        frame,
        track,
        predictedFrameX,
        predictedFrameY,
        scaleX,
        scaleY,
        bounds,
        maskRegions,
        observedAtNs,
      );
      if (observation !== null) observations.push(observation);
    }

    return observations;
  }

  private trackExisting(
    prevFrame: GrayFrame,
    frame: GrayFrame,
    track: LocalTrack,
    predictedFrameX: number,
    predictedFrameY: number,
    scaleX: number,
    scaleY: number,
    bounds: Bounds,
    maskRegions: NormalizedRect[],
    observedAtNs: number,
  ): LocalPingAnchorObservation | null {
    const radiusFramePx = this.radiusFramePx(bounds, frame);
    const previousAnchorX = track.lastFrameX;
    const previousAnchorY = track.lastFrameY;
    const pairs = this.trackPoints(prevFrame, frame, track.points, maskRegions);
    if (pairs.length < this.minInliers) {
      this.markLostOrRedetect(frame, track, predictedFrameX, predictedFrameY, bounds, maskRegions);
      return null;
    }

    const nearbyPairs = filterPairsNearAnchor(
      pairs,
      previousAnchorX,
      previousAnchorY,
      radiusFramePx * MAX_TRACK_RADIUS_MULTIPLIER,
    );
    const candidatePairs = nearbyPairs.length >= this.minInliers ? nearbyPairs : pairs;
    const lowErrorPairs = filterByLkError(candidatePairs);
    const consensus = estimateSimilarityRansac(
      lowErrorPairs.length >= this.minInliers ? lowErrorPairs : candidatePairs,
      this.minInliers,
    );
    if (consensus === null) {
      this.markLostOrRedetect(frame, track, predictedFrameX, predictedFrameY, bounds, maskRegions);
      return null;
    }

    const observed = applyTransform(consensus.transform, previousAnchorX, previousAnchorY);
    const pullDistance = Math.hypot(observed.x - predictedFrameX, observed.y - predictedFrameY);
    const maxPullPx = Math.max(
      80 * Math.min(scaleX, scaleY),
      radiusFramePx * MAX_LOCAL_PULL_RADIUS_MULTIPLIER,
    );
    if (
      !pointInFrame(observed.x, observed.y, frame) ||
      (pullDistance > maxPullPx && consensus.inliers.length < this.maxFeatures * 0.5)
    ) {
      this.markLostOrRedetect(frame, track, predictedFrameX, predictedFrameY, bounds, maskRegions);
      return null;
    }

    const confidence = localConfidence(
      consensus,
      candidatePairs.length,
      this.maxFeatures,
      previousAnchorX,
      previousAnchorY,
      radiusFramePx,
    );

    track.points = consensus.inliers.map((p) => ({ x: p.x1, y: p.y1 }));
    track.lastFrameX = observed.x;
    track.lastFrameY = observed.y;
    track.lostFrames = 0;
    track.ageFrames += 1;

    if (
      track.points.length < this.maxFeatures * 0.55 ||
      track.ageFrames % this.refreshEveryFrames === 0
    ) {
      this.addDetectedPoints(frame, track, observed.x, observed.y, bounds, maskRegions);
    }

    track.confidence =
      track.ageFrames <= 1 ? confidence : clamp01(0.7 * track.confidence + 0.3 * confidence);

    return {
      id: track.id,
      screenX: observed.x / scaleX,
      screenY: observed.y / scaleY,
      confidence: track.confidence,
      observedAtNs,
      inlierCount: consensus.inliers.length,
      trackedPointCount: pairs.length,
      residualPx: consensus.residualPx,
      trackingMethod: 'klt',
      surfaceConfidence: track.confidence,
      surfaceLockKind: 'unknown',
    };
  }

  private trackPoints(
    prevFrame: GrayFrame,
    frame: GrayFrame,
    points: TrackedPoint[],
    maskRegions: NormalizedRect[],
  ): FlowPair[] {
    const mats: MatLike[] = [];
    const trackMat = <T extends MatLike>(m: T): T => {
      mats.push(m);
      return m;
    };

    try {
      const validPoints = points.filter(
        (p) => pointInFrame(p.x, p.y, prevFrame) && !isMasked(p.x, p.y, prevFrame, maskRegions),
      );
      if (validPoints.length < this.minInliers) return [];

      const prevGrayMat = trackMat(
        this.cv.matFromArray(prevFrame.height, prevFrame.width, this.cv.CV_8UC1, prevFrame.buffer),
      );
      const currGrayMat = trackMat(
        this.cv.matFromArray(frame.height, frame.width, this.cv.CV_8UC1, frame.buffer),
      );
      const prevPts = trackMat(
        this.cv.matFromArray(
          validPoints.length,
          1,
          this.cv.CV_32FC2,
          new Float32Array(validPoints.flatMap((p) => [p.x, p.y])),
        ),
      );
      const nextPts = trackMat(new this.cv.Mat());
      const status = trackMat(new this.cv.Mat());
      const err = trackMat(new this.cv.Mat());

      this.cv.calcOpticalFlowPyrLK(
        prevGrayMat,
        currGrayMat,
        prevPts,
        nextPts,
        status,
        err,
        new this.cv.Size(LK_WINDOW_SIZE_PX, LK_WINDOW_SIZE_PX),
        LK_MAX_LEVEL,
        new this.cv.TermCriteria(
          LK_TERM_CRITERIA_TYPE,
          LK_TERM_CRITERIA_MAX_COUNT,
          LK_TERM_CRITERIA_EPSILON,
        ),
        0,
        LK_MIN_EIG_THRESHOLD,
      );

      const pairs: FlowPair[] = [];
      for (let i = 0; i < validPoints.length; i++) {
        if (status.data[i] === 0) continue;
        const source = validPoints[i]!;
        const x1 = nextPts.data32F[i * 2]!;
        const y1 = nextPts.data32F[i * 2 + 1]!;
        if (!Number.isFinite(x1) || !Number.isFinite(y1)) continue;
        if (!pointInFrame(x1, y1, frame) || isMasked(x1, y1, frame, maskRegions)) continue;
        const errValue = err.data32F.length > i ? err.data32F[i]! : 0;
        pairs.push({
          x0: source.x,
          y0: source.y,
          x1,
          y1,
          dx: x1 - source.x,
          dy: y1 - source.y,
          err: Number.isFinite(errValue) ? errValue : 0,
        });
      }
      return pairs;
    } finally {
      for (const m of mats) {
        try {
          m.delete();
        } catch {
          /* suppress double-free */
        }
      }
    }
  }

  private markLostOrRedetect(
    frame: GrayFrame,
    track: LocalTrack,
    predictedFrameX: number,
    predictedFrameY: number,
    bounds: Bounds,
    maskRegions: NormalizedRect[],
  ): void {
    track.lostFrames += 1;
    track.confidence *= 0.72;
    if (track.lostFrames >= 2) {
      this.detectIntoTrack(frame, track, predictedFrameX, predictedFrameY, bounds, maskRegions);
    }
  }

  private detectIntoTrack(
    frame: GrayFrame,
    track: LocalTrack,
    centerX: number,
    centerY: number,
    bounds: Bounds,
    maskRegions: NormalizedRect[],
  ): void {
    const points = this.detectFeatures(frame, centerX, centerY, bounds, maskRegions, 1);
    track.points = points;
    track.lastFrameX = centerX;
    track.lastFrameY = centerY;
    track.lostFrames = 0;
    track.ageFrames = 0;
    track.confidence = points.length >= this.minInliers ? Math.max(track.confidence, 0.35) : 0.15;
  }

  private addDetectedPoints(
    frame: GrayFrame,
    track: LocalTrack,
    centerX: number,
    centerY: number,
    bounds: Bounds,
    maskRegions: NormalizedRect[],
  ): void {
    const detected = this.detectFeatures(frame, centerX, centerY, bounds, maskRegions, 1);
    for (const p of detected) {
      if (track.points.length >= this.maxFeatures) break;
      if (track.points.some((existing) => Math.hypot(existing.x - p.x, existing.y - p.y) < 4)) {
        continue;
      }
      track.points.push(p);
    }
  }

  private detectFeatures(
    frame: GrayFrame,
    centerX: number,
    centerY: number,
    bounds: Bounds,
    maskRegions: NormalizedRect[],
    radiusMultiplier: number,
  ): TrackedPoint[] {
    if (!pointInFrame(centerX, centerY, frame)) return [];
    const radius = this.radiusFramePx(bounds, frame) * radiusMultiplier;
    const firstPass = this.detectFeaturesOnce(
      frame,
      centerX,
      centerY,
      radius,
      bounds,
      maskRegions,
      radiusMultiplier > 1 ? EXPANDED_FEATURE_QUALITY : FEATURE_QUALITY,
    );
    if (firstPass.length >= this.minInliers || radiusMultiplier > 1) return firstPass;
    return this.detectFeatures(
      frame,
      centerX,
      centerY,
      bounds,
      maskRegions,
      radiusMultiplier * 1.35,
    );
  }

  private detectFeaturesOnce(
    frame: GrayFrame,
    centerX: number,
    centerY: number,
    radius: number,
    bounds: Bounds,
    maskRegions: NormalizedRect[],
    qualityLevel: number,
  ): TrackedPoint[] {
    const mats: MatLike[] = [];
    const trackMat = <T extends MatLike>(m: T): T => {
      mats.push(m);
      return m;
    };

    try {
      const x0 = clamp(Math.round(centerX - radius), 0, frame.width);
      const y0 = clamp(Math.round(centerY - radius), 0, frame.height);
      const x1 = clamp(Math.round(centerX + radius), 0, frame.width);
      const y1 = clamp(Math.round(centerY + radius), 0, frame.height);
      const cropW = x1 - x0;
      const cropH = y1 - y0;
      if (cropW < MIN_DETECT_FRAME_SIZE || cropH < MIN_DETECT_FRAME_SIZE) return [];

      const cropBuffer = copyGrayRegion(frame, x0, y0, cropW, cropH);
      const frameMat = trackMat(this.cv.matFromArray(cropH, cropW, this.cv.CV_8UC1, cropBuffer));
      const maskMat = trackMat(this.cv.Mat.ones(cropH, cropW, this.cv.CV_8UC1));

      for (const r of maskRegions) {
        const rx0 = Math.round(r.x * frame.width) - x0;
        const ry0 = Math.round(r.y * frame.height) - y0;
        const rx1 = Math.round((r.x + r.w) * frame.width) - x0;
        const ry1 = Math.round((r.y + r.h) * frame.height) - y0;
        drawBlack(
          maskMat,
          this.cv,
          clamp(rx0, 0, cropW),
          clamp(ry0, 0, cropH),
          clamp(rx1, 0, cropW) - clamp(rx0, 0, cropW),
          clamp(ry1, 0, cropH) - clamp(ry0, 0, cropH),
        );
      }

      maskOverlayMarker(maskMat, this.cv, centerX - x0, centerY - y0, frame, bounds, cropW, cropH);

      const corners = trackMat(new this.cv.Mat());
      this.cv.goodFeaturesToTrack(
        frameMat,
        corners,
        this.maxFeatures * DETECT_FEATURE_MULTIPLIER,
        qualityLevel,
        MIN_FEATURE_DISTANCE_PX,
        maskMat,
      );

      const points: TrackedPoint[] = [];
      for (let i = 0; i < corners.rows; i++) {
        const x = corners.data32F[i * 2]! + x0;
        const y = corners.data32F[i * 2 + 1]! + y0;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        points.push({ x, y });
      }
      return rankAndLimitPoints(points, centerX, centerY, this.maxFeatures);
    } finally {
      for (const m of mats) {
        try {
          m.delete();
        } catch {
          /* suppress double-free */
        }
      }
    }
  }

  private radiusFramePx(bounds: Bounds, frame: GrayFrame): number {
    return (
      this.localRadiusScreenPx * Math.min(frame.width / bounds.width, frame.height / bounds.height)
    );
  }
}

function createTrack(id: string, frameX: number, frameY: number): LocalTrack {
  return {
    id,
    points: [],
    lastFrameX: frameX,
    lastFrameY: frameY,
    lostFrames: 0,
    ageFrames: 0,
    confidence: 0,
  };
}

function estimateSimilarityRansac(
  pairs: FlowPair[],
  minInliers: number,
): SimilarityConsensus | null {
  if (pairs.length < minInliers) return null;
  if (pairs.length === 1) {
    const p = pairs[0]!;
    return {
      transform: { a: 1, b: 0, tx: p.dx, ty: p.dy },
      inliers: pairs,
      residualPx: 0,
    };
  }

  let bestInliers: FlowPair[] = [];
  let bestResidual = Number.POSITIVE_INFINITY;
  const sampleLimit = Math.min(48, pairs.length);

  for (let ai = 0; ai < sampleLimit; ai++) {
    const i = sampleIndex(ai, sampleLimit, pairs.length);
    for (let bj = ai + 1; bj < sampleLimit; bj++) {
      const j = sampleIndex(bj, sampleLimit, pairs.length);
      const candidate = similarityFromTwoPairs(pairs[i]!, pairs[j]!);
      if (candidate === null) continue;
      const inliers = inliersFor(candidate, pairs, RANSAC_THRESHOLD_PX);
      if (inliers.length < minInliers) continue;
      const residual = median(inliers.map((p) => residualFor(candidate, p)));
      if (
        inliers.length > bestInliers.length ||
        (inliers.length === bestInliers.length && residual < bestResidual)
      ) {
        bestInliers = inliers;
        bestResidual = residual;
      }
    }
  }

  if (bestInliers.length < minInliers) {
    const medianDx = median(pairs.map((p) => p.dx));
    const medianDy = median(pairs.map((p) => p.dy));
    const transform = { a: 1, b: 0, tx: medianDx, ty: medianDy };
    const inliers = inliersFor(transform, pairs, RANSAC_THRESHOLD_PX);
    if (inliers.length < minInliers) return null;
    bestInliers = inliers;
    bestResidual = median(inliers.map((p) => residualFor(transform, p)));
  }

  const refined = refineSimilarity(bestInliers);
  const refinedInliers = inliersFor(refined, pairs, RANSAC_THRESHOLD_PX);
  if (refinedInliers.length < minInliers) return null;
  return {
    transform: refineSimilarity(refinedInliers),
    inliers: refinedInliers,
    residualPx: median(refinedInliers.map((p) => residualFor(refined, p))),
  };
}

function sampleIndex(sample: number, sampleCount: number, itemCount: number): number {
  if (sampleCount <= 1) return 0;
  return Math.min(itemCount - 1, Math.round((sample / (sampleCount - 1)) * (itemCount - 1)));
}

function similarityFromTwoPairs(p1: FlowPair, p2: FlowPair): SimilarityTransform | null {
  const vx0 = p2.x0 - p1.x0;
  const vy0 = p2.y0 - p1.y0;
  const vx1 = p2.x1 - p1.x1;
  const vy1 = p2.y1 - p1.y1;
  const denom = vx0 * vx0 + vy0 * vy0;
  if (denom < 16) return null;
  const a = (vx1 * vx0 + vy1 * vy0) / denom;
  const b = (vy1 * vx0 - vx1 * vy0) / denom;
  const scale = Math.hypot(a, b);
  if (Math.abs(scale - 1) > MAX_REASONABLE_SCALE_DELTA) return null;
  return {
    a,
    b,
    tx: p1.x1 - a * p1.x0 + b * p1.y0,
    ty: p1.y1 - b * p1.x0 - a * p1.y0,
  };
}

function refineSimilarity(pairs: FlowPair[]): SimilarityTransform {
  const c0 = centroid(pairs.map((p) => ({ x: p.x0, y: p.y0 })));
  const c1 = centroid(pairs.map((p) => ({ x: p.x1, y: p.y1 })));
  let denom = 0;
  let aNum = 0;
  let bNum = 0;
  for (const p of pairs) {
    const x0 = p.x0 - c0.x;
    const y0 = p.y0 - c0.y;
    const x1 = p.x1 - c1.x;
    const y1 = p.y1 - c1.y;
    denom += x0 * x0 + y0 * y0;
    aNum += x0 * x1 + y0 * y1;
    bNum += x0 * y1 - y0 * x1;
  }
  if (denom < 1e-6) {
    return { a: 1, b: 0, tx: median(pairs.map((p) => p.dx)), ty: median(pairs.map((p) => p.dy)) };
  }
  const a = aNum / denom;
  const b = bNum / denom;
  return {
    a,
    b,
    tx: c1.x - a * c0.x + b * c0.y,
    ty: c1.y - b * c0.x - a * c0.y,
  };
}

function inliersFor(
  transform: SimilarityTransform,
  pairs: FlowPair[],
  thresholdPx: number,
): FlowPair[] {
  return pairs.filter((p) => residualFor(transform, p) <= thresholdPx);
}

function residualFor(transform: SimilarityTransform, pair: FlowPair): number {
  const projected = applyTransform(transform, pair.x0, pair.y0);
  return Math.hypot(projected.x - pair.x1, projected.y - pair.y1);
}

function applyTransform(
  transform: SimilarityTransform,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: transform.a * x - transform.b * y + transform.tx,
    y: transform.b * x + transform.a * y + transform.ty,
  };
}

function filterByLkError(pairs: FlowPair[]): FlowPair[] {
  const positiveErrors = pairs.map((p) => p.err).filter((err) => Number.isFinite(err) && err > 0);
  if (positiveErrors.length < 8) return pairs;
  const cutoff = percentile(positiveErrors, LK_ERROR_KEEP_FRACTION);
  return pairs.filter((p) => p.err <= cutoff);
}

function filterPairsNearAnchor(
  pairs: FlowPair[],
  anchorX: number,
  anchorY: number,
  maxDistancePx: number,
): FlowPair[] {
  return pairs.filter((p) => {
    const sourceDistance = Math.hypot(p.x0 - anchorX, p.y0 - anchorY);
    if (sourceDistance <= maxDistancePx) return true;
    const targetDistance = Math.hypot(p.x1 - anchorX, p.y1 - anchorY);
    return targetDistance <= maxDistancePx;
  });
}

function localConfidence(
  consensus: SimilarityConsensus,
  trackedPointCount: number,
  maxFeatures: number,
  anchorX: number,
  anchorY: number,
  radiusPx: number,
): number {
  const countScore = clamp(consensus.inliers.length / Math.min(32, maxFeatures), 0, 1);
  const inlierRatio = clamp(consensus.inliers.length / Math.max(1, trackedPointCount), 0, 1);
  const residualScore = 1 - clamp((consensus.residualPx - 0.75) / 5, 0, 1);
  const medianAnchorDistance = median(
    consensus.inliers.map((p) => Math.hypot(p.x0 - anchorX, p.y0 - anchorY)),
  );
  const distanceScore = 1 - clamp((medianAnchorDistance - radiusPx * 0.35) / radiusPx, 0, 1);
  return clamp01(
    0.33 * countScore + 0.3 * inlierRatio + 0.22 * residualScore + 0.15 * distanceScore,
  );
}

function rankAndLimitPoints(
  points: TrackedPoint[],
  centerX: number,
  centerY: number,
  maxFeatures: number,
): TrackedPoint[] {
  return points
    .map((point, rank) => ({
      point,
      score: Math.hypot(point.x - centerX, point.y - centerY) + rank * 0.35,
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, maxFeatures)
    .map((entry) => entry.point);
}

function copyGrayRegion(
  frame: GrayFrame,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcStart = (y0 + y) * frame.width + x0;
    const srcEnd = srcStart + width;
    out.set(frame.buffer.subarray(srcStart, srcEnd), y * width);
  }
  return out;
}

function maskOverlayMarker(
  mat: MatLike,
  cv: LocalCvApi,
  tipX: number,
  tipY: number,
  frame: GrayFrame,
  bounds: Bounds,
  cropW: number,
  cropH: number,
): void {
  const scale = Math.min(frame.width / bounds.width, frame.height / bounds.height);
  const markerW = PIN_MARKER_MASK_WIDTH_SCREEN_PX * scale;
  const markerH = PIN_MARKER_MASK_HEIGHT_SCREEN_PX * scale;
  const belowTip = PIN_MARKER_MASK_BELOW_TIP_SCREEN_PX * scale;
  const flipped = tipY - markerH < 0;
  const x = tipX - markerW / 2;
  const y = flipped ? tipY - belowTip : tipY - markerH;
  const h = markerH + belowTip;
  drawBlack(
    mat,
    cv,
    clamp(Math.round(x), 0, cropW),
    clamp(Math.round(y), 0, cropH),
    clamp(Math.round(x + markerW), 0, cropW) - clamp(Math.round(x), 0, cropW),
    clamp(Math.round(y + h), 0, cropH) - clamp(Math.round(y), 0, cropH),
  );
}

function drawBlack(mat: MatLike, cv: LocalCvApi, x: number, y: number, w: number, h: number): void {
  if (w <= 0 || h <= 0) return;
  cv.rectangle(mat, new cv.Point(x, y), new cv.Point(x + w, y + h), new cv.Scalar(0, 0, 0, 0), -1);
}

function cvReady(cv: LocalCvApi | null): cv is LocalCvApi {
  return (
    typeof cv?.matFromArray === 'function' &&
    typeof cv?.goodFeaturesToTrack === 'function' &&
    typeof cv?.calcOpticalFlowPyrLK === 'function' &&
    typeof cv?.CV_32FC2 === 'number'
  );
}

function usableFrame(frame: GrayFrame): boolean {
  return (
    frame.width >= MIN_DETECT_FRAME_SIZE &&
    frame.height >= MIN_DETECT_FRAME_SIZE &&
    frame.buffer.length >= frame.width * frame.height
  );
}

function pointInFrame(x: number, y: number, frame: { width: number; height: number }): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x < frame.width &&
    y < frame.height
  );
}

function isMasked(
  x: number,
  y: number,
  frame: { width: number; height: number },
  masks: NormalizedRect[],
): boolean {
  const nx = x / frame.width;
  const ny = y / frame.height;
  return masks.some((r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h);
}

function centroid(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / Math.max(1, points.length), y: y / Math.max(1, points.length) };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.ceil(sorted.length * fraction) - 1, 0, sorted.length - 1);
  return sorted[idx]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
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

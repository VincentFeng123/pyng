import type { NormalizedRect } from '@pyng/shared';
import type { GrayFrame } from './capture-loop.js';
import {
  LocalPingAnchorTracker,
  type LocalPingAnchorObservation,
  type LocalPingAnchorTrackerOptions,
} from './local-ping-anchor-tracker.js';
import { getNativeOpenCv } from './native-opencv.js';
import type { PingProjection } from './ping-tracker.js';
import type {
  SurfaceLockKind,
  SurfaceTrackerResult,
  SurfaceTrackingMethod,
} from './surface-tracking-types.js';

type Bounds = {
  width: number;
  height: number;
};

type Point2 = {
  x: number;
  y: number;
};

type Roi = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DescriptorSet = {
  data: Uint8Array;
  rows: number;
  cols: number;
};

type OrbFeatures = {
  keypoints: Point2[];
  descriptors: DescriptorSet | null;
};

type CircleShape = {
  centerX: number;
  centerY: number;
  radius: number;
  relativePingPoint: Point2;
  score: number;
  colorScore: number;
};

type SurfaceTemplate = {
  x: number;
  y: number;
  width: number;
  height: number;
  gray: Uint8Array;
  edge: Uint8Array;
  mask: Uint8Array;
  validCount: number;
  relativePingPoint: Point2;
  colorHistogram: Float32Array | null;
  texture: Float32Array | null;
};

export type PingSurfaceModel = {
  id: string;
  roi: Roi;
  width: number;
  height: number;
  gray: Uint8Array;
  rgb?: Uint8Array;
  mask: Uint8Array;
  edge: Uint8Array;
  relativePingPoint: Point2;
  keypoints: Point2[];
  descriptors: DescriptorSet | null;
  template: SurfaceTemplate | null;
  colorHistogram: Float32Array | null;
  shape: CircleShape | null;
  createdAtNs: number;
  lostFrames: number;
  lastResult: SurfaceTrackerResult | null;
};

export type SurfaceAnchorTrackerOptions = {
  localRadiusScreenPx?: number;
  maxRoiFrameRadiusPx?: number;
  maxOrbFeatures?: number;
  minHomographyMatches?: number;
  templateSizeFramePx?: number;
  enableKltFallback?: boolean;
  _cv?: SurfaceCvApi;
  _kltTracker?: LocalPingAnchorTracker;
  _kltOptions?: LocalPingAnchorTrackerOptions;
};

type SurfaceCvApi = {
  CV_8UC1: number;
  CV_32FC2: number;
  NORM_HAMMING: number;
  RANSAC: number;
  Mat: {
    new (): MatLike;
  };
  matFromArray(rows: number, cols: number, type: number, data: ArrayBufferView): MatLike;
  ORB: new (nFeatures?: number) => OrbLike;
  BFMatcher: new (normType: number, crossCheck?: boolean) => MatcherLike;
  KeyPointVector: new () => VectorLike<KeyPointLike>;
  DMatchVectorVector: new () => VectorLike<VectorLike<DMatchLike>>;
  findHomography(
    srcPoints: MatLike,
    dstPoints: MatLike,
    method: number,
    ransacReprojThreshold: number,
    mask?: MatLike,
  ): MatLike;
};

type MatLike = {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32F: Float32Array;
  data64F: Float64Array;
  delete(): void;
};

type OrbLike = {
  detectAndCompute(
    image: MatLike,
    mask: MatLike,
    keypoints: VectorLike<KeyPointLike>,
    descriptors: MatLike,
  ): void;
  delete(): void;
};

type MatcherLike = {
  knnMatch(
    query: MatLike,
    train: MatLike,
    matches: VectorLike<VectorLike<DMatchLike>>,
    k: number,
  ): void;
  delete(): void;
};

type VectorLike<T> = {
  size(): number;
  get(index: number): T;
  delete(): void;
};

type KeyPointLike = {
  pt: Point2;
};

type DMatchLike = {
  queryIdx: number;
  trainIdx: number;
  distance: number;
};

type SurfaceCandidate = SurfaceTrackerResult & {
  trackingMethod: SurfaceTrackingMethod;
  surfaceLockKind: SurfaceLockKind;
};

type CircleCandidate = {
  x: number;
  y: number;
  radius: number;
  score: number;
  colorScore: number;
  area: number;
};

const DEFAULT_CONTEXT_WINDOW_SCREEN_PX = 500;
const DEFAULT_LOCAL_RADIUS_SCREEN_PX = DEFAULT_CONTEXT_WINDOW_SCREEN_PX / 2;
const DEFAULT_MAX_ROI_FRAME_RADIUS_PX = 180;
const DEFAULT_MAX_ORB_FEATURES = 220;
const DEFAULT_MIN_HOMOGRAPHY_MATCHES = 10;
const DEFAULT_TEMPLATE_SIZE_FRAME_PX = 112;
const MIN_ROI_SIZE_PX = 40;
const HOMOGRAPHY_RATIO_TEST = 0.75;
const HOMOGRAPHY_RANSAC_THRESHOLD_PX = 4;
const HOMOGRAPHY_AGREE_PX = 10;
const STRONG_HOMOGRAPHY_INLIERS = 14;
const STRONG_HOMOGRAPHY_RESIDUAL_PX = 3.2;
const SHAPE_STRONG_CONFIDENCE = 0.72;
const TEMPLATE_MIN_CONFIDENCE = 0.38;
const KLT_MIN_CONFIDENCE = 0.35;
const VISUAL_DISAGREE_PX = 18;
const TEMPLATE_SEARCH_RADIUS_PX = 76;
const TEMPLATE_SCORE_FLOOR = 0.54;
const TEMPLATE_SCORE_MARGIN_FLOOR = 0.015;
const TEMPLATE_COARSE_SAMPLE_STRIDE = 5;
const TEMPLATE_SAMPLE_STRIDE = 2;
const TEMPLATE_APPEARANCE_STRIDE = 3;
const TEMPLATE_TOP_CANDIDATE_LIMIT = 8;
const TEMPLATE_DISTINCT_CANDIDATE_PX = 14;
const PIN_MARKER_MASK_WIDTH_SCREEN_PX = 58;
const PIN_MARKER_MASK_HEIGHT_SCREEN_PX = 58;
const PIN_MARKER_MASK_BELOW_TIP_SCREEN_PX = 6;
const MIN_TEMPLATE_VALID_PIXELS = 160;
const MIN_CIRCLE_AREA = 44;
const MAX_CIRCLE_CANDIDATES = 8;
const TEXTURE_GRID_SIZE = 4;
const COLOR_HISTOGRAM_BINS = 12;

export class SurfaceAnchorTracker {
  private readonly localRadiusScreenPx: number;
  private readonly maxRoiFrameRadiusPx: number;
  private readonly maxOrbFeatures: number;
  private readonly minHomographyMatches: number;
  private readonly templateSizeFramePx: number;
  private readonly enableKltFallback: boolean;
  private readonly cv: SurfaceCvApi;
  private readonly kltTracker: LocalPingAnchorTracker | null;
  private models = new Map<string, PingSurfaceModel>();

  constructor(options: SurfaceAnchorTrackerOptions = {}) {
    this.localRadiusScreenPx = Math.max(
      80,
      Math.round(options.localRadiusScreenPx ?? DEFAULT_LOCAL_RADIUS_SCREEN_PX),
    );
    this.maxRoiFrameRadiusPx = Math.max(
      48,
      Math.round(options.maxRoiFrameRadiusPx ?? DEFAULT_MAX_ROI_FRAME_RADIUS_PX),
    );
    this.maxOrbFeatures = Math.max(
      32,
      Math.round(options.maxOrbFeatures ?? DEFAULT_MAX_ORB_FEATURES),
    );
    this.minHomographyMatches = Math.max(
      4,
      Math.round(options.minHomographyMatches ?? DEFAULT_MIN_HOMOGRAPHY_MATCHES),
    );
    this.templateSizeFramePx = Math.max(
      41,
      Math.round(options.templateSizeFramePx ?? DEFAULT_TEMPLATE_SIZE_FRAME_PX),
    );
    this.enableKltFallback =
      options.enableKltFallback ??
      (options._kltTracker !== undefined || process.env.PYNG_ENABLE_SURFACE_KLT === '1');
    this.cv = options._cv ?? (getNativeOpenCv() as unknown as SurfaceCvApi);
    this.kltTracker =
      options._kltTracker ??
      (this.enableKltFallback
        ? new LocalPingAnchorTracker(options._kltOptions ?? undefined)
        : null);
  }

  reset(): void {
    this.models.clear();
    this.kltTracker?.reset();
  }

  getModel(id: string): PingSurfaceModel | null {
    return this.models.get(id) ?? null;
  }

  update(
    prevFrame: GrayFrame | null,
    frame: GrayFrame,
    projections: PingProjection[],
    bounds: Bounds,
    maskRegions: NormalizedRect[],
    observedAtNs: number,
  ): SurfaceTrackerResult[] {
    if (!usableFrame(frame) || bounds.width <= 0 || bounds.height <= 0) {
      this.reset();
      return [];
    }

    const liveIds = new Set(projections.map((p) => p.id));
    for (const id of this.models.keys()) {
      if (!liveIds.has(id)) this.models.delete(id);
    }

    const kltObservations = new Map<string, LocalPingAnchorObservation>();
    if (this.kltTracker !== null) {
      for (const observation of this.kltTracker.update(
        prevFrame,
        frame,
        projections,
        bounds,
        maskRegions,
        observedAtNs,
      )) {
        kltObservations.set(observation.id, observation);
      }
    }

    const scaleX = frame.width / bounds.width;
    const scaleY = frame.height / bounds.height;
    const results: SurfaceTrackerResult[] = [];

    for (const projection of projections) {
      if (projection.isEdgeArrow) continue;

      const predictedFrame = {
        x: projection.screenX * scaleX,
        y: projection.screenY * scaleY,
      };
      let model: PingSurfaceModel | null = this.models.get(projection.id) ?? null;
      if (!model) {
        model = this.createModel(
          projection.id,
          frame,
          predictedFrame,
          bounds,
          maskRegions,
          observedAtNs,
        );
        if (model) this.models.set(projection.id, model);
      }

      const candidates: SurfaceCandidate[] = [];
      if (model) {
        const homography = this.trackHomography(
          model,
          frame,
          predictedFrame,
          scaleX,
          scaleY,
          observedAtNs,
        );
        if (homography) candidates.push(homography);

        const shape = this.trackShape(
          model,
          frame,
          predictedFrame,
          bounds,
          maskRegions,
          scaleX,
          scaleY,
          observedAtNs,
        );
        if (shape) candidates.push(shape);

        const template = this.trackTemplate(
          model,
          frame,
          predictedFrame,
          scaleX,
          scaleY,
          observedAtNs,
        );
        if (template) candidates.push(template);
      }

      const klt = kltObservations.get(projection.id);
      if (klt && this.kltObservationFitsSurface(klt, projection, frame, bounds)) {
        candidates.push({
          ...klt,
          trackingMethod: 'klt',
          surfaceConfidence: klt.confidence,
          surfaceLockKind: 'unknown',
        });
      }

      const selected = this.selectCandidate(
        projection,
        candidates,
        observedAtNs,
        model?.lastResult ?? null,
      );
      if (model) {
        if (selected.trackingMethod === 'prediction') {
          model.lostFrames += 1;
        } else {
          model.lostFrames = 0;
          model.lastResult = selected;
        }
      }
      results.push(selected);
    }

    return results;
  }

  private createModel(
    id: string,
    frame: GrayFrame,
    center: Point2,
    bounds: Bounds,
    maskRegions: NormalizedRect[],
    observedAtNs: number,
  ): PingSurfaceModel | null {
    if (!pointInFrame(center.x, center.y, frame)) return null;

    const radius = this.captureRadiusFramePx(frame, bounds);
    const roi = roiAround(center.x, center.y, radius, frame.width, frame.height);
    if (roi.width < MIN_ROI_SIZE_PX || roi.height < MIN_ROI_SIZE_PX) return null;

    const gray = copyGrayRegion(frame.buffer, frame.width, roi);
    const rgb = copyRgbRegion(frame, roi);
    const mask = buildSurfaceMask(roi, frame, bounds, maskRegions, {
      x: center.x - roi.x,
      y: center.y - roi.y,
    });
    const edge = sobelEdges(gray, roi.width, roi.height, mask);
    const relativePingPoint = { x: center.x - roi.x, y: center.y - roi.y };
    const features = detectOrbFeatures(
      this.cv,
      gray,
      roi.width,
      roi.height,
      mask,
      this.maxOrbFeatures,
    );
    const template = createTemplate(
      gray,
      rgb,
      mask,
      roi.width,
      roi.height,
      relativePingPoint,
      this.templateSizeFramePx,
    );
    const colorHistogram = rgb ? colorHistogramForRegion(rgb, mask) : null;
    const shape = selectModelCircle(gray, rgb, mask, roi.width, roi.height, relativePingPoint);

    return {
      id,
      roi,
      width: roi.width,
      height: roi.height,
      gray,
      rgb,
      mask,
      edge,
      relativePingPoint,
      keypoints: features.keypoints,
      descriptors: features.descriptors,
      template,
      colorHistogram,
      shape,
      createdAtNs: observedAtNs,
      lostFrames: 0,
      lastResult: null,
    };
  }

  private trackHomography(
    model: PingSurfaceModel,
    frame: GrayFrame,
    predictedFrame: Point2,
    scaleX: number,
    scaleY: number,
    observedAtNs: number,
  ): SurfaceCandidate | null {
    if (
      !cvReady(this.cv) ||
      !model.descriptors ||
      model.keypoints.length < this.minHomographyMatches
    ) {
      return null;
    }

    const searchRadius = Math.min(
      this.maxRoiFrameRadiusPx * 1.45,
      Math.max(model.width, model.height) * 0.68 + 42,
    );
    const searchRoi = roiAround(
      predictedFrame.x,
      predictedFrame.y,
      searchRadius,
      frame.width,
      frame.height,
    );
    if (searchRoi.width < MIN_ROI_SIZE_PX || searchRoi.height < MIN_ROI_SIZE_PX) return null;

    const searchGray = copyGrayRegion(frame.buffer, frame.width, searchRoi);
    const searchMask = new Uint8Array(searchRoi.width * searchRoi.height).fill(1);
    const current = detectOrbFeatures(
      this.cv,
      searchGray,
      searchRoi.width,
      searchRoi.height,
      searchMask,
      this.maxOrbFeatures,
    );
    if (!current.descriptors || current.keypoints.length < this.minHomographyMatches) return null;

    const matches = matchOrbDescriptors(this.cv, model.descriptors, current.descriptors);
    const good = matches.filter(
      (m) =>
        m.queryIdx >= 0 &&
        m.queryIdx < model.keypoints.length &&
        m.trainIdx >= 0 &&
        m.trainIdx < current.keypoints.length,
    );
    if (good.length < this.minHomographyMatches) return null;

    const srcData = new Float32Array(good.length * 2);
    const dstData = new Float32Array(good.length * 2);
    for (let i = 0; i < good.length; i++) {
      const match = good[i]!;
      const src = model.keypoints[match.queryIdx]!;
      const dst = current.keypoints[match.trainIdx]!;
      srcData[i * 2] = src.x;
      srcData[i * 2 + 1] = src.y;
      dstData[i * 2] = dst.x + searchRoi.x;
      dstData[i * 2 + 1] = dst.y + searchRoi.y;
    }

    const homography = findHomography(this.cv, srcData, dstData, good.length);
    if (!homography) return null;
    const { matrix, inlierMask } = homography;
    const residuals: number[] = [];
    let inliers = 0;
    for (let i = 0; i < good.length; i++) {
      if (inlierMask[i] === 0) continue;
      const projected = applyHomography(matrix, srcData[i * 2]!, srcData[i * 2 + 1]!);
      const residual = Math.hypot(projected.x - dstData[i * 2]!, projected.y - dstData[i * 2 + 1]!);
      if (Number.isFinite(residual)) {
        inliers += 1;
        residuals.push(residual);
      }
    }
    if (inliers < this.minHomographyMatches) return null;

    const mapped = applyHomography(matrix, model.relativePingPoint.x, model.relativePingPoint.y);
    if (!pointInFrame(mapped.x, mapped.y, frame)) return null;
    const residualPx = median(residuals);
    const countScore = clamp(inliers / 32, 0, 1);
    const ratioScore = clamp(inliers / Math.max(1, good.length), 0, 1);
    const residualScore = 1 - clamp((residualPx - 1.2) / 5, 0, 1);
    const proximityScore =
      1 -
      clamp(
        Math.hypot(mapped.x - predictedFrame.x, mapped.y - predictedFrame.y) / searchRadius,
        0,
        1,
      );
    const confidence = clamp01(
      0.34 * countScore + 0.26 * ratioScore + 0.24 * residualScore + 0.16 * proximityScore,
    );

    return {
      id: model.id,
      screenX: mapped.x / scaleX,
      screenY: mapped.y / scaleY,
      confidence,
      observedAtNs,
      inlierCount: inliers,
      trackedPointCount: good.length,
      residualPx,
      trackingMethod: 'homography',
      surfaceConfidence: confidence,
      surfaceLockKind: 'plane',
    };
  }

  private trackShape(
    model: PingSurfaceModel,
    frame: GrayFrame,
    predictedFrame: Point2,
    bounds: Bounds,
    maskRegions: NormalizedRect[],
    scaleX: number,
    scaleY: number,
    observedAtNs: number,
  ): SurfaceCandidate | null {
    if (!model.shape) return null;

    const radius = Math.max(TEMPLATE_SEARCH_RADIUS_PX, model.shape.radius * 2.4);
    const roi = roiAround(predictedFrame.x, predictedFrame.y, radius, frame.width, frame.height);
    if (roi.width < MIN_ROI_SIZE_PX || roi.height < MIN_ROI_SIZE_PX) return null;

    const gray = copyGrayRegion(frame.buffer, frame.width, roi);
    const rgb = copyRgbRegion(frame, roi);
    const mask = buildSurfaceMask(roi, frame, bounds, maskRegions, {
      x: predictedFrame.x - roi.x,
      y: predictedFrame.y - roi.y,
    });
    const candidates = findCircleCandidates(gray, rgb, mask, roi.width, roi.height);
    if (candidates.length === 0) return null;

    let best: (CircleCandidate & { pingFrame: Point2; combinedScore: number }) | null = null;
    for (const candidate of candidates) {
      const radiusRatio = candidate.radius / Math.max(1, model.shape.radius);
      if (radiusRatio < 0.55 || radiusRatio > 1.75) continue;
      const pingFrame = {
        x: roi.x + candidate.x + model.shape.relativePingPoint.x * candidate.radius,
        y: roi.y + candidate.y + model.shape.relativePingPoint.y * candidate.radius,
      };
      const proximity =
        1 -
        clamp(
          Math.hypot(pingFrame.x - predictedFrame.x, pingFrame.y - predictedFrame.y) / radius,
          0,
          1,
        );
      const scaleScore = 1 - clamp(Math.abs(Math.log(radiusRatio)) / Math.log(1.75), 0, 1);
      const colorScore = model.shape.colorScore > 0.25 ? candidate.colorScore : 0.5;
      const combinedScore = clamp01(
        0.42 * candidate.score + 0.22 * proximity + 0.18 * scaleScore + 0.18 * colorScore,
      );
      if (best === null || combinedScore > best.combinedScore) {
        best = { ...candidate, pingFrame, combinedScore };
      }
    }

    if (best === null || best.combinedScore < 0.42) return null;
    const confidence = best.combinedScore;
    return {
      id: model.id,
      screenX: best.pingFrame.x / scaleX,
      screenY: best.pingFrame.y / scaleY,
      confidence,
      observedAtNs,
      inlierCount: Math.round(best.area),
      trackedPointCount: best.area,
      residualPx: Math.max(0, (1 - best.score) * 8),
      trackingMethod: 'shape',
      surfaceConfidence: confidence,
      surfaceLockKind: 'circle',
    };
  }

  private trackTemplate(
    model: PingSurfaceModel,
    frame: GrayFrame,
    predictedFrame: Point2,
    scaleX: number,
    scaleY: number,
    observedAtNs: number,
  ): SurfaceCandidate | null {
    if (!model.template) return null;
    const match = findTemplateMatch(frame, model.template, predictedFrame);
    if (!match) return null;

    const confidence = clamp01(
      0.72 * clamp((match.score - TEMPLATE_SCORE_FLOOR) / (1 - TEMPLATE_SCORE_FLOOR), 0, 1) +
        0.28 *
          clamp(
            (match.scoreMargin - TEMPLATE_SCORE_MARGIN_FLOOR) /
              Math.max(0.01, 0.12 - TEMPLATE_SCORE_MARGIN_FLOOR),
            0,
            1,
          ),
    );
    if (confidence < TEMPLATE_MIN_CONFIDENCE) return null;

    const frameX = match.x + model.template.relativePingPoint.x * match.scale;
    const frameY = match.y + model.template.relativePingPoint.y * match.scale;
    return {
      id: model.id,
      screenX: frameX / scaleX,
      screenY: frameY / scaleY,
      confidence,
      observedAtNs,
      inlierCount: match.sampleCount,
      trackedPointCount: match.sampleCount,
      residualPx: Math.max(0, (1 - match.score) * 12),
      trackingMethod: 'template',
      surfaceConfidence: confidence,
      surfaceLockKind: 'template',
    };
  }

  private selectCandidate(
    projection: PingProjection,
    candidates: SurfaceCandidate[],
    observedAtNs: number,
    lastResult: SurfaceTrackerResult | null,
  ): SurfaceCandidate {
    const prediction = predictionCandidate(projection, observedAtNs);
    if (candidates.length === 0) return prediction;

    const homography = bestByMethod(candidates, 'homography');
    const shape = bestByMethod(candidates, 'shape');
    if (homography && shape && distance(homography, shape) <= HOMOGRAPHY_AGREE_PX) {
      const confidence = clamp01(Math.max(homography.confidence, shape.confidence) + 0.08);
      const x =
        (homography.screenX * homography.confidence + shape.screenX * shape.confidence) /
        Math.max(1e-6, homography.confidence + shape.confidence);
      const y =
        (homography.screenY * homography.confidence + shape.screenY * shape.confidence) /
        Math.max(1e-6, homography.confidence + shape.confidence);
      return {
        ...homography,
        screenX: x,
        screenY: y,
        confidence,
        surfaceConfidence: confidence,
        surfaceLockKind: 'circle',
        inlierCount: homography.inlierCount + shape.inlierCount,
        trackedPointCount: homography.trackedPointCount + shape.trackedPointCount,
        residualPx: Math.min(homography.residualPx, shape.residualPx),
      };
    }

    if (
      homography &&
      homography.inlierCount >= STRONG_HOMOGRAPHY_INLIERS &&
      homography.residualPx <= STRONG_HOMOGRAPHY_RESIDUAL_PX
    ) {
      return homography;
    }

    if (shape && shape.confidence >= SHAPE_STRONG_CONFIDENCE) return shape;

    const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
    const [first, second] = sorted;
    if (
      first &&
      second &&
      first.confidence >= 0.55 &&
      second.confidence >= 0.55 &&
      distance(first, second) > VISUAL_DISAGREE_PX
    ) {
      if (lastResult && distance(first, lastResult) <= VISUAL_DISAGREE_PX) return first;
      if (lastResult && distance(second, lastResult) <= VISUAL_DISAGREE_PX) return second;
      return {
        ...prediction,
        confidence: Math.min(prediction.confidence, 0.12),
        surfaceConfidence: 0.12,
      };
    }

    const template = bestByMethod(candidates, 'template');
    if (template && template.confidence >= TEMPLATE_MIN_CONFIDENCE) return template;

    const klt = bestByMethod(candidates, 'klt');
    if (klt && klt.confidence >= KLT_MIN_CONFIDENCE) return klt;

    return first && first.confidence >= 0.25 ? first : prediction;
  }

  private kltObservationFitsSurface(
    observation: LocalPingAnchorObservation,
    projection: PingProjection,
    frame: GrayFrame,
    bounds: Bounds,
  ): boolean {
    const scaleX = frame.width / bounds.width;
    const scaleY = frame.height / bounds.height;
    const observedFrameX = observation.screenX * scaleX;
    const observedFrameY = observation.screenY * scaleY;
    const predictedFrameX = projection.screenX * scaleX;
    const predictedFrameY = projection.screenY * scaleY;
    if (!pointInFrame(observedFrameX, observedFrameY, frame)) return false;
    const radius = this.captureRadiusFramePx(frame, bounds) * 1.9;
    return Math.hypot(observedFrameX - predictedFrameX, observedFrameY - predictedFrameY) <= radius;
  }

  private captureRadiusFramePx(frame: GrayFrame, bounds: Bounds): number {
    const scale = Math.min(frame.width / bounds.width, frame.height / bounds.height);
    return clamp(this.localRadiusScreenPx * scale, 36, this.maxRoiFrameRadiusPx);
  }
}

function predictionCandidate(projection: PingProjection, observedAtNs: number): SurfaceCandidate {
  const confidence = clamp01(projection.confidence * 0.14);
  return {
    id: projection.id,
    screenX: projection.screenX,
    screenY: projection.screenY,
    confidence,
    observedAtNs,
    inlierCount: 0,
    trackedPointCount: 0,
    residualPx: Number.POSITIVE_INFINITY,
    trackingMethod: 'prediction',
    surfaceConfidence: confidence,
    surfaceLockKind: 'unknown',
  };
}

function bestByMethod(
  candidates: SurfaceCandidate[],
  method: SurfaceTrackingMethod,
): SurfaceCandidate | null {
  let best: SurfaceCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.trackingMethod !== method) continue;
    if (best === null || candidate.confidence > best.confidence) best = candidate;
  }
  return best;
}

function detectOrbFeatures(
  cv: SurfaceCvApi,
  gray: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
  maxFeatures: number,
): OrbFeatures {
  if (!cvReady(cv)) return { keypoints: [], descriptors: null };
  const mats: MatLike[] = [];
  const vectors: Array<{ delete(): void }> = [];
  const trackMat = <T extends MatLike>(mat: T): T => {
    mats.push(mat);
    return mat;
  };
  const trackVector = <T extends { delete(): void }>(v: T): T => {
    vectors.push(v);
    return v;
  };

  try {
    const imageMat = trackMat(cv.matFromArray(height, width, cv.CV_8UC1, gray));
    const maskMat = trackMat(cv.matFromArray(height, width, cv.CV_8UC1, maskTo255(mask)));
    const keypoints = trackVector(new cv.KeyPointVector());
    const descriptors = trackMat(new cv.Mat());
    const orb = trackVector(new cv.ORB(maxFeatures));
    orb.detectAndCompute(imageMat, maskMat, keypoints, descriptors);

    const points: Point2[] = [];
    for (let i = 0; i < keypoints.size(); i++) {
      const kp = keypoints.get(i);
      if (Number.isFinite(kp.pt.x) && Number.isFinite(kp.pt.y)) {
        points.push({ x: kp.pt.x, y: kp.pt.y });
      }
    }

    const cols =
      descriptors.cols || (descriptors.rows > 0 ? descriptors.data.length / descriptors.rows : 0);
    if (descriptors.rows <= 0 || cols <= 0 || descriptors.data.length < descriptors.rows * cols) {
      return { keypoints: points, descriptors: null };
    }
    return {
      keypoints: points,
      descriptors: {
        rows: descriptors.rows,
        cols,
        data: new Uint8Array(descriptors.data.slice(0, descriptors.rows * cols)),
      },
    };
  } catch {
    return { keypoints: [], descriptors: null };
  } finally {
    for (const v of vectors) {
      try {
        v.delete();
      } catch {
        /* ignore */
      }
    }
    for (const mat of mats) {
      try {
        mat.delete();
      } catch {
        /* ignore */
      }
    }
  }
}

function matchOrbDescriptors(
  cv: SurfaceCvApi,
  model: DescriptorSet,
  current: DescriptorSet,
): DMatchLike[] {
  if (!cvReady(cv) || model.rows <= 0 || current.rows <= 0) return [];
  const mats: MatLike[] = [];
  const vectors: Array<{ delete(): void }> = [];
  const trackMat = <T extends MatLike>(mat: T): T => {
    mats.push(mat);
    return mat;
  };
  const trackVector = <T extends { delete(): void }>(v: T): T => {
    vectors.push(v);
    return v;
  };

  try {
    const modelMat = trackMat(cv.matFromArray(model.rows, model.cols, cv.CV_8UC1, model.data));
    const currentMat = trackMat(
      cv.matFromArray(current.rows, current.cols, cv.CV_8UC1, current.data),
    );
    const matcher = trackVector(new cv.BFMatcher(cv.NORM_HAMMING, false));
    const knn = trackVector(new cv.DMatchVectorVector());
    matcher.knnMatch(modelMat, currentMat, knn, 2);

    const good: DMatchLike[] = [];
    for (let i = 0; i < knn.size(); i++) {
      const pair = trackVector(knn.get(i));
      if (pair.size() < 2) continue;
      const first = pair.get(0);
      const second = pair.get(1);
      if (first.distance <= HOMOGRAPHY_RATIO_TEST * Math.max(1e-6, second.distance)) {
        good.push(first);
      }
    }
    return good;
  } catch {
    return [];
  } finally {
    for (const v of vectors) {
      try {
        v.delete();
      } catch {
        /* ignore */
      }
    }
    for (const mat of mats) {
      try {
        mat.delete();
      } catch {
        /* ignore */
      }
    }
  }
}

function findHomography(
  cv: SurfaceCvApi,
  srcData: Float32Array,
  dstData: Float32Array,
  count: number,
): { matrix: Float64Array; inlierMask: Uint8Array } | null {
  const mats: MatLike[] = [];
  const trackMat = <T extends MatLike>(mat: T): T => {
    mats.push(mat);
    return mat;
  };
  try {
    const src = trackMat(cv.matFromArray(count, 1, cv.CV_32FC2, srcData));
    const dst = trackMat(cv.matFromArray(count, 1, cv.CV_32FC2, dstData));
    const mask = trackMat(new cv.Mat());
    const h = trackMat(
      cv.findHomography(src, dst, cv.RANSAC, HOMOGRAPHY_RANSAC_THRESHOLD_PX, mask),
    );
    if (h.rows !== 3 || h.cols !== 3 || h.data64F.length < 9) return null;
    return {
      matrix: new Float64Array(h.data64F.slice(0, 9)),
      inlierMask: new Uint8Array(mask.data.slice(0, count)),
    };
  } catch {
    return null;
  } finally {
    for (const mat of mats) {
      try {
        mat.delete();
      } catch {
        /* ignore */
      }
    }
  }
}

export function applyHomography(matrix: Float64Array, x: number, y: number): Point2 {
  const d = matrix[6]! * x + matrix[7]! * y + matrix[8]!;
  if (Math.abs(d) < 1e-9) return { x: Number.NaN, y: Number.NaN };
  return {
    x: (matrix[0]! * x + matrix[1]! * y + matrix[2]!) / d,
    y: (matrix[3]! * x + matrix[4]! * y + matrix[5]!) / d,
  };
}

function createTemplate(
  gray: Uint8Array,
  rgb: Uint8Array | undefined,
  mask: Uint8Array,
  width: number,
  height: number,
  relativePingPoint: Point2,
  requestedSize: number,
): SurfaceTemplate | null {
  const size = Math.max(31, Math.min(requestedSize, width, height));
  const half = Math.floor(size / 2);
  const x = clamp(Math.round(relativePingPoint.x) - half, 0, width - size);
  const y = clamp(Math.round(relativePingPoint.y) - half, 0, height - size);
  const outGray = new Uint8Array(size * size);
  const outMask = new Uint8Array(size * size);
  let validCount = 0;
  for (let py = 0; py < size; py++) {
    const srcOffset = (y + py) * width + x;
    const dstOffset = py * size;
    outGray.set(gray.subarray(srcOffset, srcOffset + size), dstOffset);
    for (let px = 0; px < size; px++) {
      const valid = mask[srcOffset + px]!;
      outMask[dstOffset + px] = valid;
      validCount += valid;
    }
  }
  if (validCount < MIN_TEMPLATE_VALID_PIXELS) return null;
  return {
    x,
    y,
    width: size,
    height: size,
    gray: outGray,
    edge: sobelEdges(outGray, size, size, outMask),
    mask: outMask,
    validCount,
    relativePingPoint: {
      x: relativePingPoint.x - x,
      y: relativePingPoint.y - y,
    },
    colorHistogram: colorHistogramForPatch(rgb, width, x, y, size, size, outMask),
    texture: textureSignature(outGray, outMask, size, size),
  };
}

function findTemplateMatch(
  frame: GrayFrame,
  template: SurfaceTemplate,
  predictedFrame: Point2,
): {
  x: number;
  y: number;
  scale: number;
  score: number;
  scoreMargin: number;
  sampleCount: number;
} | null {
  const candidates: Array<{
    x: number;
    y: number;
    scale: number;
    grayScore: number;
    sampleCount: number;
  }> = [];
  const scales = [0.85, 1, 1.15];

  for (const scale of scales) {
    const scaledW = Math.max(8, Math.round(template.width * scale));
    const scaledH = Math.max(8, Math.round(template.height * scale));
    const predictedX = predictedFrame.x - template.relativePingPoint.x * scale;
    const predictedY = predictedFrame.y - template.relativePingPoint.y * scale;
    const step = scale < 0.95 ? 5 : 4;
    for (
      let y = Math.round(predictedY - TEMPLATE_SEARCH_RADIUS_PX);
      y <= predictedY + TEMPLATE_SEARCH_RADIUS_PX;
      y += step
    ) {
      if (y < 0 || y + scaledH >= frame.height) continue;
      for (
        let x = Math.round(predictedX - TEMPLATE_SEARCH_RADIUS_PX);
        x <= predictedX + TEMPLATE_SEARCH_RADIUS_PX;
        x += step
      ) {
        if (x < 0 || x + scaledW >= frame.width) continue;
        const score = scoreTemplateAt(frame, template, x, y, scale, TEMPLATE_COARSE_SAMPLE_STRIDE);
        rememberTemplateCandidate(candidates, {
          x,
          y,
          scale,
          grayScore: score.score,
          sampleCount: score.sampleCount,
        });
      }
    }
  }

  const ranked = candidates
    .map((candidate) => {
      const appearance = scoreTemplateAppearance(
        frame,
        template,
        candidate.x,
        candidate.y,
        candidate.scale,
      );
      return {
        x: candidate.x,
        y: candidate.y,
        scale: candidate.scale,
        score: appearance.score,
        sampleCount: candidate.sampleCount,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < TEMPLATE_SCORE_FLOOR) return null;

  const secondBestScore = ranked[1]?.score ?? -1;

  let refined = best;
  for (let y = best.y - 2; y <= best.y + 2; y++) {
    if (y < 0 || y + template.height * best.scale >= frame.height) continue;
    for (let x = best.x - 2; x <= best.x + 2; x++) {
      if (x < 0 || x + template.width * best.scale >= frame.width) continue;
      const score = scoreTemplateAppearance(frame, template, x, y, best.scale);
      if (score.score > refined.score) {
        refined = { x, y, scale: best.scale, score: score.score, sampleCount: score.sampleCount };
      }
    }
  }

  return {
    ...refined,
    scoreMargin: refined.score - secondBestScore,
  };
}

function rememberTemplateCandidate(
  candidates: Array<{
    x: number;
    y: number;
    scale: number;
    grayScore: number;
    sampleCount: number;
  }>,
  candidate: {
    x: number;
    y: number;
    scale: number;
    grayScore: number;
    sampleCount: number;
  },
): void {
  if (candidate.sampleCount < 40 || candidate.grayScore < TEMPLATE_SCORE_FLOOR - 0.18) {
    return;
  }

  for (let i = 0; i < candidates.length; i++) {
    const existing = candidates[i]!;
    if (
      Math.abs(existing.scale - candidate.scale) < 0.01 &&
      Math.hypot(existing.x - candidate.x, existing.y - candidate.y) <
        TEMPLATE_DISTINCT_CANDIDATE_PX
    ) {
      if (candidate.grayScore > existing.grayScore) candidates[i] = candidate;
      return;
    }
  }

  candidates.push(candidate);
  candidates.sort((a, b) => b.grayScore - a.grayScore);
  if (candidates.length > TEMPLATE_TOP_CANDIDATE_LIMIT)
    candidates.length = TEMPLATE_TOP_CANDIDATE_LIMIT;
}

function scoreTemplateAppearance(
  frame: GrayFrame,
  template: SurfaceTemplate,
  x0: number,
  y0: number,
  scale: number,
): { score: number; sampleCount: number } {
  const gray = scoreTemplateAt(frame, template, x0, y0, scale, TEMPLATE_SAMPLE_STRIDE);
  if (gray.sampleCount < 40) return gray;

  const signals: Array<{ score: number; weight: number }> = [
    { score: clamp01(gray.score), weight: 0.46 },
  ];

  const edge = scoreEdgeAt(frame, template, x0, y0, scale, TEMPLATE_APPEARANCE_STRIDE);
  if (edge !== null) signals.push({ score: edge, weight: 0.2 });

  const texture = textureSignatureAt(frame, template, x0, y0, scale, TEMPLATE_APPEARANCE_STRIDE);
  if (template.texture && texture) {
    signals.push({ score: signatureSimilarity(template.texture, texture, 68), weight: 0.2 });
  }

  const color = colorHistogramAtTemplate(
    frame,
    template,
    x0,
    y0,
    scale,
    TEMPLATE_APPEARANCE_STRIDE,
  );
  if (template.colorHistogram && color) {
    signals.push({ score: histogramIntersection(template.colorHistogram, color), weight: 0.14 });
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const signal of signals) {
    weighted += signal.score * signal.weight;
    totalWeight += signal.weight;
  }

  return {
    score: totalWeight > 0 ? weighted / totalWeight : gray.score,
    sampleCount: gray.sampleCount,
  };
}

function scoreTemplateAt(
  frame: GrayFrame,
  template: SurfaceTemplate,
  x0: number,
  y0: number,
  scale: number,
  stride: number,
): { score: number; sampleCount: number } {
  let templateSum = 0;
  let candidateSum = 0;
  let sampleCount = 0;
  for (let ty = 0; ty < template.height; ty += stride) {
    for (let tx = 0; tx < template.width; tx += stride) {
      const idx = ty * template.width + tx;
      if (template.mask[idx] === 0) continue;
      const fx = x0 + Math.round(tx * scale);
      const fy = y0 + Math.round(ty * scale);
      if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) continue;
      templateSum += template.gray[idx]!;
      candidateSum += frame.buffer[fy * frame.width + fx]!;
      sampleCount += 1;
    }
  }
  if (sampleCount < 40) return { score: -1, sampleCount };
  const templateMean = templateSum / sampleCount;
  const candidateMean = candidateSum / sampleCount;

  let numerator = 0;
  let templateNorm = 0;
  let candidateNorm = 0;
  for (let ty = 0; ty < template.height; ty += stride) {
    for (let tx = 0; tx < template.width; tx += stride) {
      const idx = ty * template.width + tx;
      if (template.mask[idx] === 0) continue;
      const fx = x0 + Math.round(tx * scale);
      const fy = y0 + Math.round(ty * scale);
      if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) continue;
      const tv = template.gray[idx]! - templateMean;
      const cv = frame.buffer[fy * frame.width + fx]! - candidateMean;
      numerator += tv * cv;
      templateNorm += tv * tv;
      candidateNorm += cv * cv;
    }
  }
  const denom = Math.sqrt(templateNorm) * Math.sqrt(candidateNorm);
  if (denom < 1e-6) return { score: -1, sampleCount };
  return { score: numerator / denom, sampleCount };
}

function scoreEdgeAt(
  frame: GrayFrame,
  template: SurfaceTemplate,
  x0: number,
  y0: number,
  scale: number,
  stride: number,
): number | null {
  let templateSum = 0;
  let candidateSum = 0;
  let sampleCount = 0;
  for (let ty = 1; ty + 1 < template.height; ty += stride) {
    for (let tx = 1; tx + 1 < template.width; tx += stride) {
      const idx = ty * template.width + tx;
      if (template.mask[idx] === 0) continue;
      const fx = x0 + Math.round(tx * scale);
      const fy = y0 + Math.round(ty * scale);
      if (fx <= 0 || fy <= 0 || fx + 1 >= frame.width || fy + 1 >= frame.height) continue;
      templateSum += template.edge[idx]!;
      candidateSum += edgeMagnitudeAt(frame.buffer, frame.width, fx, fy);
      sampleCount += 1;
    }
  }
  if (sampleCount < 40) return null;

  const templateMean = templateSum / sampleCount;
  const candidateMean = candidateSum / sampleCount;
  let numerator = 0;
  let templateNorm = 0;
  let candidateNorm = 0;
  for (let ty = 1; ty + 1 < template.height; ty += stride) {
    for (let tx = 1; tx + 1 < template.width; tx += stride) {
      const idx = ty * template.width + tx;
      if (template.mask[idx] === 0) continue;
      const fx = x0 + Math.round(tx * scale);
      const fy = y0 + Math.round(ty * scale);
      if (fx <= 0 || fy <= 0 || fx + 1 >= frame.width || fy + 1 >= frame.height) continue;
      const tv = template.edge[idx]! - templateMean;
      const cv = edgeMagnitudeAt(frame.buffer, frame.width, fx, fy) - candidateMean;
      numerator += tv * cv;
      templateNorm += tv * tv;
      candidateNorm += cv * cv;
    }
  }
  const denom = Math.sqrt(templateNorm) * Math.sqrt(candidateNorm);
  if (denom < 1e-6) return null;
  return clamp01(numerator / denom);
}

function edgeMagnitudeAt(gray: Uint8Array, width: number, x: number, y: number): number {
  const idx = y * width + x;
  const gx =
    -gray[idx - width - 1]! -
    2 * gray[idx - 1]! -
    gray[idx + width - 1]! +
    gray[idx - width + 1]! +
    2 * gray[idx + 1]! +
    gray[idx + width + 1]!;
  const gy =
    -gray[idx - width - 1]! -
    2 * gray[idx - width]! -
    gray[idx - width + 1]! +
    gray[idx + width - 1]! +
    2 * gray[idx + width]! +
    gray[idx + width + 1]!;
  return Math.min(255, Math.hypot(gx, gy) / 4);
}

function textureSignature(
  gray: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
): Float32Array | null {
  const values = new Float32Array(TEXTURE_GRID_SIZE * TEXTURE_GRID_SIZE * 2);
  let populated = 0;
  for (let gy = 0; gy < TEXTURE_GRID_SIZE; gy++) {
    for (let gx = 0; gx < TEXTURE_GRID_SIZE; gx++) {
      const x0 = Math.floor((gx * width) / TEXTURE_GRID_SIZE);
      const x1 = Math.floor(((gx + 1) * width) / TEXTURE_GRID_SIZE);
      const y0 = Math.floor((gy * height) / TEXTURE_GRID_SIZE);
      const y1 = Math.floor(((gy + 1) * height) / TEXTURE_GRID_SIZE);
      let sum = 0;
      let sumSq = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = y * width + x;
          if (mask[idx] === 0) continue;
          const v = gray[idx]!;
          sum += v;
          sumSq += v * v;
          count += 1;
        }
      }
      const out = (gy * TEXTURE_GRID_SIZE + gx) * 2;
      if (count > 0) {
        const mean = sum / count;
        const variance = Math.max(0, sumSq / count - mean * mean);
        values[out] = mean;
        values[out + 1] = Math.sqrt(variance);
        populated += 1;
      }
    }
  }
  return populated >= TEXTURE_GRID_SIZE ? values : null;
}

function textureSignatureAt(
  frame: GrayFrame,
  template: SurfaceTemplate,
  x0: number,
  y0: number,
  scale: number,
  stride: number,
): Float32Array | null {
  const sums = new Float64Array(TEXTURE_GRID_SIZE * TEXTURE_GRID_SIZE);
  const sumsSq = new Float64Array(TEXTURE_GRID_SIZE * TEXTURE_GRID_SIZE);
  const counts = new Uint16Array(TEXTURE_GRID_SIZE * TEXTURE_GRID_SIZE);
  for (let ty = 0; ty < template.height; ty += stride) {
    const cellY = Math.min(
      TEXTURE_GRID_SIZE - 1,
      Math.floor((ty / template.height) * TEXTURE_GRID_SIZE),
    );
    for (let tx = 0; tx < template.width; tx += stride) {
      const idx = ty * template.width + tx;
      if (template.mask[idx] === 0) continue;
      const fx = x0 + Math.round(tx * scale);
      const fy = y0 + Math.round(ty * scale);
      if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) continue;
      const cellX = Math.min(
        TEXTURE_GRID_SIZE - 1,
        Math.floor((tx / template.width) * TEXTURE_GRID_SIZE),
      );
      const cell = cellY * TEXTURE_GRID_SIZE + cellX;
      const v = frame.buffer[fy * frame.width + fx]!;
      sums[cell] = sums[cell]! + v;
      sumsSq[cell] = sumsSq[cell]! + v * v;
      counts[cell] = counts[cell]! + 1;
    }
  }

  const values = new Float32Array(TEXTURE_GRID_SIZE * TEXTURE_GRID_SIZE * 2);
  let populated = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i]!;
    if (count === 0) continue;
    const mean = sums[i]! / count;
    const variance = Math.max(0, sumsSq[i]! / count - mean * mean);
    values[i * 2] = mean;
    values[i * 2 + 1] = Math.sqrt(variance);
    populated += 1;
  }
  return populated >= TEXTURE_GRID_SIZE ? values : null;
}

function signatureSimilarity(a: Float32Array, b: Float32Array, maxRmsDistance: number): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < length; i++) {
    const d = a[i]! - b[i]!;
    sumSq += d * d;
  }
  return clamp01(1 - Math.sqrt(sumSq / length) / Math.max(1, maxRmsDistance));
}

function selectModelCircle(
  gray: Uint8Array,
  rgb: Uint8Array | undefined,
  mask: Uint8Array,
  width: number,
  height: number,
  relativePingPoint: Point2,
): CircleShape | null {
  const candidates = findCircleCandidates(gray, rgb, mask, width, height);
  let best: (CircleCandidate & { relativePoint: Point2; modelScore: number }) | null = null;
  for (const candidate of candidates) {
    const dx = relativePingPoint.x - candidate.x;
    const dy = relativePingPoint.y - candidate.y;
    const normalizedDistance = Math.hypot(dx, dy) / Math.max(1, candidate.radius);
    if (normalizedDistance > 1.45) continue;
    const proximity = 1 - clamp(normalizedDistance / 1.45, 0, 1);
    const modelScore = clamp01(0.74 * candidate.score + 0.26 * proximity);
    if (best === null || modelScore > best.modelScore) {
      best = {
        ...candidate,
        relativePoint: {
          x: dx / Math.max(1, candidate.radius),
          y: dy / Math.max(1, candidate.radius),
        },
        modelScore,
      };
    }
  }
  if (best === null || best.modelScore < 0.42) return null;
  return {
    centerX: best.x,
    centerY: best.y,
    radius: best.radius,
    relativePingPoint: best.relativePoint,
    score: best.modelScore,
    colorScore: best.colorScore,
  };
}

function findCircleCandidates(
  gray: Uint8Array,
  rgb: Uint8Array | undefined,
  mask: Uint8Array,
  width: number,
  height: number,
): CircleCandidate[] {
  const stats = grayStats(gray, mask);
  const threshold = Math.max(stats.mean + stats.std * 0.55, stats.mean + 18);
  const binary = new Uint8Array(width * height);
  let active = 0;
  for (let i = 0; i < binary.length; i++) {
    if (mask[i] === 0) continue;
    const gold = rgb ? goldLikeAt(rgb, i) : false;
    const bright = gray[i]! >= threshold;
    if (gold || bright) {
      binary[i] = 1;
      active += 1;
    }
  }
  if (active < MIN_CIRCLE_AREA) return [];

  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const candidates: CircleCandidate[] = [];
  for (let start = 0; start < binary.length; start++) {
    if (binary[start] === 0 || visited[start] !== 0) continue;
    let count = 0;
    let goldCount = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    while (top > 0) {
      const idx = stack[--top]!;
      const x = idx % width;
      const y = Math.floor(idx / width);
      count += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (rgb && goldLikeAt(rgb, idx)) goldCount += 1;

      if (x > 0) top = pushIfActive(binary, visited, stack, top, idx - 1);
      if (x + 1 < width) top = pushIfActive(binary, visited, stack, top, idx + 1);
      if (y > 0) top = pushIfActive(binary, visited, stack, top, idx - width);
      if (y + 1 < height) top = pushIfActive(binary, visited, stack, top, idx + width);
    }
    if (count < MIN_CIRCLE_AREA) continue;
    const cx = sumX / count;
    const cy = sumY / count;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 7 || bboxH < 7) continue;
    const aspectScore = 1 - clamp(Math.abs(bboxW - bboxH) / Math.max(bboxW, bboxH), 0, 1);
    if (aspectScore < 0.45) continue;

    let moment = 0;
    let perimeter = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const idx = y * width + x;
        if (binary[idx] === 0 || visited[idx] === 0) continue;
        const dx = x - cx;
        const dy = y - cy;
        moment += dx * dx + dy * dy;
        if (
          x === 0 ||
          y === 0 ||
          x + 1 === width ||
          y + 1 === height ||
          binary[idx - 1] === 0 ||
          binary[idx + 1] === 0 ||
          binary[idx - width] === 0 ||
          binary[idx + width] === 0
        ) {
          perimeter += 1;
        }
      }
    }

    const bboxRadius = (bboxW + bboxH) / 4;
    const areaRadius = Math.sqrt(count / Math.PI);
    const momentRadius = Math.sqrt(Math.max(1, (2 * moment) / count));
    const radius = clamp(
      0.45 * bboxRadius + 0.35 * areaRadius + 0.2 * momentRadius,
      4,
      Math.max(width, height),
    );
    const idealArea = Math.PI * radius * radius;
    const fillScore = 1 - clamp(Math.abs(count - idealArea) / Math.max(idealArea, count), 0, 1);
    const circularity =
      perimeter > 0 ? clamp((4 * Math.PI * count) / (perimeter * perimeter), 0, 1) : 0;
    const ringContrast = circleContrast(gray, mask, width, height, cx, cy, radius);
    const colorScore = rgb ? goldCount / count : 0;
    const score = clamp01(
      0.28 * aspectScore +
        0.2 * fillScore +
        0.2 * circularity +
        0.18 * ringContrast +
        0.14 * colorScore,
    );
    if (score < 0.3) continue;
    candidates.push({ x: cx, y: cy, radius, score, colorScore, area: count });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_CIRCLE_CANDIDATES);
}

function pushIfActive(
  binary: Uint8Array,
  visited: Uint8Array,
  stack: Int32Array,
  top: number,
  idx: number,
): number {
  if (binary[idx] === 0 || visited[idx] !== 0) return top;
  visited[idx] = 1;
  stack[top] = idx;
  return top + 1;
}

function circleContrast(
  gray: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
): number {
  let innerSum = 0;
  let innerCount = 0;
  let ringSum = 0;
  let ringCount = 0;
  const x0 = clamp(Math.floor(cx - radius * 1.7), 0, width - 1);
  const y0 = clamp(Math.floor(cy - radius * 1.7), 0, height - 1);
  const x1 = clamp(Math.ceil(cx + radius * 1.7), 0, width - 1);
  const y1 = clamp(Math.ceil(cy + radius * 1.7), 0, height - 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = y * width + x;
      if (mask[idx] === 0) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius * 0.75) {
        innerSum += gray[idx]!;
        innerCount += 1;
      } else if (d >= radius * 1.15 && d <= radius * 1.6) {
        ringSum += gray[idx]!;
        ringCount += 1;
      }
    }
  }
  if (innerCount < 8 || ringCount < 8) return 0;
  return clamp(Math.abs(innerSum / innerCount - ringSum / ringCount) / 90, 0, 1);
}

function colorHistogramForRegion(rgb: Uint8Array, mask: Uint8Array): Float32Array {
  const hist = new Float32Array(COLOR_HISTOGRAM_BINS);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) continue;
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    addRgbBins(hist, r, g, b);
    count += 1;
  }
  if (count > 0) {
    for (let i = 0; i < hist.length; i++) hist[i] = hist[i]! / (count * 3);
  }
  return hist;
}

function colorHistogramForPatch(
  rgb: Uint8Array | undefined,
  srcWidth: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  mask: Uint8Array,
): Float32Array | null {
  if (!rgb) return null;
  const hist = new Float32Array(COLOR_HISTOGRAM_BINS);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskIdx = y * width + x;
      if (mask[maskIdx] === 0) continue;
      const rgbIdx = ((y0 + y) * srcWidth + x0 + x) * 3;
      addRgbBins(hist, rgb[rgbIdx]!, rgb[rgbIdx + 1]!, rgb[rgbIdx + 2]!);
      count += 1;
    }
  }
  if (count < MIN_TEMPLATE_VALID_PIXELS) return null;
  for (let i = 0; i < hist.length; i++) hist[i] = hist[i]! / (count * 3);
  return hist;
}

function colorHistogramAtTemplate(
  frame: GrayFrame,
  template: SurfaceTemplate,
  x0: number,
  y0: number,
  scale: number,
  stride: number,
): Float32Array | null {
  const rgb = frame.rgbBuffer;
  if (!template.colorHistogram || !rgb || rgb.length < frame.width * frame.height * 3) return null;
  const hist = new Float32Array(COLOR_HISTOGRAM_BINS);
  let count = 0;
  for (let ty = 0; ty < template.height; ty += stride) {
    for (let tx = 0; tx < template.width; tx += stride) {
      const templateIdx = ty * template.width + tx;
      if (template.mask[templateIdx] === 0) continue;
      const fx = x0 + Math.round(tx * scale);
      const fy = y0 + Math.round(ty * scale);
      if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) continue;
      const rgbIdx = (fy * frame.width + fx) * 3;
      addRgbBins(hist, rgb[rgbIdx]!, rgb[rgbIdx + 1]!, rgb[rgbIdx + 2]!);
      count += 1;
    }
  }
  if (count < 40) return null;
  for (let i = 0; i < hist.length; i++) hist[i] = hist[i]! / (count * 3);
  return hist;
}

function addRgbBins(hist: Float32Array, r: number, g: number, b: number): void {
  hist[Math.min(3, Math.floor(r / 64))] = hist[Math.min(3, Math.floor(r / 64))]! + 1;
  hist[4 + Math.min(3, Math.floor(g / 64))] = hist[4 + Math.min(3, Math.floor(g / 64))]! + 1;
  hist[8 + Math.min(3, Math.floor(b / 64))] = hist[8 + Math.min(3, Math.floor(b / 64))]! + 1;
}

function histogramIntersection(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += Math.min(a[i]!, b[i]!);
  return clamp01(sum);
}

function goldLikeAt(rgb: Uint8Array, pixelIndex: number): boolean {
  const c0 = rgb[pixelIndex * 3]!;
  const c1 = rgb[pixelIndex * 3 + 1]!;
  const c2 = rgb[pixelIndex * 3 + 2]!;
  return isGoldRgb(c0, c1, c2) || isGoldRgb(c2, c1, c0);
}

function isGoldRgb(r: number, g: number, b: number): boolean {
  return r >= 145 && g >= 95 && b <= 135 && r >= g * 0.9 && g >= b * 1.15 && r - b >= 45;
}

function grayStats(gray: Uint8Array, mask: Uint8Array): { mean: number; std: number } {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < gray.length; i++) {
    if (mask[i] === 0) continue;
    sum += gray[i]!;
    count += 1;
  }
  const mean = count > 0 ? sum / count : 0;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) {
    if (mask[i] === 0) continue;
    const d = gray[i]! - mean;
    variance += d * d;
  }
  return { mean, std: count > 0 ? Math.sqrt(variance / count) : 0 };
}

function sobelEdges(gray: Uint8Array, width: number, height: number, mask: Uint8Array): Uint8Array {
  const edge = new Uint8Array(width * height);
  for (let y = 1; y + 1 < height; y++) {
    for (let x = 1; x + 1 < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 0) continue;
      const gx =
        -gray[idx - width - 1]! -
        2 * gray[idx - 1]! -
        gray[idx + width - 1]! +
        gray[idx - width + 1]! +
        2 * gray[idx + 1]! +
        gray[idx + width + 1]!;
      const gy =
        -gray[idx - width - 1]! -
        2 * gray[idx - width]! -
        gray[idx - width + 1]! +
        gray[idx + width - 1]! +
        2 * gray[idx + width]! +
        gray[idx + width + 1]!;
      edge[idx] = Math.min(255, Math.round(Math.hypot(gx, gy) / 4));
    }
  }
  return edge;
}

function buildSurfaceMask(
  roi: Roi,
  frame: GrayFrame,
  bounds: Bounds,
  maskRegions: NormalizedRect[],
  pingInRoi: Point2,
): Uint8Array {
  const mask = new Uint8Array(roi.width * roi.height).fill(1);
  for (const r of maskRegions) {
    const x0 = Math.round(r.x * frame.width) - roi.x;
    const y0 = Math.round(r.y * frame.height) - roi.y;
    const x1 = Math.round((r.x + r.w) * frame.width) - roi.x;
    const y1 = Math.round((r.y + r.h) * frame.height) - roi.y;
    fillMaskRect(mask, roi.width, roi.height, x0, y0, x1 - x0, y1 - y0, 0);
  }
  maskOverlayMarker(mask, roi.width, roi.height, pingInRoi, frame, bounds);
  return mask;
}

function maskOverlayMarker(
  mask: Uint8Array,
  width: number,
  height: number,
  tip: Point2,
  frame: GrayFrame,
  bounds: Bounds,
): void {
  const scale = Math.min(frame.width / bounds.width, frame.height / bounds.height);
  const markerW = PIN_MARKER_MASK_WIDTH_SCREEN_PX * scale;
  const markerH = PIN_MARKER_MASK_HEIGHT_SCREEN_PX * scale;
  const belowTip = PIN_MARKER_MASK_BELOW_TIP_SCREEN_PX * scale;
  const flipped = tip.y - markerH < 0;
  const x = tip.x - markerW / 2;
  const y = flipped ? tip.y - belowTip : tip.y - markerH;
  const h = markerH + belowTip;
  fillMaskRect(mask, width, height, x, y, markerW, h, 0);
}

function fillMaskRect(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
): void {
  const x0 = clamp(Math.floor(x), 0, width);
  const y0 = clamp(Math.floor(y), 0, height);
  const x1 = clamp(Math.ceil(x + w), 0, width);
  const y1 = clamp(Math.ceil(y + h), 0, height);
  for (let py = y0; py < y1; py++) {
    mask.fill(value, py * width + x0, py * width + x1);
  }
}

function copyGrayRegion(buffer: Uint8Array, frameWidth: number, roi: Roi): Uint8Array {
  const out = new Uint8Array(roi.width * roi.height);
  for (let y = 0; y < roi.height; y++) {
    const srcStart = (roi.y + y) * frameWidth + roi.x;
    out.set(buffer.subarray(srcStart, srcStart + roi.width), y * roi.width);
  }
  return out;
}

function copyRgbRegion(frame: GrayFrame, roi: Roi): Uint8Array | undefined {
  const rgb = frame.rgbBuffer;
  if (rgb && rgb.length >= frame.width * frame.height * 3) {
    const out = new Uint8Array(roi.width * roi.height * 3);
    for (let y = 0; y < roi.height; y++) {
      const srcStart = ((roi.y + y) * frame.width + roi.x) * 3;
      out.set(rgb.subarray(srcStart, srcStart + roi.width * 3), y * roi.width * 3);
    }
    return out;
  }
  const rgba = frame.rgbaBuffer;
  if (rgba && rgba.length >= frame.width * frame.height * 4) {
    const out = new Uint8Array(roi.width * roi.height * 3);
    for (let y = 0; y < roi.height; y++) {
      for (let x = 0; x < roi.width; x++) {
        const src = ((roi.y + y) * frame.width + roi.x + x) * 4;
        const dst = (y * roi.width + x) * 3;
        out[dst] = rgba[src]!;
        out[dst + 1] = rgba[src + 1]!;
        out[dst + 2] = rgba[src + 2]!;
      }
    }
    return out;
  }
  return undefined;
}

function maskTo255(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] === 0 ? 0 : 255;
  return out;
}

function roiAround(
  cx: number,
  cy: number,
  radius: number,
  frameWidth: number,
  frameHeight: number,
): Roi {
  const x0 = clamp(Math.round(cx - radius), 0, frameWidth);
  const y0 = clamp(Math.round(cy - radius), 0, frameHeight);
  const x1 = clamp(Math.round(cx + radius), 0, frameWidth);
  const y1 = clamp(Math.round(cy + radius), 0, frameHeight);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function cvReady(cv: SurfaceCvApi | null): cv is SurfaceCvApi {
  return (
    typeof cv?.matFromArray === 'function' &&
    typeof cv?.ORB === 'function' &&
    typeof cv?.BFMatcher === 'function' &&
    typeof cv?.KeyPointVector === 'function' &&
    typeof cv?.DMatchVectorVector === 'function' &&
    typeof cv?.findHomography === 'function' &&
    typeof cv?.CV_8UC1 === 'number' &&
    typeof cv?.CV_32FC2 === 'number'
  );
}

function usableFrame(frame: GrayFrame): boolean {
  return (
    frame.width >= MIN_ROI_SIZE_PX &&
    frame.height >= MIN_ROI_SIZE_PX &&
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

function distance(
  a: { screenX: number; screenY: number },
  b: { screenX: number; screenY: number },
): number {
  return Math.hypot(a.screenX - b.screenX, a.screenY - b.screenY);
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

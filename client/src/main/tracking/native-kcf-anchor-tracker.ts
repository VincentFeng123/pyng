import type { NormalizedRect } from '@pyng/shared';
import type { GrayFrame } from './capture-loop.js';
import { getNativeOpenCv } from './native-opencv.js';
import type { PingProjection } from './ping-tracker.js';
import type { SurfaceTrackerResult } from './surface-tracking-types.js';

export type NativeKcfAnchorTrackerOptions = {
  patchSizeFramePx?: number;
  searchSizeFramePx?: number;
  agreementPx?: number;
  _cv?: NativeKcfCv | null;
};

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

type NativeKcfCv = {
  CV_8UC1: number;
  TM_CCOEFF_NORMED: number;
  Mat: new (rows?: number, cols?: number, type?: number, data?: Buffer) => NativeMat;
  Rect: new (x: number, y: number, width: number, height: number) => NativeRect;
  TrackerKCF: new () => NativeTrackerKcf;
};

type NativeMat = {
  rows: number;
  cols: number;
  getRegion(rect: NativeRect): NativeMat;
  matchTemplate(template: NativeMat, method: number, mask?: NativeMat): NativeMat;
  minMaxLoc(): { minVal: number; maxVal: number; minLoc: Point2; maxLoc: Point2 };
  delete?: () => void;
};

type NativeRect = Roi;

type NativeTrackerKcf = {
  init(frame: NativeMat, boundingBox: NativeRect): boolean;
  update(frame: NativeMat): NativeRect;
  clear?: () => void;
};

type ColorHistogram = {
  bins: Float32Array;
  peak: number;
};

type NativeKcfTrack = {
  id: string;
  tracker: NativeTrackerKcf;
  template: Buffer;
  templateWidth: number;
  templateHeight: number;
  histogram: ColorHistogram | null;
  lastFrameX: number;
  lastFrameY: number;
  lastPredictedFrameX: number;
  lastPredictedFrameY: number;
  confidence: number;
  lostFrames: number;
};

type TemplateObservation = {
  x: number;
  y: number;
  score: number;
};

type HistogramObservation = {
  x: number;
  y: number;
  score: number;
};

type ShapeObservation = {
  x: number;
  y: number;
  score: number;
  radiusPx: number;
};

const DEFAULT_PATCH_SIZE_FRAME_PX = 64;
const DEFAULT_SEARCH_SIZE_FRAME_PX = 256;
const DEFAULT_AGREEMENT_PX = 10;
const MIN_PATCH_SIZE_PX = 24;
const TEMPLATE_ACCEPT_SCORE = 0.5;
const TEMPLATE_REACQUIRE_SCORE = 0.72;
const HISTOGRAM_REACQUIRE_SCORE = 0.62;
const HISTOGRAM_ACCEPT_SCORE = 0.45;
const SHAPE_REACQUIRE_SCORE = 0.64;
const SHAPE_ACCEPT_SCORE = 0.48;
const MAX_LOW_CONFIDENCE_FRAMES = 3;
const HIST_H_BINS = 16;
const HIST_S_BINS = 8;
const HIST_SAMPLE_STEP = 2;
const SHAPE_SCORE_THRESHOLD = 0.56;

export class NativeKcfAnchorTracker {
  private readonly patchSizeFramePx: number;
  private readonly searchSizeFramePx: number;
  private readonly agreementPx: number;
  private readonly cv: NativeKcfCv | null;
  private tracks = new Map<string, NativeKcfTrack>();

  constructor(options: NativeKcfAnchorTrackerOptions = {}) {
    this.patchSizeFramePx = Math.max(
      MIN_PATCH_SIZE_PX,
      Math.round(options.patchSizeFramePx ?? DEFAULT_PATCH_SIZE_FRAME_PX),
    );
    this.searchSizeFramePx = Math.max(
      this.patchSizeFramePx * 2,
      Math.round(options.searchSizeFramePx ?? DEFAULT_SEARCH_SIZE_FRAME_PX),
    );
    this.agreementPx = Math.max(4, Math.round(options.agreementPx ?? DEFAULT_AGREEMENT_PX));
    this.cv = options._cv ?? (getNativeOpenCv() as NativeKcfCv | null);
  }

  reset(): void {
    for (const track of this.tracks.values()) {
      clearTracker(track.tracker);
    }
    this.tracks.clear();
  }

  update(
    prevFrame: GrayFrame | null,
    frame: GrayFrame,
    projections: PingProjection[],
    bounds: Bounds,
    maskRegions: NormalizedRect[],
    observedAtNs: number,
  ): SurfaceTrackerResult[] {
    if (!cvReady(this.cv) || !usableFrame(frame) || bounds.width <= 0 || bounds.height <= 0) {
      this.reset();
      return [];
    }

    const liveIds = new Set(projections.map((p) => p.id));
    for (const [id, track] of this.tracks) {
      if (!liveIds.has(id)) {
        clearTracker(track.tracker);
        this.tracks.delete(id);
      }
    }

    const scaleX = frame.width / bounds.width;
    const scaleY = frame.height / bounds.height;
    const observations: SurfaceTrackerResult[] = [];
    const frameMat = new this.cv.Mat(frame.height, frame.width, this.cv.CV_8UC1, frame.buffer);
    try {
      for (const projection of projections) {
        if (projection.isEdgeArrow) continue;
        const predictedFrameX = projection.screenX * scaleX;
        const predictedFrameY = projection.screenY * scaleY;
        if (isMasked(predictedFrameX, predictedFrameY, frame, maskRegions)) continue;

        const track = this.tracks.get(projection.id);
        if (!track) {
          const initialized = this.initTrack(
            projection.id,
            frame,
            frameMat,
            predictedFrameX,
            predictedFrameY,
          );
          if (initialized) this.tracks.set(projection.id, initialized);
          continue;
        }

        const observation = this.updateTrack(
          prevFrame,
          frame,
          frameMat,
          track,
          predictedFrameX,
          predictedFrameY,
          scaleX,
          scaleY,
          maskRegions,
          observedAtNs,
        );
        if (observation !== null) observations.push(observation);
      }
    } finally {
      deleteMat(frameMat);
    }

    return observations;
  }

  private initTrack(
    id: string,
    frame: GrayFrame,
    frameMat: NativeMat,
    centerX: number,
    centerY: number,
  ): NativeKcfTrack | null {
    if (this.cv === null) return null;
    const patch = squareAround(centerX, centerY, this.patchSizeFramePx, frame.width, frame.height);
    if (patch.width < MIN_PATCH_SIZE_PX || patch.height < MIN_PATCH_SIZE_PX) return null;

    const patchMat = frameMat.getRegion(
      new this.cv.Rect(patch.x, patch.y, patch.width, patch.height),
    );
    const tracker = new this.cv.TrackerKCF();
    try {
      const ok = tracker.init(patchMat, new this.cv.Rect(0, 0, patch.width, patch.height));
      if (!ok) {
        clearTracker(tracker);
        return null;
      }
      return {
        id,
        tracker,
        template: copyGrayRegion(frame, patch),
        templateWidth: patch.width,
        templateHeight: patch.height,
        histogram: buildColorHistogram(frame, patch),
        lastFrameX: patch.x + patch.width / 2,
        lastFrameY: patch.y + patch.height / 2,
        lastPredictedFrameX: centerX,
        lastPredictedFrameY: centerY,
        confidence: 0.35,
        lostFrames: 0,
      };
    } finally {
      deleteMat(patchMat);
    }
  }

  private updateTrack(
    prevFrame: GrayFrame | null,
    frame: GrayFrame,
    frameMat: NativeMat,
    track: NativeKcfTrack,
    predictedFrameX: number,
    predictedFrameY: number,
    scaleX: number,
    scaleY: number,
    maskRegions: NormalizedRect[],
    observedAtNs: number,
  ): SurfaceTrackerResult | null {
    if (this.cv === null) return null;
    const search = squareAround(
      predictedFrameX,
      predictedFrameY,
      this.searchSizeFramePx,
      frame.width,
      frame.height,
    );
    if (search.width < track.templateWidth || search.height < track.templateHeight) return null;

    const searchMat = frameMat.getRegion(
      new this.cv.Rect(search.x, search.y, search.width, search.height),
    );
    try {
      const kcf = this.runKcf(prevFrame, track, searchMat, search);
      const template = this.runTemplateMatch(track, searchMat, search);
      const histogram = histogramPeak(frame, track.histogram, search);
      const shape = colorShapePeak(frame, track.histogram, search, {
        x: predictedFrameX,
        y: predictedFrameY,
      });
      const accepted = chooseObservation({
        kcf,
        template,
        histogram,
        shape,
        predicted: { x: predictedFrameX, y: predictedFrameY },
        agreementPx: this.agreementPx,
        searchSizeFramePx: this.searchSizeFramePx,
      });

      if (
        accepted === null ||
        isMasked(accepted.x, accepted.y, frame, maskRegions) ||
        !pointInFrame(accepted.x, accepted.y, frame)
      ) {
        track.lostFrames += 1;
        track.confidence *= 0.58;
        if (track.lostFrames >= MAX_LOW_CONFIDENCE_FRAMES) {
          const reacquired = histogram ?? template;
          if (
            reacquired !== null &&
            distance(reacquired, { x: predictedFrameX, y: predictedFrameY }) <=
              this.searchSizeFramePx / 4
          ) {
            this.reinitTrack(frame, frameMat, track, reacquired.x, reacquired.y);
          }
        }
        track.lastPredictedFrameX = predictedFrameX;
        track.lastPredictedFrameY = predictedFrameY;
        return null;
      }

      if (accepted.shouldReinit) {
        this.reinitTrack(frame, frameMat, track, accepted.x, accepted.y);
      }

      track.lastFrameX = accepted.x;
      track.lastFrameY = accepted.y;
      track.lastPredictedFrameX = predictedFrameX;
      track.lastPredictedFrameY = predictedFrameY;
      track.lostFrames = 0;
      track.confidence = clamp01(
        Math.max(0.45 * track.confidence + 0.55 * accepted.confidence, accepted.confidence * 0.85),
      );

      return {
        id: track.id,
        screenX: accepted.x / scaleX,
        screenY: accepted.y / scaleY,
        confidence: track.confidence,
        observedAtNs,
        inlierCount: accepted.agreementCount,
        trackedPointCount: 1,
        residualPx: accepted.residualPx,
        trackingMethod: 'kcf',
        surfaceConfidence: track.confidence,
        surfaceLockKind: accepted.lockKind ?? (track.histogram === null ? 'template' : 'unknown'),
      };
    } finally {
      deleteMat(searchMat);
    }
  }

  private runKcf(
    prevFrame: GrayFrame | null,
    track: NativeKcfTrack,
    searchMat: NativeMat,
    search: Roi,
  ): (Point2 & { width: number; height: number }) | null {
    if (this.cv !== null && prevFrame !== null && usableFrame(prevFrame)) {
      const windowed = this.runWindowedKcf(prevFrame, track, searchMat, search);
      if (windowed !== null) return windowed;
    }

    try {
      const rect = track.tracker.update(searchMat);
      if (!validRect(rect, search.width, search.height)) return null;
      return {
        x: search.x + rect.x + rect.width / 2,
        y: search.y + rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
      };
    } catch {
      return null;
    }
  }

  private runWindowedKcf(
    prevFrame: GrayFrame,
    track: NativeKcfTrack,
    searchMat: NativeMat,
    search: Roi,
  ): (Point2 & { width: number; height: number }) | null {
    if (this.cv === null) return null;

    const prevSearch = squareAround(
      track.lastPredictedFrameX,
      track.lastPredictedFrameY,
      this.searchSizeFramePx,
      prevFrame.width,
      prevFrame.height,
    );
    if (prevSearch.width < track.templateWidth || prevSearch.height < track.templateHeight) {
      return null;
    }

    const bbox = rectAroundCenter(
      track.lastFrameX - prevSearch.x,
      track.lastFrameY - prevSearch.y,
      track.templateWidth,
      track.templateHeight,
      prevSearch.width,
      prevSearch.height,
    );
    if (bbox === null) return null;

    const prevFrameMat = new this.cv.Mat(
      prevFrame.height,
      prevFrame.width,
      this.cv.CV_8UC1,
      prevFrame.buffer,
    );
    const prevSearchMat = prevFrameMat.getRegion(
      new this.cv.Rect(prevSearch.x, prevSearch.y, prevSearch.width, prevSearch.height),
    );
    const tracker = new this.cv.TrackerKCF();
    try {
      if (!tracker.init(prevSearchMat, new this.cv.Rect(bbox.x, bbox.y, bbox.width, bbox.height))) {
        return null;
      }
      const rect = tracker.update(searchMat);
      if (!validRect(rect, search.width, search.height)) return null;
      return {
        x: search.x + rect.x + rect.width / 2,
        y: search.y + rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
      };
    } catch {
      return null;
    } finally {
      clearTracker(tracker);
      deleteMat(prevSearchMat);
      deleteMat(prevFrameMat);
    }
  }

  private runTemplateMatch(
    track: NativeKcfTrack,
    searchMat: NativeMat,
    search: Roi,
  ): TemplateObservation | null {
    if (this.cv === null) return null;
    const templateMat = new this.cv.Mat(
      track.templateHeight,
      track.templateWidth,
      this.cv.CV_8UC1,
      track.template,
    );
    let result: NativeMat | null = null;
    try {
      result = searchMat.matchTemplate(templateMat, this.cv.TM_CCOEFF_NORMED);
      const { maxVal, maxLoc } = result.minMaxLoc();
      if (!Number.isFinite(maxVal)) return null;
      return {
        x: search.x + maxLoc.x + track.templateWidth / 2,
        y: search.y + maxLoc.y + track.templateHeight / 2,
        score: clamp01(maxVal),
      };
    } catch {
      return null;
    } finally {
      if (result !== null) deleteMat(result);
      deleteMat(templateMat);
    }
  }

  private reinitTrack(
    frame: GrayFrame,
    frameMat: NativeMat,
    track: NativeKcfTrack,
    centerX: number,
    centerY: number,
  ): void {
    const fresh = this.initTrack(track.id, frame, frameMat, centerX, centerY);
    if (fresh === null) return;
    clearTracker(track.tracker);
    track.tracker = fresh.tracker;
    track.template = fresh.template;
    track.templateWidth = fresh.templateWidth;
    track.templateHeight = fresh.templateHeight;
    track.histogram = fresh.histogram;
    track.lastFrameX = fresh.lastFrameX;
    track.lastFrameY = fresh.lastFrameY;
    track.lastPredictedFrameX = fresh.lastPredictedFrameX;
    track.lastPredictedFrameY = fresh.lastPredictedFrameY;
    track.confidence = Math.max(track.confidence, 0.42);
    track.lostFrames = 0;
  }
}

function chooseObservation(input: {
  kcf: Point2 | null;
  template: TemplateObservation | null;
  histogram: HistogramObservation | null;
  shape: ShapeObservation | null;
  predicted: Point2;
  agreementPx: number;
  searchSizeFramePx: number;
}):
  | (Point2 & {
      confidence: number;
      residualPx: number;
      agreementCount: number;
      shouldReinit: boolean;
      lockKind?: 'circle' | 'template' | 'unknown';
    })
  | null {
  const { kcf, template, histogram, shape, predicted, agreementPx, searchSizeFramePx } = input;
  const kcfTemplateAgree =
    kcf !== null &&
    template !== null &&
    template.score >= TEMPLATE_ACCEPT_SCORE &&
    distance(kcf, template) <= agreementPx;
  const kcfHistogramAgree =
    kcf !== null &&
    histogram !== null &&
    histogram.score >= HISTOGRAM_ACCEPT_SCORE &&
    distance(kcf, histogram) <= agreementPx;
  const kcfShapeAgree =
    kcf !== null &&
    shape !== null &&
    shape.score >= SHAPE_ACCEPT_SCORE &&
    distance(kcf, shape) <= Math.max(agreementPx * 1.5, 14);

  if (kcfTemplateAgree || kcfHistogramAgree) {
    const agreeWith = kcfTemplateAgree ? template! : histogram!;
    const residualPx = distance(kcf!, agreeWith);
    const confidence = clamp01(
      0.58 +
        0.26 * (template?.score ?? 0) +
        0.16 * (histogram?.score ?? 0) -
        residualPx / Math.max(80, agreementPx * 12),
    );
    return {
      x: (kcf!.x + agreeWith.x) / 2,
      y: (kcf!.y + agreeWith.y) / 2,
      confidence,
      residualPx,
      agreementCount: kcfTemplateAgree && kcfHistogramAgree ? 3 : 2,
      shouldReinit: false,
      lockKind: kcfTemplateAgree ? 'template' : 'unknown',
    };
  }

  if (kcfShapeAgree) {
    const residualPx = distance(kcf!, shape!);
    return {
      x: (kcf!.x + shape!.x) / 2,
      y: (kcf!.y + shape!.y) / 2,
      confidence: clamp01(0.54 + 0.34 * shape!.score - residualPx / Math.max(80, agreementPx * 12)),
      residualPx,
      agreementCount: 2,
      shouldReinit: false,
      lockKind: 'circle',
    };
  }

  if (
    template !== null &&
    shape !== null &&
    template.score >= TEMPLATE_ACCEPT_SCORE &&
    shape.score >= SHAPE_ACCEPT_SCORE &&
    distance(template, shape) <= Math.max(agreementPx * 1.8, 18)
  ) {
    const residualPx = distance(template, shape);
    return {
      x: (template.x + shape.x) / 2,
      y: (template.y + shape.y) / 2,
      confidence: clamp01(0.46 + 0.28 * template.score + 0.26 * shape.score),
      residualPx,
      agreementCount: 2,
      shouldReinit: true,
      lockKind: 'circle',
    };
  }

  if (
    template !== null &&
    template.score >= TEMPLATE_REACQUIRE_SCORE &&
    distance(template, predicted) <= searchSizeFramePx / 4
  ) {
    return {
      x: template.x,
      y: template.y,
      confidence: clamp01(0.32 + 0.42 * template.score),
      residualPx: distance(template, predicted),
      agreementCount: 1,
      shouldReinit: true,
      lockKind: 'template',
    };
  }

  if (
    shape !== null &&
    shape.score >= SHAPE_REACQUIRE_SCORE &&
    distance(shape, predicted) <= searchSizeFramePx / 3
  ) {
    return {
      x: shape.x,
      y: shape.y,
      confidence: clamp01(0.36 + 0.44 * shape.score),
      residualPx: distance(shape, predicted),
      agreementCount: 1,
      shouldReinit: true,
      lockKind: 'circle',
    };
  }

  if (
    histogram !== null &&
    histogram.score >= HISTOGRAM_REACQUIRE_SCORE &&
    distance(histogram, predicted) <= searchSizeFramePx / 4
  ) {
    return {
      x: histogram.x,
      y: histogram.y,
      confidence: clamp01(0.28 + 0.38 * histogram.score),
      residualPx: distance(histogram, predicted),
      agreementCount: 1,
      shouldReinit: true,
      lockKind: 'unknown',
    };
  }

  if (
    kcf !== null &&
    template !== null &&
    template.score >= TEMPLATE_ACCEPT_SCORE &&
    distance(kcf, predicted) <= searchSizeFramePx / 2 &&
    distance(kcf, template) <= Math.max(agreementPx * 2, 18)
  ) {
    return {
      x: kcf.x,
      y: kcf.y,
      confidence: clamp01(0.28 + 0.45 * template.score),
      residualPx: distance(kcf, template),
      agreementCount: 1,
      shouldReinit: false,
    };
  }

  return null;
}

function buildColorHistogram(frame: GrayFrame, roi: Roi): ColorHistogram | null {
  const rgb = frame.rgbBuffer;
  if (!rgb || rgb.length < frame.width * frame.height * 3) return null;
  const bins = new Float32Array(HIST_H_BINS * HIST_S_BINS);
  let total = 0;
  for (let y = roi.y; y < roi.y + roi.height; y += HIST_SAMPLE_STEP) {
    for (let x = roi.x; x < roi.x + roi.width; x += HIST_SAMPLE_STEP) {
      const bin = hsvBinForPixel(rgb, frame.width, x, y);
      if (bin === null) continue;
      bins[bin] = (bins[bin] ?? 0) + 1;
      total += 1;
    }
  }
  if (total < 12) return null;
  let peak = 0;
  for (let i = 0; i < bins.length; i++) {
    bins[i] = (bins[i] ?? 0) / total;
    peak = Math.max(peak, bins[i]!);
  }
  if (peak <= 0) return null;
  return { bins, peak };
}

function histogramPeak(
  frame: GrayFrame,
  histogram: ColorHistogram | null,
  roi: Roi,
): HistogramObservation | null {
  const rgb = frame.rgbBuffer;
  if (histogram === null || !rgb || rgb.length < frame.width * frame.height * 3) return null;

  let best: Point2 | null = null;
  let bestScore = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightSum = 0;
  for (let y = roi.y; y < roi.y + roi.height; y += HIST_SAMPLE_STEP) {
    for (let x = roi.x; x < roi.x + roi.width; x += HIST_SAMPLE_STEP) {
      const bin = hsvBinForPixel(rgb, frame.width, x, y);
      if (bin === null) continue;
      const score = histogram.bins[bin]! / histogram.peak;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
      if (score >= HISTOGRAM_ACCEPT_SCORE) {
        weightedX += x * score;
        weightedY += y * score;
        weightSum += score;
      }
    }
  }
  if (best === null || bestScore < HISTOGRAM_ACCEPT_SCORE) return null;
  return {
    x: weightSum > 0 ? weightedX / weightSum : best.x,
    y: weightSum > 0 ? weightedY / weightSum : best.y,
    score: clamp01(bestScore),
  };
}

function colorShapePeak(
  frame: GrayFrame,
  histogram: ColorHistogram | null,
  roi: Roi,
  predicted: Point2,
): ShapeObservation | null {
  const rgb = frame.rgbBuffer;
  if (histogram === null || !rgb || rgb.length < frame.width * frame.height * 3) return null;

  let weightedX = 0;
  let weightedY = 0;
  let weightedXX = 0;
  let weightedYY = 0;
  let weightedXY = 0;
  let weightSum = 0;
  let bestScore = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const priorRadius = Math.max(1, Math.max(roi.width, roi.height) / 2);

  for (let y = roi.y; y < roi.y + roi.height; y += HIST_SAMPLE_STEP) {
    for (let x = roi.x; x < roi.x + roi.width; x += HIST_SAMPLE_STEP) {
      const bin = hsvBinForPixel(rgb, frame.width, x, y);
      if (bin === null) continue;
      const colorScore = histogram.bins[bin]! / histogram.peak;
      if (colorScore < SHAPE_SCORE_THRESHOLD) continue;

      const prior = 1 - 0.35 * clamp(distance({ x, y }, predicted) / priorRadius, 0, 1);
      const weight = colorScore * prior;
      weightedX += x * weight;
      weightedY += y * weight;
      weightedXX += x * x * weight;
      weightedYY += y * y * weight;
      weightedXY += x * y * weight;
      weightSum += weight;
      bestScore = Math.max(bestScore, colorScore);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (weightSum < 18) return null;

  const x = weightedX / weightSum;
  const y = weightedY / weightSum;
  const varianceX = Math.max(0, weightedXX / weightSum - x * x);
  const varianceY = Math.max(0, weightedYY / weightSum - y * y);
  const covariance = weightedXY / weightSum - x * y;
  const trace = varianceX + varianceY;
  if (trace <= 1e-6) return null;

  const determinant = Math.max(0, varianceX * varianceY - covariance * covariance);
  const spread = Math.sqrt(Math.max(0, trace * trace * 0.25 - determinant));
  const eigenA = trace * 0.5 + spread;
  const eigenB = trace * 0.5 - spread;
  const aspectScore = clamp(eigenB / Math.max(1, eigenA), 0, 1);
  const radiusPx = Math.sqrt(trace);
  if (radiusPx < 3 || radiusPx > Math.max(roi.width, roi.height) * 0.42) return null;

  const bboxWidth = Math.max(HIST_SAMPLE_STEP, maxX - minX + HIST_SAMPLE_STEP);
  const bboxHeight = Math.max(HIST_SAMPLE_STEP, maxY - minY + HIST_SAMPLE_STEP);
  const bboxAspectScore = Math.min(bboxWidth, bboxHeight) / Math.max(bboxWidth, bboxHeight);
  const massScore = clamp(weightSum / 180, 0, 1);
  const compactnessScore = clamp(
    1 - radiusPx / Math.max(1, Math.max(roi.width, roi.height) * 0.36),
    0,
    1,
  );
  const score = clamp01(
    0.28 * bestScore +
      0.24 * massScore +
      0.22 * aspectScore +
      0.16 * bboxAspectScore +
      0.1 * compactnessScore,
  );

  return score >= SHAPE_ACCEPT_SCORE ? { x, y, score, radiusPx } : null;
}

function hsvBinForPixel(rgb: Buffer, width: number, x: number, y: number): number | null {
  const i = (y * width + x) * 3;
  const r = rgb[i]!;
  const g = rgb[i + 1]!;
  const b = rgb[i + 2]!;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max < 32 || delta < 18) return null;
  const saturation = delta / max;
  if (saturation < 0.18) return null;

  let hue: number;
  if (delta === 0) {
    hue = 0;
  } else if (max === r) {
    hue = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    hue = ((b - r) / delta + 2) * 60;
  } else {
    hue = ((r - g) / delta + 4) * 60;
  }
  const hBin = clamp(Math.floor((hue / 360) * HIST_H_BINS), 0, HIST_H_BINS - 1);
  const sBin = clamp(Math.floor(saturation * HIST_S_BINS), 0, HIST_S_BINS - 1);
  return hBin * HIST_S_BINS + sBin;
}

function squareAround(cx: number, cy: number, size: number, width: number, height: number): Roi {
  const half = size / 2;
  const x0 = clamp(Math.round(cx - half), 0, width);
  const y0 = clamp(Math.round(cy - half), 0, height);
  const x1 = clamp(Math.round(cx + half), 0, width);
  const y1 = clamp(Math.round(cy + half), 0, height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function rectAroundCenter(
  cx: number,
  cy: number,
  width: number,
  height: number,
  boundsWidth: number,
  boundsHeight: number,
): Roi | null {
  if (width > boundsWidth || height > boundsHeight) return null;
  const x = clamp(Math.round(cx - width / 2), 0, boundsWidth - width);
  const y = clamp(Math.round(cy - height / 2), 0, boundsHeight - height);
  return { x, y, width, height };
}

function copyGrayRegion(frame: GrayFrame, roi: Roi): Buffer {
  const out = Buffer.allocUnsafe(roi.width * roi.height);
  for (let y = 0; y < roi.height; y++) {
    const sourceStart = (roi.y + y) * frame.width + roi.x;
    frame.buffer.copy(out, y * roi.width, sourceStart, sourceStart + roi.width);
  }
  return out;
}

function validRect(rect: NativeRect, width: number, height: number): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= MIN_PATCH_SIZE_PX * 0.5 &&
    rect.height >= MIN_PATCH_SIZE_PX * 0.5 &&
    rect.x + rect.width >= 0 &&
    rect.y + rect.height >= 0 &&
    rect.x <= width &&
    rect.y <= height
  );
}

function cvReady(cv: NativeKcfCv | null): cv is NativeKcfCv {
  return (
    typeof cv?.Mat === 'function' &&
    typeof cv?.Rect === 'function' &&
    typeof cv?.TrackerKCF === 'function' &&
    typeof cv?.CV_8UC1 === 'number' &&
    typeof cv?.TM_CCOEFF_NORMED === 'number'
  );
}

function usableFrame(frame: GrayFrame): boolean {
  return frame.width > 0 && frame.height > 0 && frame.buffer.length >= frame.width * frame.height;
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

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clearTracker(tracker: NativeTrackerKcf): void {
  try {
    tracker.clear?.();
  } catch {
    /* native tracker cleanup is best effort */
  }
}

function deleteMat(mat: NativeMat): void {
  try {
    mat.delete?.();
  } catch {
    /* native Mat cleanup is best effort */
  }
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

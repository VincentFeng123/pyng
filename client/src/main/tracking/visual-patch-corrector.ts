import type { PingProjection } from './ping-tracker.js';
import type { GrayFrame } from './capture-loop.js';

export type VisualPatchCorrection = {
  id: string;
  observedScreenX: number;
  observedScreenY: number;
  confidence: number;
  score: number;
};

export type VisualPatchCorrectorOptions = {
  patchSizePx?: number;
  innerMaskRadiusPx?: number;
  searchRadiusPx?: number;
  minScore?: number;
  minScoreMargin?: number;
  coarseStepPx?: number;
  distinctMatchDistancePx?: number;
  maxLostFrames?: number;
  templateUpdateAlpha?: number;
};

type Bounds = {
  width: number;
  height: number;
};

type PatchTemplate = {
  values: Float32Array;
  weights: Uint8Array;
  weightedCount: number;
  mean: number;
  norm: number;
};

type PatchTrack = {
  id: string;
  template: PatchTemplate | null;
  lastFrameX: number;
  lastFrameY: number;
  lostFrames: number;
};

type MatchResult = {
  x: number;
  y: number;
  score: number;
  scoreMargin: number;
};

const DEFAULT_PATCH_SIZE = 61;
const DEFAULT_INNER_MASK_RADIUS = 19;
const DEFAULT_SEARCH_RADIUS = 84;
const DEFAULT_MIN_SCORE = 0.68;
const DEFAULT_MIN_SCORE_MARGIN = 0.035;
const DEFAULT_COARSE_STEP_PX = 2;
const DEFAULT_DISTINCT_MATCH_DISTANCE_PX = 10;
const DEFAULT_MAX_LOST_FRAMES = 8;
const DEFAULT_TEMPLATE_UPDATE_ALPHA = 0.02;
const MIN_TEMPLATE_NORM = 32;

export class VisualPatchCorrector {
  private readonly patchSizePx: number;
  private readonly halfPatch: number;
  private readonly innerMaskRadiusPx: number;
  private readonly searchRadiusPx: number;
  private readonly minScore: number;
  private readonly minScoreMargin: number;
  private readonly coarseStepPx: number;
  private readonly distinctMatchDistancePx: number;
  private readonly maxLostFrames: number;
  private readonly templateUpdateAlpha: number;
  private readonly weights: Uint8Array;
  private readonly weightedCount: number;
  private tracks = new Map<string, PatchTrack>();

  constructor(options: VisualPatchCorrectorOptions = {}) {
    const requestedPatchSize = Math.round(options.patchSizePx ?? DEFAULT_PATCH_SIZE);
    this.patchSizePx = requestedPatchSize % 2 === 0 ? requestedPatchSize + 1 : requestedPatchSize;
    this.halfPatch = Math.floor(this.patchSizePx / 2);
    this.innerMaskRadiusPx = Math.max(0, options.innerMaskRadiusPx ?? DEFAULT_INNER_MASK_RADIUS);
    this.searchRadiusPx = Math.max(1, Math.round(options.searchRadiusPx ?? DEFAULT_SEARCH_RADIUS));
    this.minScore = clamp(options.minScore ?? DEFAULT_MIN_SCORE, -1, 1);
    this.minScoreMargin = Math.max(0, options.minScoreMargin ?? DEFAULT_MIN_SCORE_MARGIN);
    this.coarseStepPx = Math.max(1, Math.round(options.coarseStepPx ?? DEFAULT_COARSE_STEP_PX));
    this.distinctMatchDistancePx = Math.max(
      1,
      Math.round(options.distinctMatchDistancePx ?? DEFAULT_DISTINCT_MATCH_DISTANCE_PX),
    );
    this.maxLostFrames = Math.max(1, Math.round(options.maxLostFrames ?? DEFAULT_MAX_LOST_FRAMES));
    this.templateUpdateAlpha = clamp(
      options.templateUpdateAlpha ?? DEFAULT_TEMPLATE_UPDATE_ALPHA,
      0,
      0.5,
    );
    this.weights = buildRingWeights(this.patchSizePx, this.innerMaskRadiusPx);
    this.weightedCount = this.weights.reduce((sum, weight) => sum + weight, 0);
  }

  reset(): void {
    this.tracks.clear();
  }

  update(frame: GrayFrame, projections: PingProjection[], bounds: Bounds): VisualPatchCorrection[] {
    if (bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0) {
      this.reset();
      return [];
    }

    const liveIds = new Set(projections.map((p) => p.id));
    for (const id of this.tracks.keys()) {
      if (!liveIds.has(id)) this.tracks.delete(id);
    }

    const scaleX = frame.width / bounds.width;
    const scaleY = frame.height / bounds.height;
    const corrections: VisualPatchCorrection[] = [];

    for (const projection of projections) {
      if (projection.isEdgeArrow) continue;

      const predictedFrameX = projection.screenX * scaleX;
      const predictedFrameY = projection.screenY * scaleY;
      let track = this.tracks.get(projection.id);
      if (!track) {
        track = {
          id: projection.id,
          template: null,
          lastFrameX: predictedFrameX,
          lastFrameY: predictedFrameY,
          lostFrames: 0,
        };
        this.tracks.set(projection.id, track);
      }

      if (track.template === null) {
        const template = this.captureTemplate(frame, predictedFrameX, predictedFrameY);
        if (template !== null) {
          track.template = template;
          track.lastFrameX = predictedFrameX;
          track.lastFrameY = predictedFrameY;
        }
        continue;
      }

      const match = this.findBestMatch(frame, track, predictedFrameX, predictedFrameY);
      if (
        match === null ||
        match.score < this.minScore ||
        match.scoreMargin < this.minScoreMargin
      ) {
        track.lostFrames += 1;
        if (track.lostFrames > this.maxLostFrames) {
          this.tracks.delete(track.id);
        }
        continue;
      }

      track.lostFrames = 0;
      track.lastFrameX = match.x;
      track.lastFrameY = match.y;
      this.updateTemplate(frame, track, match.x, match.y);

      const scoreConfidence = clamp((match.score - this.minScore) / (1 - this.minScore), 0, 1);
      const marginConfidence = clamp(
        (match.scoreMargin - this.minScoreMargin) / Math.max(0.01, 0.16 - this.minScoreMargin),
        0,
        1,
      );
      corrections.push({
        id: projection.id,
        observedScreenX: match.x / scaleX,
        observedScreenY: match.y / scaleY,
        confidence: Math.min(scoreConfidence, marginConfidence),
        score: match.score,
      });
    }

    return corrections;
  }

  private captureTemplate(
    frame: GrayFrame,
    centerX: number,
    centerY: number,
  ): PatchTemplate | null {
    if (!this.patchFits(frame, centerX, centerY)) return null;
    const values = this.extractPatch(frame, centerX, centerY);
    const stats = templateStats(values, this.weights, this.weightedCount);
    if (stats.norm < MIN_TEMPLATE_NORM) return null;
    return { values, weights: this.weights, weightedCount: this.weightedCount, ...stats };
  }

  private findBestMatch(
    frame: GrayFrame,
    track: PatchTrack,
    predictedFrameX: number,
    predictedFrameY: number,
  ): MatchResult | null {
    if (track.template === null) return null;

    const predictedDistance = Math.hypot(
      predictedFrameX - track.lastFrameX,
      predictedFrameY - track.lastFrameY,
    );
    const centerX = lerp(predictedFrameX, track.lastFrameX, predictedDistance > 2 ? 0.35 : 0);
    const centerY = lerp(predictedFrameY, track.lastFrameY, predictedDistance > 2 ? 0.35 : 0);
    const radius = Math.round(this.searchRadiusPx + Math.min(96, predictedDistance * 0.85));

    let best: MatchResult | null = null;
    for (let y = Math.round(centerY - radius); y <= centerY + radius; y += this.coarseStepPx) {
      for (let x = Math.round(centerX - radius); x <= centerX + radius; x += this.coarseStepPx) {
        if (!this.patchFits(frame, x, y)) continue;
        const score = this.scoreAt(frame, track.template, x, y);
        if (best === null || score > best.score) {
          best = { x, y, score, scoreMargin: Number.POSITIVE_INFINITY };
        }
      }
    }

    if (best === null) return null;

    let refined = best;
    for (let y = best.y - 2; y <= best.y + 2; y++) {
      for (let x = best.x - 2; x <= best.x + 2; x++) {
        if (!this.patchFits(frame, x, y)) continue;
        const score = this.scoreAt(frame, track.template, x, y);
        if (score > refined.score) {
          refined = { x, y, score, scoreMargin: Number.POSITIVE_INFINITY };
        }
      }
    }

    let bestDistinctScore = -1;
    for (let y = Math.round(centerY - radius); y <= centerY + radius; y += this.coarseStepPx) {
      for (let x = Math.round(centerX - radius); x <= centerX + radius; x += this.coarseStepPx) {
        if (Math.hypot(x - refined.x, y - refined.y) < this.distinctMatchDistancePx) continue;
        if (!this.patchFits(frame, x, y)) continue;
        const score = this.scoreAt(frame, track.template, x, y);
        if (score > bestDistinctScore) {
          bestDistinctScore = score;
        }
      }
    }
    refined.scoreMargin = refined.score - bestDistinctScore;

    return refined;
  }

  private updateTemplate(
    frame: GrayFrame,
    track: PatchTrack,
    centerX: number,
    centerY: number,
  ): void {
    if (track.template === null) return;
    if (!this.patchFits(frame, centerX, centerY)) return;

    const nextValues = this.extractPatch(frame, centerX, centerY);
    for (let i = 0; i < nextValues.length; i++) {
      track.template.values[i] =
        track.template.values[i]! * (1 - this.templateUpdateAlpha) +
        nextValues[i]! * this.templateUpdateAlpha;
    }
    const stats = templateStats(
      track.template.values,
      track.template.weights,
      track.template.weightedCount,
    );
    track.template.mean = stats.mean;
    track.template.norm = stats.norm;
  }

  private scoreAt(
    frame: GrayFrame,
    template: PatchTemplate,
    centerX: number,
    centerY: number,
  ): number {
    const startX = Math.round(centerX) - this.halfPatch;
    const startY = Math.round(centerY) - this.halfPatch;
    let candidateSum = 0;

    for (let py = 0; py < this.patchSizePx; py++) {
      const frameOffset = (startY + py) * frame.width + startX;
      const patchOffset = py * this.patchSizePx;
      for (let px = 0; px < this.patchSizePx; px++) {
        const weight = template.weights[patchOffset + px]!;
        if (weight === 0) continue;
        candidateSum += frame.buffer[frameOffset + px]!;
      }
    }

    const candidateMean = candidateSum / template.weightedCount;
    let numerator = 0;
    let candidateNormSq = 0;

    for (let py = 0; py < this.patchSizePx; py++) {
      const frameOffset = (startY + py) * frame.width + startX;
      const patchOffset = py * this.patchSizePx;
      for (let px = 0; px < this.patchSizePx; px++) {
        const idx = patchOffset + px;
        const weight = template.weights[idx]!;
        if (weight === 0) continue;
        const candidateCentered = frame.buffer[frameOffset + px]! - candidateMean;
        numerator += (template.values[idx]! - template.mean) * candidateCentered;
        candidateNormSq += candidateCentered * candidateCentered;
      }
    }

    const candidateNorm = Math.sqrt(candidateNormSq);
    if (candidateNorm < MIN_TEMPLATE_NORM || template.norm < MIN_TEMPLATE_NORM) return -1;
    return numerator / (template.norm * candidateNorm);
  }

  private extractPatch(frame: GrayFrame, centerX: number, centerY: number): Float32Array {
    const values = new Float32Array(this.patchSizePx * this.patchSizePx);
    const startX = Math.round(centerX) - this.halfPatch;
    const startY = Math.round(centerY) - this.halfPatch;

    for (let py = 0; py < this.patchSizePx; py++) {
      const frameOffset = (startY + py) * frame.width + startX;
      const patchOffset = py * this.patchSizePx;
      for (let px = 0; px < this.patchSizePx; px++) {
        values[patchOffset + px] = frame.buffer[frameOffset + px]!;
      }
    }

    return values;
  }

  private patchFits(frame: GrayFrame, centerX: number, centerY: number): boolean {
    const x = Math.round(centerX);
    const y = Math.round(centerY);
    return (
      x - this.halfPatch >= 0 &&
      y - this.halfPatch >= 0 &&
      x + this.halfPatch < frame.width &&
      y + this.halfPatch < frame.height
    );
  }
}

function buildRingWeights(size: number, innerMaskRadius: number): Uint8Array {
  const weights = new Uint8Array(size * size);
  const half = Math.floor(size / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - half, y - half);
      weights[y * size + x] = distance <= innerMaskRadius ? 0 : 1;
    }
  }
  return weights;
}

function templateStats(
  values: Float32Array,
  weights: Uint8Array,
  weightedCount: number,
): { mean: number; norm: number } {
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (weights[i] === 0) continue;
    sum += values[i]!;
  }
  const mean = sum / Math.max(1, weightedCount);

  let normSq = 0;
  for (let i = 0; i < values.length; i++) {
    if (weights[i] === 0) continue;
    const centered = values[i]! - mean;
    normSq += centered * centered;
  }

  return { mean, norm: Math.sqrt(normSq) };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

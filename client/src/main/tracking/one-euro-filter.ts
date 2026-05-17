export type OneEuroFilterOptions = {
  minCutoff?: number;
  beta?: number;
  dCutoff?: number;
};

const DEFAULT_MIN_CUTOFF = 1.2;
const DEFAULT_BETA = 0.035;
const DEFAULT_D_CUTOFF = 1.0;
const MIN_DT_SEC = 1 / 240;
const MAX_DT_SEC = 0.25;

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private lastTimeSec: number | null = null;
  private lastValue: number | null = null;
  private lastDerivative = 0;

  constructor(options: OneEuroFilterOptions = {}) {
    this.minCutoff = finitePositiveOr(options.minCutoff, DEFAULT_MIN_CUTOFF);
    this.beta = Math.max(0, finiteOr(options.beta, DEFAULT_BETA));
    this.dCutoff = finitePositiveOr(options.dCutoff, DEFAULT_D_CUTOFF);
  }

  reset(value?: number, timeSec?: number): void {
    this.lastTimeSec = Number.isFinite(timeSec) ? timeSec! : null;
    this.lastValue = Number.isFinite(value) ? value! : null;
    this.lastDerivative = 0;
  }

  filter(value: number, timeSec: number): number {
    if (!Number.isFinite(value)) return this.lastValue ?? 0;
    if (!Number.isFinite(timeSec)) timeSec = 0;

    if (this.lastValue === null || this.lastTimeSec === null) {
      this.lastValue = value;
      this.lastTimeSec = timeSec;
      this.lastDerivative = 0;
      return value;
    }

    const dtSec = clamp(timeSec - this.lastTimeSec, MIN_DT_SEC, MAX_DT_SEC);
    const derivative = (value - this.lastValue) / dtSec;
    const derivativeAlpha = alpha(dtSec, this.dCutoff);
    const filteredDerivative = lowPass(derivative, this.lastDerivative, derivativeAlpha);
    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    const valueAlpha = alpha(dtSec, cutoff);
    const filteredValue = lowPass(value, this.lastValue, valueAlpha);

    this.lastValue = filteredValue;
    this.lastDerivative = filteredDerivative;
    this.lastTimeSec = timeSec;
    return filteredValue;
  }
}

function alpha(dtSec: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(1e-6, cutoff));
  return 1 / (1 + tau / Math.max(MIN_DT_SEC, dtSec));
}

function lowPass(value: number, previous: number, a: number): number {
  return a * value + (1 - a) * previous;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function finitePositiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

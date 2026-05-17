export type SurfaceTrackingMethod =
  | 'homography'
  | 'shape'
  | 'template'
  | 'klt'
  | 'kcf'
  | 'prediction';

export type SurfaceLockKind = 'circle' | 'plane' | 'template' | 'unknown';

export type SurfaceTrackerResult = {
  id: string;
  screenX: number;
  screenY: number;
  confidence: number;
  observedAtNs: number;
  inlierCount: number;
  trackedPointCount: number;
  residualPx: number;
  trackingMethod?: SurfaceTrackingMethod;
  surfaceConfidence?: number;
  surfaceLockKind?: SurfaceLockKind;
};

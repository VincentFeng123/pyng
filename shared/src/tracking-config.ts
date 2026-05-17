export type NormalizedRect = { x: number; y: number; w: number; h: number };

export type TrackingConfig = {
  id: string;
  displayName: string;
  fovH: number;
  fovV: number | null;
  trackingMask: {
    exclude: NormalizedRect[];
  };
};

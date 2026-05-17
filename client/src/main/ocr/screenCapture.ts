import sharp from 'sharp';

export class ScreenCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenCaptureError';
  }
}

export type GrayFrame = {
  buffer: Buffer;
  rgbBuffer?: Buffer;
  rgbaBuffer?: Buffer;
  width: number;
  height: number;
  capturedAtNs?: number;
  frameId?: number;
  source?: 'electron' | 'screencapturekit' | 'test';
  droppedFrames?: number;
};

let captureInFlight = false;
let grayCaptureInFlight = false;

const DEFAULT_TRACKING_CAPTURE_HEIGHT = 480;
const DEFAULT_INCLUDE_TRACKING_RGB_BUFFER =
  process.env.PYNG_ENABLE_TRACKING_COLOR === '1' || process.env.PYNG_ENABLE_SURFACE_LOCK === '1';

export type TrackingCaptureOptions = {
  includeRgbBuffer?: boolean;
  targetHeight?: number;
};

export async function captureAndDownscale(): Promise<Buffer> {
  if (captureInFlight) {
    throw new ScreenCaptureError('Capture already in flight');
  }
  captureInFlight = true;
  try {
    // Lazy import so this module can be loaded in headless Node (for tests on
    // downscaleTo720p) without Electron present.
    const { desktopCapturer, screen } = await import('electron');
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: display.size,
    });

    const source = sources.find((s) => s.display_id === String(display.id));
    if (!source) {
      throw new ScreenCaptureError(`No screen source found matching display id ${display.id}`);
    }

    const buffer = source.thumbnail.toPNG();
    return downscaleTo720p(buffer);
  } finally {
    captureInFlight = false;
  }
}

export async function captureAndDownscaleGray480p(
  options: TrackingCaptureOptions = {},
): Promise<GrayFrame> {
  if (grayCaptureInFlight) {
    throw new ScreenCaptureError('Gray capture already in flight');
  }
  grayCaptureInFlight = true;
  try {
    // Tracking does not need a PNG. Ask Electron for a low-resolution screen
    // thumbnail up front, then convert the raw bitmap to grayscale directly.
    // This avoids the old full-screen capture -> PNG encode -> sharp decode ->
    // resize -> grayscale path on every tracking frame.
    const { desktopCapturer, screen } = await import('electron');
    const display = screen.getPrimaryDisplay();
    const targetHeight = Math.min(
      normalizeTargetHeight(options.targetHeight ?? DEFAULT_TRACKING_CAPTURE_HEIGHT),
      display.size.height,
    );
    const targetWidth = Math.max(
      1,
      Math.round((display.size.width / display.size.height) * targetHeight),
    );
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: targetWidth, height: targetHeight },
    });

    const source = sources.find((s) => s.display_id === String(display.id));
    if (!source) {
      throw new ScreenCaptureError(`No screen source found matching display id ${display.id}`);
    }

    const size = source.thumbnail.getSize();
    const bitmap = source.thumbnail.toBitmap();
    const frame = bitmapToGrayscaleFrame(bitmap, size.width, size.height, options);
    frame.capturedAtNs = Number(process.hrtime.bigint());
    frame.source = 'electron';
    return frame;
  } finally {
    grayCaptureInFlight = false;
  }
}

function normalizeTargetHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TRACKING_CAPTURE_HEIGHT;
  return Math.max(120, Math.min(720, Math.round(value)));
}

export async function downscaleTo720p(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).resize({ height: 720, withoutEnlargement: true }).png().toBuffer();
}

export function bitmapToGrayscaleFrame(
  bitmap: Buffer,
  width: number,
  height: number,
  options: TrackingCaptureOptions = {},
): GrayFrame {
  if (width <= 0 || height <= 0) {
    throw new ScreenCaptureError(`Invalid bitmap dimensions ${width}x${height}`);
  }
  const pixelCount = width * height;
  const bytesPerPixel = bitmap.length / pixelCount;
  if (!Number.isInteger(bytesPerPixel) || bytesPerPixel < 3) {
    throw new ScreenCaptureError(
      `Unexpected bitmap shape: ${bitmap.length} bytes for ${width}x${height}`,
    );
  }

  const gray = Buffer.allocUnsafe(pixelCount);
  const includeRgb = options.includeRgbBuffer ?? DEFAULT_INCLUDE_TRACKING_RGB_BUFFER;
  const rgb = includeRgb ? Buffer.allocUnsafe(pixelCount * 3) : null;
  for (let i = 0, j = 0; i < pixelCount; i++, j += bytesPerPixel) {
    // NativeImage bitmap channel order is platform-dependent. Averaging the
    // first three color channels keeps grayscale conversion order-invariant.
    const c0 = bitmap[j]!;
    const c1 = bitmap[j + 1]!;
    const c2 = bitmap[j + 2]!;
    gray[i] = Math.round((c0 + c1 + c2) / 3);
    if (rgb !== null) {
      rgb[i * 3] = c0;
      rgb[i * 3 + 1] = c1;
      rgb[i * 3 + 2] = c2;
    }
  }
  return rgb === null
    ? { buffer: gray, width, height }
    : { buffer: gray, rgbBuffer: rgb, width, height };
}

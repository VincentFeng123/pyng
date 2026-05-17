import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceAnchorTracker, applyHomography } from './surface-anchor-tracker.js';
import type { GrayFrame } from './capture-loop.js';
import type { PingProjection } from './ping-tracker.js';
import type { SurfaceAnchorTrackerOptions } from './surface-anchor-tracker.js';
import type { SurfaceTrackerResult } from './surface-tracking-types.js';

type MockCv = NonNullable<SurfaceAnchorTrackerOptions['_cv']>;

type MockMat = {
  rows: number;
  cols: number;
  data: Uint8Array;
  data32F: Float32Array;
  data64F: Float64Array;
  delete(): void;
};

type MockKeyPoint = {
  pt: { x: number; y: number };
};

type MockMatch = {
  queryIdx: number;
  trainIdx: number;
  distance: number;
};

const HOMOGRAPHY_POINTS: Array<[number, number]> = [
  [34, 28],
  [58, 31],
  [82, 29],
  [42, 54],
  [72, 57],
  [101, 53],
  [31, 81],
  [62, 86],
  [93, 84],
  [118, 78],
  [49, 110],
  [95, 112],
];

function makeMat(rows = 0, cols = 0): MockMat {
  return {
    rows,
    cols,
    data: new Uint8Array(rows * cols),
    data32F: new Float32Array(rows * cols * 2),
    data64F: new Float64Array(0),
    delete() {},
  };
}

class MockVector<T> {
  values: T[] = [];

  size(): number {
    return this.values.length;
  }

  get(index: number): T {
    return this.values[index]!;
  }

  delete(): void {}
}

function makeHomographyCv(dx: number, dy: number): MockCv {
  let detectCalls = 0;

  class MockOrb {
    detectAndCompute(
      _image: MockMat,
      _mask: MockMat,
      keypoints: MockVector<MockKeyPoint>,
      descriptors: MockMat,
    ): void {
      const offsetX = detectCalls === 0 ? 0 : dx;
      const offsetY = detectCalls === 0 ? 0 : dy;
      detectCalls += 1;
      keypoints.values = HOMOGRAPHY_POINTS.map(([x, y]) => ({
        pt: { x: x + offsetX, y: y + offsetY },
      }));
      descriptors.rows = HOMOGRAPHY_POINTS.length;
      descriptors.cols = 32;
      descriptors.data = new Uint8Array(descriptors.rows * descriptors.cols);
      for (let i = 0; i < descriptors.data.length; i++) {
        descriptors.data[i] = i % 251;
      }
    }

    delete(): void {}
  }

  class MockMatcher {
    knnMatch(
      query: MockMat,
      _train: MockMat,
      matches: MockVector<MockVector<MockMatch>>,
      _k: number,
    ): void {
      matches.values = [];
      for (let i = 0; i < query.rows; i++) {
        const pair = new MockVector<MockMatch>();
        pair.values = [
          { queryIdx: i, trainIdx: i, distance: 12 },
          { queryIdx: i, trainIdx: (i + 1) % query.rows, distance: 40 },
        ];
        matches.values.push(pair);
      }
    }

    delete(): void {}
  }

  return {
    CV_8UC1: 0,
    CV_32FC2: 13,
    NORM_HAMMING: 6,
    RANSAC: 8,
    Mat: function MockMatCtor(this: MockMat) {
      const mat = makeMat();
      this.rows = mat.rows;
      this.cols = mat.cols;
      this.data = mat.data;
      this.data32F = mat.data32F;
      this.data64F = mat.data64F;
      this.delete = mat.delete;
    } as unknown as MockCv['Mat'],
    matFromArray(rows: number, cols: number, _type: number, data: ArrayBufferView): MockMat {
      const mat = makeMat(rows, cols);
      if (data instanceof Float32Array) {
        mat.data32F = data;
      } else {
        mat.data = new Uint8Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
      }
      return mat;
    },
    ORB: MockOrb as unknown as MockCv['ORB'],
    BFMatcher: MockMatcher as unknown as MockCv['BFMatcher'],
    KeyPointVector: MockVector<MockKeyPoint> as unknown as MockCv['KeyPointVector'],
    DMatchVectorVector: MockVector<
      MockVector<MockMatch>
    > as unknown as MockCv['DMatchVectorVector'],
    findHomography(
      src: MockMat,
      dst: MockMat,
      _method: number,
      _threshold: number,
      mask: MockMat,
    ): MockMat {
      const translations: number[] = [];
      for (let i = 0; i < src.rows; i++) {
        translations.push(dst.data32F[i * 2]! - src.data32F[i * 2]!);
      }
      translations.sort((a, b) => a - b);
      const tx = translations[Math.floor(translations.length / 2)] ?? dx;
      const h = makeMat(3, 3);
      h.data64F = new Float64Array([1, 0, tx, 0, 1, dy, 0, 0, 1]);
      mask.rows = src.rows;
      mask.cols = 1;
      mask.data = new Uint8Array(src.rows).fill(1);
      return h;
    },
  };
}

function frame(width: number, height: number, fill = 24): GrayFrame {
  return { width, height, buffer: Buffer.alloc(width * height, fill), source: 'test' };
}

function frameWithRgb(width: number, height: number, fill = 24): GrayFrame {
  const gray = Buffer.alloc(width * height, fill);
  const rgb = Buffer.alloc(width * height * 3, fill);
  return { width, height, buffer: gray, rgbBuffer: rgb, source: 'test' };
}

function projectionAt(
  id: string,
  frameX: number,
  frameY: number,
  bounds = { width: 260, height: 180 },
  frameSize = { width: 260, height: 180 },
): PingProjection {
  return {
    id,
    screenX: frameX / (frameSize.width / bounds.width),
    screenY: frameY / (frameSize.height / bounds.height),
    confidence: 1,
    isEdgeArrow: false,
  };
}

function drawTexture(target: GrayFrame, cx: number, cy: number, size = 61): void {
  const half = Math.floor(size / 2);
  for (let y = -half; y <= half; y++) {
    for (let x = -half; x <= half; x++) {
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= target.width || py >= target.height) continue;
      target.buffer[py * target.width + px] =
        35 + ((x * 19 + y * 23 + x * y * 5 + x * x * 7 + y * y * 11 + 8192) % 180);
    }
  }
}

function drawColoredTexture(
  target: GrayFrame,
  cx: number,
  cy: number,
  color: [number, number, number],
  size = 61,
): void {
  assert.ok(target.rgbBuffer);
  const half = Math.floor(size / 2);
  for (let y = -half; y <= half; y++) {
    for (let x = -half; x <= half; x++) {
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= target.width || py >= target.height) continue;
      const idx = py * target.width + px;
      target.buffer[idx] =
        35 + ((x * 19 + y * 23 + x * y * 5 + x * x * 7 + y * y * 11 + 8192) % 180);
      target.rgbBuffer[idx * 3] = color[0];
      target.rgbBuffer[idx * 3 + 1] = color[1];
      target.rgbBuffer[idx * 3 + 2] = color[2];
    }
  }
}

function drawGoldCircle(target: GrayFrame, cx: number, cy: number, radius: number): void {
  assert.ok(target.rgbBuffer);
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (x < 0 || y < 0 || x >= target.width || y >= target.height) continue;
      if (Math.hypot(x - cx, y - cy) > radius) continue;
      const idx = y * target.width + x;
      target.buffer[idx] = 176;
      target.rgbBuffer[idx * 3] = 222;
      target.rgbBuffer[idx * 3 + 1] = 174;
      target.rgbBuffer[idx * 3 + 2] = 42;
    }
  }
}

describe('SurfaceAnchorTracker', () => {
  it('maps a circular gold target through translation and scale using the stored relative circle point', () => {
    const bounds = { width: 1920, height: 1080 };
    const frameSize = { width: 260, height: 180 };
    const first = frameWithRgb(frameSize.width, frameSize.height);
    const second = frameWithRgb(frameSize.width, frameSize.height);
    drawGoldCircle(first, 96, 84, 36);
    drawGoldCircle(second, 130, 96, 48);

    const pingFrame = { x: 108, y: 96 };
    const expectedFrame = {
      x: 130 + ((pingFrame.x - 96) / 36) * 48,
      y: 96 + ((pingFrame.y - 84) / 36) * 48,
    };
    const tracker = new SurfaceAnchorTracker({
      _cv: {} as MockCv,
      localRadiusScreenPx: 720,
      templateSizeFramePx: 51,
    });
    const projection = projectionAt('circle', pingFrame.x, pingFrame.y, bounds, frameSize);

    tracker.update(null, first, [projection], bounds, [], 0);
    const observations = tracker.update(first, second, [projection], bounds, [], 16_000_000);

    assert.equal(observations[0]!.trackingMethod, 'shape');
    const scaleX = frameSize.width / bounds.width;
    const scaleY = frameSize.height / bounds.height;
    assert.ok(Math.abs(observations[0]!.screenX * scaleX - expectedFrame.x) <= 4);
    assert.ok(Math.abs(observations[0]!.screenY * scaleY - expectedFrame.y) <= 4);
    assert.equal(observations[0]!.surfaceLockKind, 'circle');
  });

  it('maps the ping with a homography when ORB matches have enough RANSAC inliers', () => {
    const tracker = new SurfaceAnchorTracker({
      _cv: makeHomographyCv(23, 17),
      minHomographyMatches: 10,
      templateSizeFramePx: 51,
    });
    const first = frame(300, 220);
    const second = frame(300, 220);
    const projection = projectionAt(
      'plane',
      100,
      80,
      { width: 300, height: 220 },
      { width: 300, height: 220 },
    );

    tracker.update(null, first, [projection], { width: 300, height: 220 }, [], 0);
    const observations = tracker.update(
      first,
      second,
      [projection],
      { width: 300, height: 220 },
      [],
      16_000_000,
    );

    assert.equal(observations[0]!.trackingMethod, 'homography');
    assert.ok(Math.abs(observations[0]!.screenX - 123) <= 1);
    assert.ok(Math.abs(observations[0]!.screenY - 97) <= 1);
    assert.ok(observations[0]!.inlierCount >= 10);
  });

  it('falls back to local visual evidence when ORB/homography is unavailable', () => {
    const tracker = new SurfaceAnchorTracker({
      _cv: {} as MockCv,
      templateSizeFramePx: 61,
    });
    const first = frame(220, 140);
    const second = frame(220, 140);
    drawTexture(first, 90, 70);
    drawTexture(second, 116, 70);
    const projection = projectionAt(
      'template',
      90,
      70,
      { width: 220, height: 140 },
      { width: 220, height: 140 },
    );

    tracker.update(null, first, [projection], { width: 220, height: 140 }, [], 0);
    const observations = tracker.update(
      first,
      second,
      [projection],
      { width: 220, height: 140 },
      [],
      16_000_000,
    );

    assert.ok(
      observations[0]!.trackingMethod === 'template' || observations[0]!.trackingMethod === 'shape',
    );
    assert.ok(Math.abs(observations[0]!.screenX - 116) <= 8);
    assert.ok(observations[0]!.confidence >= 0.38);
  });

  it('uses color and texture verification to reject a same-grayscale distractor', () => {
    const tracker = new SurfaceAnchorTracker({
      _cv: {} as MockCv,
      localRadiusScreenPx: 420,
      templateSizeFramePx: 61,
    });
    const first = frameWithRgb(260, 160);
    const second = frameWithRgb(260, 160);
    drawColoredTexture(first, 90, 80, [220, 40, 40]);
    drawColoredTexture(second, 104, 80, [40, 60, 220]);
    drawColoredTexture(second, 130, 80, [220, 40, 40]);
    const projection = projectionAt(
      'appearance',
      90,
      80,
      { width: 260, height: 160 },
      { width: 260, height: 160 },
    );

    tracker.update(null, first, [projection], { width: 260, height: 160 }, [], 0);
    const observations = tracker.update(
      first,
      second,
      [projection],
      { width: 260, height: 160 },
      [],
      16_000_000,
    );

    assert.equal(observations[0]!.trackingMethod, 'template');
    assert.ok(
      Math.abs(observations[0]!.screenX - 130) <= 4,
      `expected red target near 130, got ${observations[0]!.screenX}`,
    );
  });

  it('defaults to a 500 screen-pixel context window for each ping surface model', () => {
    const tracker = new SurfaceAnchorTracker({ _cv: {} as MockCv });
    const f = frameWithRgb(960, 540);
    drawColoredTexture(f, 480, 270, [190, 80, 60], 61);
    const projection = projectionAt(
      'context',
      480,
      270,
      { width: 1920, height: 1080 },
      { width: 960, height: 540 },
    );

    tracker.update(null, f, [projection], { width: 1920, height: 1080 }, [], 0);

    const model = tracker.getModel('context');
    assert.ok(model);
    assert.ok(
      Math.abs(model.width / (f.width / 1920) - 500) <= 4,
      `context width should be about 500 screen px, got ${model.width}`,
    );
  });

  it('rejects off-surface KLT observations instead of snapping away from prediction', () => {
    const fakeKlt = {
      reset(): void {},
      update(): SurfaceTrackerResult[] {
        return [
          {
            id: 'klt',
            screenX: 260,
            screenY: 70,
            confidence: 0.95,
            observedAtNs: 16_000_000,
            inlierCount: 30,
            trackedPointCount: 30,
            residualPx: 1,
            trackingMethod: 'klt',
            surfaceConfidence: 0.95,
            surfaceLockKind: 'unknown',
          },
        ];
      },
    };
    const tracker = new SurfaceAnchorTracker({
      _cv: {} as MockCv,
      _kltTracker: fakeKlt as never,
      enableKltFallback: true,
    });
    const f = frame(220, 140);
    const projection = projectionAt(
      'klt',
      80,
      70,
      { width: 220, height: 140 },
      { width: 220, height: 140 },
    );

    const observations = tracker.update(
      null,
      f,
      [projection],
      { width: 220, height: 140 },
      [],
      16_000_000,
    );

    assert.equal(observations[0]!.trackingMethod, 'prediction');
    assert.ok(Math.abs(observations[0]!.screenX - 80) < 1);
    assert.ok(observations[0]!.confidence < 0.2);
  });
});

describe('applyHomography', () => {
  it('applies projective coordinates', () => {
    const mapped = applyHomography(
      new Float64Array([1, 0.1, 12, -0.05, 1, 8, 0.001, 0.002, 1]),
      40,
      30,
    );
    assert.ok(Number.isFinite(mapped.x));
    assert.ok(Number.isFinite(mapped.y));
  });
});

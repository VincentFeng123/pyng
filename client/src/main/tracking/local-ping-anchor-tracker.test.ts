import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalPingAnchorTracker,
  type LocalPingAnchorTrackerOptions,
} from './local-ping-anchor-tracker.js';
import type { GrayFrame } from './capture-loop.js';
import type { PingProjection } from './ping-tracker.js';

type MockCv = NonNullable<LocalPingAnchorTrackerOptions['_cv']>;
type MockMat = {
  rows: number;
  data: Uint8Array;
  data32F: Float32Array;
  delete(): void;
};

function makeMat(): MockMat {
  return {
    rows: 0,
    data: new Uint8Array(0),
    data32F: new Float32Array(0),
    delete() {},
  };
}

function makeMockCv(dx: number, dy: number): MockCv {
  const features: Array<[number, number]> = [
    [82, 48],
    [101, 50],
    [121, 52],
    [88, 72],
    [112, 74],
    [100, 92],
    [130, 86],
    [70, 88],
  ];

  return {
    CV_8UC1: 0,
    CV_32FC2: 13,
    Mat: Object.assign(
      function MockMatCtor(this: MockMat) {
        this.rows = 0;
        this.data = new Uint8Array(0);
        this.data32F = new Float32Array(0);
        this.delete = () => {};
      } as unknown as MockCv['Mat'],
      {
        ones(): MockMat {
          return makeMat();
        },
      },
    ),
    matFromArray(rows: number, _cols: number, _type: number, data: ArrayBufferView): MockMat {
      const mat = makeMat();
      mat.rows = rows;
      if (data instanceof Float32Array) {
        mat.data32F = data;
      }
      return mat;
    },
    Point: class MockPoint {
      constructor(
        public x: number,
        public y: number,
      ) {}
    } as unknown as MockCv['Point'],
    Scalar: class MockScalar {
      constructor(..._v: number[]) {}
    } as unknown as MockCv['Scalar'],
    Size: class MockSize {
      constructor(
        public width: number,
        public height: number,
      ) {}
    } as unknown as MockCv['Size'],
    TermCriteria: class MockTermCriteria {
      constructor(
        public type: number,
        public maxCount: number,
        public epsilon: number,
      ) {}
    } as unknown as MockCv['TermCriteria'],
    rectangle(): void {},
    goodFeaturesToTrack(
      _src: MockMat,
      dst: MockMat,
      maxCorners: number,
      _qualityLevel: number,
      _minDistance: number,
      _mask?: MockMat,
    ): void {
      const pts = features.slice(0, maxCorners);
      dst.rows = pts.length;
      dst.data32F = new Float32Array(pts.flatMap(([x, y]) => [x, y]));
    },
    calcOpticalFlowPyrLK(
      _prev: MockMat,
      _next: MockMat,
      prevPts: MockMat,
      nextPts: MockMat,
      status: MockMat,
      err: MockMat,
    ): void {
      const n = prevPts.rows;
      const nextData = new Float32Array(n * 2);
      const statusData = new Uint8Array(n);
      const errData = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = prevPts.data32F[i * 2]!;
        const y = prevPts.data32F[i * 2 + 1]!;
        nextData[i * 2] = x + dx;
        nextData[i * 2 + 1] = y + dy;
        statusData[i] = 1;
        errData[i] = 1;
      }
      nextPts.rows = n;
      nextPts.data32F = nextData;
      status.rows = n;
      status.data = statusData;
      err.rows = n;
      err.data32F = errData;
    },
  };
}

function frame(width = 220, height = 140): GrayFrame {
  return { width, height, buffer: Buffer.alloc(width * height, 80), source: 'test' };
}

function projection(): PingProjection {
  return {
    id: 'p',
    screenX: 100,
    screenY: 70,
    confidence: 1,
    isEdgeArrow: false,
  };
}

describe('LocalPingAnchorTracker', () => {
  it('detects local features, then tracks the ping anchor with LK motion', () => {
    const tracker = new LocalPingAnchorTracker({
      _cv: makeMockCv(14, 0),
      maxFeatures: 16,
      minInliers: 4,
    });
    const bounds = { width: 220, height: 140 };
    const first = frame();
    const second = frame();

    const initial = tracker.update(null, first, [projection()], bounds, [], 0);
    assert.equal(initial.length, 0);

    const observations = tracker.update(first, second, [projection()], bounds, [], 16_000_000);
    assert.equal(observations.length, 1);
    assert.ok(observations[0]!.screenX > 110);
    assert.equal(observations[0]!.inlierCount, 8);
    assert.ok(observations[0]!.confidence > 0.6);
  });
});

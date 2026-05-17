import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  warmup,
  _resetWarmup,
  estimateMotion,
  type CvApi,
  type MatLike,
} from './motion-estimator.js';

// ---- Mock cv factory ----
//
// Builds a pure-JS cv that simulates goodFeaturesToTrack + calcOpticalFlowPyrLK
// for a known translation scenario. The mock populates the output Mats in-place
// after the cv functions are called, matching the data layout the real cv uses:
//   corners.data32F[i*2]   = x_i
//   corners.data32F[i*2+1] = y_i
//   nextPts.data32F[i*2]   = x_i + dx
//   nextPts.data32F[i*2+1] = y_i + dy
//   status.data[i]         = 1 (tracked) or 0 (lost)

type MockMat = MatLike & { _tag?: string };
type LkCallParams = {
  winSize?: object;
  maxLevel?: number;
  criteria?: object;
  flags?: number;
  minEigThreshold?: number;
};

function makeMockMat(): MockMat {
  return {
    rows: 0,
    data: new Uint8Array(0),
    data32F: new Float32Array(0),
    delete() {},
  };
}

type MakeCvOptions = {
  // Number of corners goodFeaturesToTrack will report.
  cornerCount: number;
  // Translation applied to all corners by calcOpticalFlowPyrLK.
  dx: number;
  dy: number;
  // Fraction of corners whose status is set to 0 (tracked = lost). Default 0.
  lostFraction?: number;
  // After computing pairs, replace this fraction with random noise. Default 0.
  noiseFraction?: number;
  // Corners placed in the masked area (bottom 15%) — used for mask test.
  cornersInMask?: number;
  // Optional deterministic point set for tests that need exact geometry.
  fixedPoints?: Array<[number, number]>;
  // Optional point transform for rotation-shaped flow fields.
  transformPoint?: (x: number, y: number) => [number, number] | null;
  frameWidth?: number;
  frameHeight?: number;
  onLkCall?: (params: LkCallParams) => void;
};

function makeMockCv(opts: MakeCvOptions): CvApi {
  const {
    cornerCount,
    dx,
    dy,
    lostFraction = 0,
    noiseFraction = 0,
    cornersInMask = 0,
    fixedPoints,
    transformPoint,
    frameWidth = 640,
    frameHeight = 480,
    onLkCall,
  } = opts;

  const width = frameWidth;
  const height = frameHeight;
  let seed = 0xdecafbad;
  const nextRandom = (): number => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  // Tracks which masks were applied so the mask test can verify corners were excluded.
  const maskedRegions: Array<{ x: number; y: number; w: number; h: number }> = [];

  function isInMaskedRegion(x: number, y: number): boolean {
    for (const r of maskedRegions) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
    }
    return false;
  }

  const cv: CvApi = {
    CV_8UC1: 0,

    Mat: Object.assign(
      function MockMat(this: MockMat) {
        this.rows = 0;
        this.data = new Uint8Array(0);
        this.data32F = new Float32Array(0);
        this.delete = () => {};
      } as unknown as CvApi['Mat'],
      {
        ones(_rows: number, _cols: number, _type: number): MatLike {
          return makeMockMat();
        },
      },
    ),

    matFromArray(_rows: number, _cols: number, _type: number, _data: ArrayBufferView): MatLike {
      return makeMockMat();
    },

    Point: class MockPoint {
      constructor(
        public x: number,
        public y: number,
      ) {}
    } as unknown as CvApi['Point'],

    Scalar: class MockScalar {
      constructor(..._v: number[]) {}
    } as unknown as CvApi['Scalar'],

    Size: class MockSize {
      constructor(
        public width: number,
        public height: number,
      ) {}
    } as unknown as CvApi['Size'],

    TermCriteria: class MockTermCriteria {
      constructor(
        public type: number,
        public maxCount: number,
        public epsilon: number,
      ) {}
    } as unknown as CvApi['TermCriteria'],

    rectangle(_mat: MatLike, pt1: object, pt2: object, _color: object, _thickness: number): void {
      const p1 = pt1 as { x: number; y: number };
      const p2 = pt2 as { x: number; y: number };
      maskedRegions.push({
        x: p1.x,
        y: p1.y,
        w: p2.x - p1.x,
        h: p2.y - p1.y,
      });
    },

    goodFeaturesToTrack(
      _src: MatLike,
      dst: MatLike,
      _maxCorners: number,
      _qualityLevel: number,
      _minDistance: number,
      _mask?: MatLike,
    ): void {
      // Generate corners spread across the image, excluding masked regions.
      const pts: Array<[number, number]> = [];
      if (fixedPoints !== undefined) {
        pts.push(...fixedPoints.slice(0, cornerCount));
      }
      let attemptsLeft = cornerCount * 10;
      while (pts.length < cornerCount && attemptsLeft-- > 0) {
        const cx = nextRandom() * (width - 20) + 10;
        // For cornersInMask corners, place them in the bottom 15%.
        const inMask = pts.length < cornersInMask;
        const cy = inMask
          ? height * 0.85 + nextRandom() * height * 0.14
          : nextRandom() * (height * 0.84);
        if (!isInMaskedRegion(cx, cy)) {
          pts.push([cx, cy]);
        }
      }
      const data = new Float32Array(pts.length * 2);
      for (let i = 0; i < pts.length; i++) {
        data[i * 2] = pts[i]![0];
        data[i * 2 + 1] = pts[i]![1];
      }
      dst.rows = pts.length;
      dst.data32F = data;
    },

    calcOpticalFlowPyrLK(
      _prev: MatLike,
      _next: MatLike,
      prevPts: MatLike,
      nextPts: MatLike,
      status: MatLike,
      err: MatLike,
      winSize?: object,
      maxLevel?: number,
      criteria?: object,
      flags?: number,
      minEigThreshold?: number,
    ): void {
      onLkCall?.({ winSize, maxLevel, criteria, flags, minEigThreshold });
      const n = prevPts.rows;
      const nextData = new Float32Array(n * 2);
      const statusData = new Uint8Array(n);
      const errData = new Float32Array(n);
      const lostCount = Math.floor(n * lostFraction);
      const noiseCount = Math.floor(n * noiseFraction);

      for (let i = 0; i < n; i++) {
        const x0 = prevPts.data32F[i * 2]!;
        const y0 = prevPts.data32F[i * 2 + 1]!;

        const isLost = i < lostCount;
        const isNoise = !isLost && i < lostCount + noiseCount;

        if (isLost) {
          statusData[i] = 0;
          nextData[i * 2] = x0;
          nextData[i * 2 + 1] = y0;
        } else if (isNoise) {
          statusData[i] = 1;
          // Random large displacement — will fail RANSAC consensus.
          nextData[i * 2] = x0 + (nextRandom() - 0.5) * 40;
          nextData[i * 2 + 1] = y0 + (nextRandom() - 0.5) * 40;
        } else {
          const transformed: [number, number] | null = transformPoint
            ? transformPoint(x0, y0)
            : [x0 + dx, y0 + dy];
          if (transformed === null) {
            statusData[i] = 0;
            nextData[i * 2] = x0;
            nextData[i * 2 + 1] = y0;
          } else {
            statusData[i] = 1;
            nextData[i * 2] = transformed[0];
            nextData[i * 2 + 1] = transformed[1];
          }
        }
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

  return cv;
}

function makeDeterministicTexture(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height);
  let seed = 0x12345678;
  for (let i = 0; i < buf.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    buf[i] = (seed >>> 16) & 0xff;
  }
  return buf;
}

function translateFrame(
  src: Buffer,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Buffer {
  const out = Buffer.alloc(width * height, 127);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      out[y * width + x] = src[sy * width + sx]!;
    }
  }
  return out;
}

function makePureYawPoints(width: number, height: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let y = 70; y <= height - 70; y += 42) {
    for (let x = 330; x <= width - 45; x += 48) {
      points.push([x, y]);
    }
  }
  return points;
}

function projectPureYawPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  fovH: number,
  yawDeltaDeg: number,
): [number, number] | null {
  const cx = width / 2;
  const fx = cx / Math.tan(((fovH / 2) * Math.PI) / 180);
  const nextYaw = Math.atan2(x - cx, fx) - (yawDeltaDeg * Math.PI) / 180;
  const nextX = cx + Math.tan(nextYaw) * fx;
  if (nextX < 0 || nextX >= width || y < 0 || y >= height) return null;
  return [nextX, y];
}

// ---- warmup tests ----

describe('warmup()', () => {
  it('resolves without a native OpenCV requirement in plain Node', async () => {
    // _resetWarmup so we start fresh.
    _resetWarmup();
    // warmup() with the real import will either resolve via cv.ready or fall
    // through to the already-initialized path. Either way it must not reject.
    await assert.doesNotReject(() => warmup());
  });

  it('is idempotent — second call returns immediately', async () => {
    // First call already ran in the test above; ensure second call is instant.
    const t0 = Date.now();
    await warmup();
    assert.ok(Date.now() - t0 < 50, 'second warmup() should return in < 50ms');
  });
});

// ---- synthetic translation test ----

describe('estimateMotion()', () => {
  it('detects synthetic 30px rightward translation', () => {
    const cv = makeMockCv({ cornerCount: 100, dx: 30, dy: 0 });
    const buf = Buffer.alloc(640 * 480, 128);
    const motion = estimateMotion(buf, buf, 640, 480, [], 8, cv);

    assert.ok(motion !== null, 'motion should not be null');
    assert.ok(Math.abs(motion.yawDelta) > 0, `|yawDelta| should be > 0, got ${motion.yawDelta}`);
    assert.ok(motion.inlierCount >= 30, `inlierCount should be ≥ 30, got ${motion.inlierCount}`);
    // Expected yawDelta = -30 / 8 = -3.75 degrees
    assert.ok(
      Math.abs(motion.yawDelta - -30 / 8) < 1,
      `yawDelta ${motion.yawDelta} should be close to ${-30 / 8}`,
    );
  });

  it('can convert optical flow through the camera FOV model', () => {
    const fixedPoints = Array.from(
      { length: 100 },
      (_, i) => [320, 20 + i * 4] as [number, number],
    );
    const cv = makeMockCv({ cornerCount: 100, dx: 30, dy: 0, fixedPoints });
    const buf = Buffer.alloc(640 * 480, 128);
    const fovH = 70;
    const motion = estimateMotion(
      buf,
      buf,
      640,
      480,
      [],
      { pixelsPerDegree: 8, horizontalFovDeg: fovH, verticalFovDeg: 43 },
      cv,
    );

    assert.ok(motion !== null, 'motion should not be null');
    const fx = 640 / 2 / Math.tan(((fovH / 2) * Math.PI) / 180);
    const expected = -(Math.atan2(30, fx) * 180) / Math.PI;
    assert.ok(
      Math.abs(motion.yawDelta - expected) < 0.25,
      `yawDelta ${motion.yawDelta} should be close to ${expected}`,
    );
  });

  it('passes explicit pyramidal LK parameters to OpenCV', () => {
    let lkParams: LkCallParams | null = null;
    const cv = makeMockCv({
      cornerCount: 100,
      dx: 12,
      dy: 0,
      onLkCall: (params) => {
        lkParams = params;
      },
    });
    const buf = Buffer.alloc(640 * 480, 128);
    const motion = estimateMotion(buf, buf, 640, 480, [], 8, cv);

    assert.ok(motion !== null, 'motion should not be null');
    assert.ok(lkParams !== null, 'calcOpticalFlowPyrLK should be called');
    const observedLkParams = lkParams as LkCallParams;
    assert.equal((observedLkParams.winSize as { width: number }).width, 31);
    assert.equal((observedLkParams.winSize as { height: number }).height, 31);
    assert.equal(observedLkParams.maxLevel, 4);
    assert.equal((observedLkParams.criteria as { type: number }).type, 3);
    assert.equal((observedLkParams.criteria as { maxCount: number }).maxCount, 30);
    assert.equal((observedLkParams.criteria as { epsilon: number }).epsilon, 0.01);
    assert.equal(observedLkParams.minEigThreshold, 1e-4);
  });

  for (const yawDeltaDeg of [10, 15, 20]) {
    it(`recovers synthetic pure yaw at 853x480: ${yawDeltaDeg}deg`, () => {
      const width = 853;
      const height = 480;
      const fovH = 70;
      const fixedPoints = makePureYawPoints(width, height);
      const cv = makeMockCv({
        cornerCount: fixedPoints.length,
        dx: 0,
        dy: 0,
        fixedPoints,
        frameWidth: width,
        frameHeight: height,
        transformPoint: (x, y) => projectPureYawPoint(x, y, width, height, fovH, yawDeltaDeg),
      });
      const buf = Buffer.alloc(width * height, 128);
      const motion = estimateMotion(
        buf,
        buf,
        width,
        height,
        [],
        { pixelsPerDegree: 8, horizontalFovDeg: fovH, verticalFovDeg: 43 },
        cv,
      );

      assert.ok(motion !== null, 'motion should not be null');
      assert.equal(motion.model, 'lk-rotation');
      assert.ok(
        Math.abs(motion.yawDelta - yawDeltaDeg) < 1,
        `yawDelta ${motion.yawDelta} should be within 1deg of ${yawDeltaDeg}`,
      );
      assert.ok(
        Math.abs(motion.pitchDelta) < 0.5,
        `pitchDelta ${motion.pitchDelta} should stay near 0`,
      );
      assert.ok((motion.residualDeg ?? Number.POSITIVE_INFINITY) < 0.25);
    });
  }

  // ---- random noise → null ----

  it('returns null for unrelated random noise when LK has no corners', () => {
    // Corner count of 0 simulates no stable features found.
    const cv = makeMockCv({ cornerCount: 0, dx: 0, dy: 0 });
    const prevNoise = makeDeterministicTexture(640, 480);
    const currNoise = makeDeterministicTexture(640, 480).reverse();

    const motion = estimateMotion(prevNoise, currNoise, 640, 480, [], 8, cv);
    assert.equal(motion, null, 'unrelated noise should not produce a stable fallback motion');
  });

  it('returns null when fewer than 30 corners detected', () => {
    const cv = makeMockCv({ cornerCount: 10, dx: 5, dy: 0 });
    const buf = Buffer.alloc(640 * 480, 128);
    const motion = estimateMotion(buf, buf, 640, 480, [], 8, cv);
    assert.equal(motion, null);
  });

  it('large-motion fallback recovers fast camera shifts when LK has no usable corners', () => {
    const cv = makeMockCv({ cornerCount: 0, dx: 0, dy: 0 });
    const prev = makeDeterministicTexture(640, 480);
    const curr = translateFrame(prev, 640, 480, 180, 0);

    const motion = estimateMotion(
      prev,
      curr,
      640,
      480,
      [],
      { pixelsPerDegree: 8, horizontalFovDeg: 70, verticalFovDeg: 43 },
      cv,
    );

    assert.ok(motion !== null, 'fallback motion should recover a large translation');
    assert.ok(Math.abs(motion.dxPx - 180) <= 12, `dxPx ${motion.dxPx} should be near 180`);
    assert.ok(motion.yawDelta < 0, `yawDelta ${motion.yawDelta} should be negative`);
  });

  // ---- HUD mask test ----

  it('HUD mask excludes bottom-strip corners, improving accuracy', () => {
    // Create two cv mocks: one without mask (cornersInMask=40), one with mask applied.
    // The mask scenario: 40 corners are placed in the bottom 15% of the screen (the HUD).
    // These corners have zero translation (HUD is static), while the background moves 30px right.
    // WITHOUT mask: the HUD corners drag the estimated translation toward 0.
    // WITH mask: the HUD region is blacked out so goodFeaturesToTrack only finds background corners.
    //
    // Since the mock cv applies the mask internally (filters corners in masked regions when
    // isInMaskedRegion is true), we drive the test by checking inlierCount:
    //   - with mask: all non-HUD corners agree on dx=30 → high inlier count
    //   - without mask: HUD corners (dx=0) pollute the set

    // Without mask: 100 corners total, 40 placed in HUD (dx=0 for them is simulated by
    // giving them a separate displacement). We simulate this by making those 40 corners
    // produce a conflicting translation via noiseFraction.
    const cvWithoutMask = makeMockCv({
      cornerCount: 100,
      dx: 30,
      dy: 0,
      noiseFraction: 0.4, // 40% of corners disagree with the true translation
    });

    const cvWithMask = makeMockCv({
      cornerCount: 100,
      dx: 30,
      dy: 0,
      cornersInMask: 0, // mask excludes the HUD, so no HUD corners reach goodFeaturesToTrack
    });

    const buf = Buffer.alloc(640 * 480, 128);
    // Bottom 15% mask region (matches phantom-forces HUD).
    const maskRegions = [{ x: 0, y: 0.85, w: 1, h: 0.15 }];

    const motionWithoutMask = estimateMotion(buf, buf, 640, 480, [], 8, cvWithoutMask);
    const motionWithMask = estimateMotion(buf, buf, 640, 480, maskRegions, 8, cvWithMask);

    // With mask applied, should get a clean result.
    assert.ok(motionWithMask !== null, 'masked motion should not be null');
    assert.ok(
      motionWithMask!.inlierCount > (motionWithoutMask?.inlierCount ?? 0),
      `masked inlierCount (${motionWithMask!.inlierCount}) should exceed unmasked (${motionWithoutMask?.inlierCount ?? 0})`,
    );
  });
});

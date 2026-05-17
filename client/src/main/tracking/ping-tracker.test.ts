import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DirectionalPingTracker, PingTracker } from './ping-tracker.js';

const W = 1920;
const H = 1080;
const FOV_H = 70;
const FOV_V = 42.996;

const DEG = Math.PI / 180;

describe('DirectionalPingTracker', () => {
  it('is exported through the compatibility PingTracker name', () => {
    const t = new PingTracker();
    assert.ok(t instanceof DirectionalPingTracker);
  });

  it('center drop stores fixed bearing ≈ current yaw', () => {
    const t = new PingTracker();
    t.addPing('p1', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    const ping = t.getPing('p1')!;
    assert.ok(Math.abs(ping.bearingDeg) < 1e-9, `bearing ${ping.bearingDeg} not near 0`);

    const projs = t.projectAll(Date.now(), W, H, FOV_H, FOV_V);
    assert.strictEqual(projs.length, 1);
    const p = projs[0]!;
    assert.ok(Math.abs(p.screenX - W / 2) < 1, `screenX ${p.screenX} not near center`);
    assert.ok(Math.abs(p.screenY - H / 2) < 1, `screenY ${p.screenY} not near center`);
  });

  it('right-edge drop stores bearing ≈ +fovH/2', () => {
    const t = new PingTracker();
    t.addPing('p2', W, H / 2, W, H, FOV_H, FOV_V, 5000);

    const ping = t.getPing('p2')!;
    assert.ok(
      Math.abs(ping.bearingDeg - FOV_H / 2) < 0.5,
      `bearing ${ping.bearingDeg} not near ${FOV_H / 2}`,
    );
  });

  it('left-edge drop stores bearing ≈ -fovH/2', () => {
    const t = new PingTracker();
    t.addPing('p3', 0, H / 2, W, H, FOV_H, FOV_V, 5000);

    const ping = t.getPing('p3')!;
    assert.ok(
      Math.abs(ping.bearingDeg - -FOV_H / 2) < 0.5,
      `bearing ${ping.bearingDeg} not near ${-FOV_H / 2}`,
    );
  });

  it('vertical click position stores a pitch bearing', () => {
    const t = new PingTracker();
    t.addPing('top', W / 2, 0, W, H, FOV_H, FOV_V, 5000);

    const ping = t.getPing('top')!;
    assert.ok(Math.abs(ping.bearingDeg) < 1e-9);
    assert.ok(
      Math.abs(ping.pitchBearingDeg - FOV_V / 2) < 0.5,
      `pitch bearing ${ping.pitchBearingDeg} not near ${FOV_V / 2}`,
    );

    const projs = t.projectAll(Date.now(), W, H, FOV_H, FOV_V);
    assert.ok(Math.abs(projs[0]!.screenY) < 1);
  });

  for (const fovH of [60, 70, 90, 120]) {
    it(`horizontal round-trip at fovH=${fovH}`, () => {
      const fovHRad = fovH * DEG;
      const fovVRad = 2 * Math.atan(Math.tan(fovHRad / 2) * (H / W));
      const fovV = fovVRad / DEG;
      const t = new PingTracker();
      const sx = 700;
      t.addPing('rt', sx, 400, W, H, fovH, fovV, 5000);

      const projs = t.projectAll(Date.now(), W, H, fovH, fovV);
      assert.strictEqual(projs.length, 1);
      const p = projs[0]!;
      assert.ok(Math.abs(p.screenX - sx) < 1, `fovH=${fovH}: screenX ${p.screenX} != ${sx}`);
      assert.ok(Math.abs(p.screenY - 400) < 1, `fovH=${fovH}: screenY ${p.screenY} != 400`);
    });
  }

  it('mouse yaw updates current yaw while ping bearing remains fixed', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('m1', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    assert.equal(t.applyMouseDelta(80), true);
    assert.equal(t.getYawDeg(), 10);
    assert.equal(t.getPing('m1')!.bearingDeg, 0);

    const projs = t.projectAll(Date.now(), W, H, FOV_H, FOV_V);
    const p = projs[0]!;
    assert.ok(!p.isEdgeArrow, 'should be in-FOV');
    assert.ok(p.screenX < W / 2, `screenX ${p.screenX} should be left of center`);
  });

  it('projectAllAtPose predicts from a temporary pose without mutating current yaw', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('predict', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.applyMouseDelta(80);

    const current = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    const predicted = t.projectAllAtPose(Date.now(), 12, 0, W, H, FOV_H, FOV_V)[0]!;

    assert.equal(t.getYawDeg(), 10);
    assert.ok(predicted.screenX < current.screenX, 'higher predicted yaw should move ping left');
  });

  it('mouse pitch updates current pitch and moves ping opposite vertical mouse motion', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('pitch', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    assert.equal(t.applyMouseDelta(0, -80), true);
    assert.equal(t.getPitchDeg(), 10);
    assert.equal(t.getPing('pitch')!.pitchBearingDeg, 0);

    const projs = t.projectAll(Date.now(), W, H, FOV_H, FOV_V);
    const p = projs[0]!;
    assert.ok(!p.isEdgeArrow, 'should be in-FOV');
    assert.ok(p.screenY > H / 2, `screenY ${p.screenY} should move down when camera looks up`);
  });

  it('matching optical flow validates mouse prediction without double-applying it', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('m2', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    t.applyMouseDelta(80);
    assert.equal(t.getYawDeg(), 10);
    assert.equal(
      t.applyOpticalFlow({
        yawDeltaDeg: 10,
        pitchDeltaDeg: 0,
        confidence: 1,
        medianDxPx: -80,
        medianDyPx: 0,
        trackedPointCount: 100,
      }),
      true,
    );
    assert.equal(t.getYawDeg(), 10);
  });

  it('accepts valid fast yaw even when median dx exceeds the old pixel guard', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('fast-flow', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    assert.equal(
      t.applyOpticalFlow({
        yawDeltaDeg: 28,
        pitchDeltaDeg: 0,
        confidence: 0.9,
        medianDxPx: -240,
        medianDyPx: 0,
        trackedPointCount: 120,
      }),
      true,
    );
    assert.ok(t.getYawDeg() > 2, `fast optical yaw ${t.getYawDeg()} should be applied`);
  });

  it('rejects absurd angular jumps even when pixel telemetry is finite', () => {
    const t = new PingTracker();
    t.addPing('absurd-flow', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    assert.equal(
      t.applyOpticalFlow({
        yawDeltaDeg: 70,
        pitchDeltaDeg: 0,
        confidence: 1,
        medianDxPx: -260,
        medianDyPx: 0,
        trackedPointCount: 120,
      }),
      false,
    );
    assert.equal(t.getYawDeg(), 0);
  });

  it('uses same-sign optical disagreement as correction instead of rejecting magnitude mismatch', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('same-sign-flow', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    t.applyMouseDelta(80);
    assert.equal(t.getYawDeg(), 10);
    assert.equal(
      t.applyOpticalFlow({
        yawDeltaDeg: 16,
        pitchDeltaDeg: 0,
        confidence: 1,
        medianDxPx: -180,
        medianDyPx: 0,
        trackedPointCount: 100,
        opticalBlendWeight: 0.5,
      }),
      true,
    );
    assert.equal(tidy(t.getYawDeg()), 12.825);
  });

  it('disagreeing optical flow is rejected and fades instead of jumping yaw', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('bad-flow', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    t.applyMouseDelta(80);
    const beforeConfidence = t.getPing('bad-flow')!.confidence;
    assert.equal(
      t.applyOpticalFlow({
        yawDeltaDeg: -45,
        pitchDeltaDeg: 0,
        confidence: 1,
        medianDxPx: 120,
        medianDyPx: 0,
        trackedPointCount: 100,
      }),
      false,
    );

    assert.equal(t.getYawDeg(), 10);
    assert.ok(t.getPing('bad-flow')!.confidence < beforeConfidence);
  });

  it('optical-only flow only nudges yaw when mouse input is unavailable', () => {
    const t = new PingTracker();
    t.addPing('flow', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    assert.equal(
      t.applyOpticalFlow({
        yawDeltaDeg: 5,
        pitchDeltaDeg: 0,
        confidence: 1,
        medianDxPx: -40,
        medianDyPx: 0,
        trackedPointCount: 100,
      }),
      true,
    );
    assert.ok(t.getYawDeg() > 0);
    assert.ok(t.getYawDeg() < 1, `optical-only yaw ${t.getYawDeg()} should be a small assist`);

    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(p.screenX < W / 2);
  });

  it('explicit optical blend weight can make visual motion authoritative', () => {
    const t = new PingTracker();
    t.addPing('flow-authority', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    assert.equal(
      t.applyOpticalFlow({
        yawDeltaDeg: 5,
        pitchDeltaDeg: 0,
        confidence: 0.5,
        medianDxPx: -40,
        medianDyPx: 0,
        trackedPointCount: 100,
        opticalBlendWeight: 1,
      }),
      true,
    );
    assert.equal(t.getYawDeg(), 5);
  });

  it('authoritative optical tracking holds still through tiny alternating jitter', () => {
    const t = new PingTracker();
    t.addPing('still', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    for (const yawDeltaDeg of [0.05, -0.04, 0.03, -0.05, 0.02]) {
      assert.equal(
        t.applyOpticalFlow({
          yawDeltaDeg,
          pitchDeltaDeg: 0,
          confidence: 1,
          medianDxPx: -yawDeltaDeg * 8,
          medianDyPx: 0,
          trackedPointCount: 100,
          opticalBlendWeight: 1,
        }),
        true,
      );
    }

    assert.equal(tidy(t.getYawDeg()), 0);
    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(Math.abs(p.screenX - W / 2) < 1, `screenX ${p.screenX} should stay centered`);
  });

  it('authoritative optical tracking does not drift from persistent tiny bias', () => {
    const t = new PingTracker();
    t.addPing('bias', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    for (let i = 0; i < 12; i++) {
      assert.equal(
        t.applyOpticalFlow({
          yawDeltaDeg: 0.06,
          pitchDeltaDeg: 0,
          confidence: 1,
          medianDxPx: -0.48,
          medianDyPx: 0,
          trackedPointCount: 100,
          opticalBlendWeight: 1,
        }),
        true,
      );
    }

    assert.equal(tidy(t.getYawDeg()), 0);
  });

  it('authoritative optical tracking accumulates consistent slow motion instead of dropping it', () => {
    const t = new PingTracker();
    t.addPing('slow', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    for (const yawDeltaDeg of [0.12, 0.12]) {
      t.applyOpticalFlow({
        yawDeltaDeg,
        pitchDeltaDeg: 0,
        confidence: 1,
        medianDxPx: -yawDeltaDeg * 8,
        medianDyPx: 0,
        trackedPointCount: 100,
        opticalBlendWeight: 1,
      });
      assert.equal(tidy(t.getYawDeg()), 0);
    }

    t.applyOpticalFlow({
      yawDeltaDeg: 0.12,
      pitchDeltaDeg: 0,
      confidence: 1,
      medianDxPx: -0.96,
      medianDyPx: 0,
      trackedPointCount: 100,
      opticalBlendWeight: 1,
    });

    assert.equal(tidy(t.getYawDeg()), 0.36);
  });

  it('visual bearing correction pulls yaw toward the observed patch position', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('visual', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.applyMouseDelta(80);

    assert.equal(t.getYawDeg(), 10);
    assert.equal(t.applyVisualBearingCorrection('visual', W / 2, H / 2, 1, 1, 10), true);
    assert.equal(t.getYawDeg(), 0);

    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(Math.abs(p.screenX - W / 2) < 1);
  });

  it('visual bearing correction pulls pitch toward the observed patch position', () => {
    const t = new PingTracker({ mouseSensitivityDegPerPx: 1 / 8 });
    t.addPing('visual-pitch', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.applyMouseDelta(0, -80);

    assert.equal(t.getPitchDeg(), 10);
    assert.equal(t.applyVisualBearingCorrection('visual-pitch', W / 2, H / 2, 1, 1, 10), true);
    assert.equal(t.getPitchDeg(), 0);

    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(Math.abs(p.screenY - H / 2) < 1);
  });

  it('pitch outside the vertical FOV becomes a top or bottom edge arrow', () => {
    const t = new PingTracker();
    t.addPing('top-edge', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.setPitchDeg(-60);

    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(p.isEdgeArrow, 'should be edge arrow');
    assert.ok(Math.abs(p.screenX - W / 2) < 5);
    assert.ok(Math.abs(p.screenY - 40) < 1);
    assert.ok(Math.abs((p.arrowAngle ?? 0) + 90) < 5);
  });

  it('180° yaw rotation makes the ping an edge arrow pointing left', () => {
    const t = new PingTracker();
    t.addPing('edge', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.setYawDeg(180);

    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(p.isEdgeArrow, 'should be edge arrow');
    assert.ok(Math.abs(Math.abs(p.arrowAngle!) - 180) < 5);
    assert.ok(Math.abs(p.screenX - 40) < 1);
    assert.ok(Math.abs(p.screenY - H / 2) < 5);
  });

  it('TTL eviction removes expired pings', () => {
    const t = new PingTracker();
    const now = 1_000_000;
    t.addPing('ttl', W / 2, H / 2, W, H, FOV_H, FOV_V, 1000);
    const ping = (
      t as unknown as { active: Map<string, { createdAtMs: number; expiresAtMs: number }> }
    ).active.get('ttl')!;
    ping.createdAtMs = now;
    ping.expiresAtMs = now + 1000;

    assert.strictEqual(t.projectAll(now + 999, W, H, FOV_H, FOV_V).length, 1);
    assert.strictEqual(t.projectAll(now + 1001, W, H, FOV_H, FOV_V).length, 0);
  });

  it('confidence blends toward optical confidence', () => {
    const t = new PingTracker();
    t.addPing('conf', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.applyMotion({
      yawDelta: 0,
      pitchDelta: 0,
      confidence: 0.5,
      inlierCount: 50,
      dxPx: 0,
      dyPx: 0,
    });

    assert.ok(Math.abs(t.getPing('conf')!.confidence - 0.95) < 1e-9);
  });

  it('fadeConfidence reduces confidence without changing fixed bearing', () => {
    const t = new PingTracker();
    t.addPing('fade', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);

    t.fadeConfidence(0.5);
    const ping = t.getPing('fade')!;
    assert.equal(ping.confidence, 0.5);
    assert.equal(ping.bearingDeg, 0);
  });

  it('clear() removes all pings', () => {
    const t = new PingTracker();
    t.addPing('a', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.addPing('b', 100, 100, W, H, FOV_H, FOV_V, 5000);
    assert.strictEqual(t.getActiveCount(), 2);

    t.clear();

    assert.strictEqual(t.getActiveCount(), 0);
  });

  it('addPing with same id replaces existing entry', () => {
    const t = new PingTracker();
    t.addPing('dup', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.addPing('dup', 100, 200, W, H, FOV_H, FOV_V, 5000);

    assert.strictEqual(t.getActiveCount(), 1);
    const ping = (
      t as unknown as { active: Map<string, { initialScreenX: number; initialScreenY: number }> }
    ).active.get('dup')!;
    assert.strictEqual(ping.initialScreenX, 100);
    assert.strictEqual(ping.initialScreenY, 200);
  });
});

function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

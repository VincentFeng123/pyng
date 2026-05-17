import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PingTracker } from './ping-tracker.js';

const W = 1920;
const H = 1080;
const FOV_H = 70;
const FOV_V = 42.996;

describe('Directional ping integration', () => {
  it('center ping + 30° yaw → screenX left of center', () => {
    const t = new PingTracker();
    t.addPing('p1', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.applyMotion({
      yawDelta: 30,
      pitchDelta: 0,
      confidence: 1,
      inlierCount: 100,
      dxPx: 0,
      dyPx: 0,
    });

    const projs = t.projectAll(Date.now(), W, H, FOV_H, FOV_V);
    assert.strictEqual(projs.length, 1);

    const p = projs[0]!;
    assert.ok(!p.isEdgeArrow, 'ping should be in-FOV');
    assert.ok(
      p.screenX < W / 2,
      `screenX ${p.screenX.toFixed(1)} should be left of center ${W / 2}`,
    );
    assert.ok(W / 2 - p.screenX > 50, `shift ${(W / 2 - p.screenX).toFixed(1)}px too small`);
  });

  it('center ping + upward mouse pitch → screenY moves down', () => {
    const t = new PingTracker();
    t.addPing('p1-y', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.applyMouseDelta(0, -96);

    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(!p.isEdgeArrow, 'ping should be in-FOV');
    assert.ok(p.screenY > H / 2, `screenY ${p.screenY.toFixed(1)} should be below center`);
    assert.ok(p.screenY - H / 2 > 50, `shift ${(p.screenY - H / 2).toFixed(1)}px too small`);
  });

  it('3-ping bag survives yaw updates with correct ids', () => {
    const t = new PingTracker();
    t.addPing('a', 200, 300, W, H, FOV_H, FOV_V, 5000);
    t.addPing('b', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.addPing('c', 1600, 800, W, H, FOV_H, FOV_V, 5000);

    t.applyMotion({
      yawDelta: 5,
      pitchDelta: 2,
      confidence: 0.9,
      inlierCount: 80,
      dxPx: 0,
      dyPx: 0,
    });

    const ids = new Set(t.projectAll(Date.now(), W, H, FOV_H, FOV_V).map((p) => p.id));
    assert.equal(ids.size, 3);
    assert.ok(ids.has('a'));
    assert.ok(ids.has('b'));
    assert.ok(ids.has('c'));
  });

  it('TTL expiry happens during projection', () => {
    const t = new PingTracker();
    const now = 1_000_000;

    t.addPing('ttl', W / 2, H / 2, W, H, FOV_H, FOV_V, 100);
    const ping = (t as unknown as { active: Map<string, { expiresAtMs: number }> }).active.get(
      'ttl',
    )!;
    ping.expiresAtMs = now + 100;

    assert.strictEqual(t.projectAll(now + 99, W, H, FOV_H, FOV_V).length, 1);
    assert.strictEqual(t.projectAll(now + 101, W, H, FOV_H, FOV_V).length, 0);
  });

  it('confidence decays toward flow confidence over repeated corrections', () => {
    const t = new PingTracker();
    t.addPing('conf', W / 2, H / 2, W, H, FOV_H, FOV_V, 60000);

    for (let i = 0; i < 10; i++) {
      t.applyMotion({
        yawDelta: 0,
        pitchDelta: 0,
        confidence: 0.5,
        inlierCount: 50,
        dxPx: 0,
        dyPx: 0,
      });
    }

    const ping = t.getPing('conf')!;
    const alpha10 = Math.pow(0.9, 10);
    const expected = alpha10 * 1.0 + (1 - alpha10) * 0.5;

    assert.ok(
      Math.abs(ping.confidence - expected) < 1e-9,
      `confidence ${ping.confidence.toFixed(6)} should match ${expected.toFixed(6)}`,
    );
    assert.ok(ping.confidence > 0.5);
    assert.ok(ping.confidence < 1.0);
  });

  it('180° yaw rotation → edge arrow appears', () => {
    const t = new PingTracker();
    t.addPing('p5', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.setYawDeg(180);

    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(p.isEdgeArrow, 'ping behind camera should become an edge arrow');
    assert.ok(p.arrowAngle !== undefined, 'edge arrow should have an arrowAngle');
  });

  it('edge arrow lands on left edge for 180° pure yaw', () => {
    const t = new PingTracker();
    t.addPing('edge', W / 2, H / 2, W, H, FOV_H, FOV_V, 5000);
    t.setYawDeg(180);

    const p = t.projectAll(Date.now(), W, H, FOV_H, FOV_V)[0]!;
    assert.ok(p.isEdgeArrow, 'should be edge arrow');
    assert.ok(Math.abs(p.screenX - 40) < 1, `screenX ${p.screenX.toFixed(2)} should be 40`);
    assert.ok(Math.abs(p.screenY - H / 2) < 5);
  });
});

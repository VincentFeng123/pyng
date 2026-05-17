import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGameConfig, getMaskRegions, computeFovV } from './game-masks.js';

describe('loadGameConfig', () => {
  it('loads phantom-forces config', () => {
    const config = loadGameConfig('phantom-forces');
    assert.equal(config.id, 'phantom-forces');
    assert.equal(config.fovH, 70);
    assert.equal(config.fovV, null);
  });

  it('throws for unknown gameId', () => {
    assert.throws(
      () => loadGameConfig('unknown'),
      (err: Error) => {
        assert.ok(err.message.includes('Unknown gameId: unknown'));
        return true;
      },
    );
  });
});

describe('getMaskRegions', () => {
  it('returns 3 mask entries for phantom-forces', () => {
    const config = loadGameConfig('phantom-forces');
    const regions = getMaskRegions(config);
    assert.equal(regions.length, 3);
  });
});

describe('computeFovV', () => {
  it('returns ~43.0° for 70° hFOV at 1920×1080', () => {
    const result = computeFovV(70, 1920, 1080);
    assert.ok(Math.abs(result - 43.0) < 0.15, `expected ~43.0, got ${result}`);
  });
});

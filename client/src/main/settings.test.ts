import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PING_COLOR,
  MAX_AVATAR_BASE64_LENGTH,
  clearAvatar,
  createSettingsStore,
  getCalibrationData,
  getFirstRunHintShown,
  getManualHorizontalFov,
  getManualTrackingProfile,
  getHotkey,
  getPersistentPair,
  getPingColor,
  getRobloxUsername,
  getTrackingFps,
  estimateManualMousePixelsPerDegree,
  loadSettings,
  onSettingsChange,
  saveAvatar,
  saveCalibrationData,
  saveHotkey,
  saveManualTrackingProfile,
  savePersistentPair,
  savePingColor,
  saveRobloxUsername,
  saveTrackingFps,
  setFirstRunHintShown,
  clearPersistentPair,
  validateRobloxUsernameSoft,
} from './settings.js';

function withTempStore<T>(fn: (store: ReturnType<typeof createSettingsStore>) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyng-settings-test-'));
  try {
    const store = createSettingsStore({ cwd: dir, name: 'pyng-settings-test' });
    return fn(store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadSettings returns defaults on a fresh store', () => {
  withTempStore((store) => {
    const s = loadSettings(store);
    assert.equal(s.version, 7);
    assert.equal(s.avatar, null);
    assert.deepEqual(s.hotkey, { accelerator: 'P', mode: 'hold' });
    assert.equal(s.firstRunHintShown, false);
    assert.equal(s.robloxUsername, '');
    assert.equal(s.pingColor, DEFAULT_PING_COLOR);
    assert.equal(s.persistentPair, undefined);
    assert.equal(s.calibrationData, undefined);
    assert.deepEqual(s.tracking, { fps: 'auto' });
    assert.equal(s.manualTrackingProfile, undefined);
  });
});

test('saveAvatar persists and loadSettings reads it back', () => {
  withTempStore((store) => {
    const sample = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    saveAvatar(sample, store);
    const s = loadSettings(store);
    assert.ok(s.avatar);
    assert.equal(s.avatar.imageBase64, sample);
    assert.equal(typeof s.avatar.setAt, 'number');
    assert.ok(s.avatar.setAt > 0);
  });
});

test('saveAvatar rejects oversize input', () => {
  withTempStore((store) => {
    const tooBig = 'A'.repeat(MAX_AVATAR_BASE64_LENGTH);
    assert.throws(() => saveAvatar(tooBig, store), /exceeds maximum length/);
    const s = loadSettings(store);
    assert.equal(s.avatar, null);
  });
});

test('clearAvatar resets to null', () => {
  withTempStore((store) => {
    saveAvatar('ZmFrZQ==', store);
    assert.ok(loadSettings(store).avatar);
    clearAvatar(store);
    assert.equal(loadSettings(store).avatar, null);
  });
});

test('onSettingsChange fires on save and clear', async () => {
  await withTempStore(async (store) => {
    const events: Array<{ hasAvatar: boolean }> = [];
    const unsub = onSettingsChange((s) => events.push({ hasAvatar: s.avatar !== null }), store);
    saveAvatar('ZmFrZQ==', store);
    clearAvatar(store);
    unsub();
    saveAvatar('YWZ0ZXI=', store);
    assert.deepEqual(events, [{ hasAvatar: true }, { hasAvatar: false }]);
  });
});

test('saveHotkey persists and getHotkey reads it back', () => {
  withTempStore((store) => {
    saveHotkey('Ctrl+Shift+P', 'hold', store);
    assert.deepEqual(getHotkey(store), { accelerator: 'Ctrl+Shift+P', mode: 'hold' });
    const s = loadSettings(store);
    assert.deepEqual(s.hotkey, { accelerator: 'Ctrl+Shift+P', mode: 'hold' });
  });
});

test('saveHotkey rejects empty accelerator', () => {
  withTempStore((store) => {
    assert.throws(() => saveHotkey('   ', 'press', store), /non-empty/);
    assert.throws(() => saveHotkey('', 'press', store), /non-empty/);
  });
});

test('saveHotkey rejects malformed accelerator', () => {
  withTempStore((store) => {
    assert.throws(() => saveHotkey('Ctrl Shift P', 'press', store), /format invalid/);
    assert.throws(() => saveHotkey('!@#', 'press', store), /format invalid/);
  });
});

test('saveHotkey rejects invalid mode', () => {
  withTempStore((store) => {
    // @ts-expect-error invalid mode literal for test
    assert.throws(() => saveHotkey('Z', 'toggle', store), /press.*hold/);
  });
});

test('savePingColor persists normalized hex color', () => {
  withTempStore((store) => {
    savePingColor('#FF3355', store);
    assert.equal(getPingColor(store), '#ff3355');
    assert.equal(loadSettings(store).pingColor, '#ff3355');
  });
});

test('savePingColor rejects non-hex colors', () => {
  withTempStore((store) => {
    assert.throws(() => savePingColor('red', store), /#RRGGBB/);
    assert.throws(() => savePingColor('#12345', store), /#RRGGBB/);
    assert.equal(getPingColor(store), DEFAULT_PING_COLOR);
  });
});

test('savePersistentPair persists a resumable group id', () => {
  withTempStore((store) => {
    const groupId = '550e8400-e29b-41d4-a716-446655440000';
    savePersistentPair(groupId, store);
    const pair = getPersistentPair(store);
    assert.ok(pair);
    assert.equal(pair.groupId, groupId);
    assert.equal(typeof pair.pairedAt, 'number');
    assert.equal(loadSettings(store).persistentPair?.groupId, groupId);
  });
});

test('clearPersistentPair removes saved pair state', () => {
  withTempStore((store) => {
    savePersistentPair('550e8400-e29b-41d4-a716-446655440000', store);
    clearPersistentPair(store);
    assert.equal(getPersistentPair(store), null);
    assert.equal(loadSettings(store).persistentPair, undefined);
  });
});

test('savePersistentPair rejects non-uuid group ids', () => {
  withTempStore((store) => {
    assert.throws(() => savePersistentPair('not-a-uuid', store), /UUID/);
    assert.equal(getPersistentPair(store), null);
  });
});

test('setFirstRunHintShown persists and getFirstRunHintShown reads it back', () => {
  withTempStore((store) => {
    assert.equal(getFirstRunHintShown(store), false);
    setFirstRunHintShown(true, store);
    assert.equal(getFirstRunHintShown(store), true);
    assert.equal(loadSettings(store).firstRunHintShown, true);
  });
});

test('pre-v2 settings file (avatar-only) loads with defaults filled', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyng-settings-test-prev2-'));
  try {
    // Synthesize a v1-era settings file: avatar set, no robloxUsername key.
    // electron-store's `defaults` fills missing keys; migration bumps version.
    const filePath = path.join(dir, 'pyng-settings-test.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        avatar: { imageBase64: 'ZmFrZQ==', setAt: 1234567890 },
      }),
    );
    const store = createSettingsStore({ cwd: dir, name: 'pyng-settings-test' });
    const s = loadSettings(store);
    assert.equal(s.version, 7);
    assert.ok(s.avatar);
    assert.equal(s.avatar.imageBase64, 'ZmFrZQ==');
    assert.deepEqual(s.hotkey, { accelerator: 'P', mode: 'hold' });
    assert.equal(s.firstRunHintShown, false);
    assert.equal(s.robloxUsername, '');
    assert.equal(s.pingColor, DEFAULT_PING_COLOR);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// saveRobloxUsername tests

test('saveRobloxUsername persists and getRobloxUsername reads it back', () => {
  withTempStore((store) => {
    saveRobloxUsername('Vincent_Feng69', store);
    assert.equal(getRobloxUsername(store), 'Vincent_Feng69');
    assert.equal(loadSettings(store).robloxUsername, 'Vincent_Feng69');
  });
});

test('saveRobloxUsername accepts short usernames (1-2 chars)', () => {
  withTempStore((store) => {
    assert.doesNotThrow(() => saveRobloxUsername('ab', store));
    assert.equal(getRobloxUsername(store), 'ab');
  });
});

test('saveRobloxUsername accepts empty string (clearing)', () => {
  withTempStore((store) => {
    saveRobloxUsername('Vincent_Feng69', store);
    assert.doesNotThrow(() => saveRobloxUsername('', store));
    assert.equal(getRobloxUsername(store), '');
  });
});

test('saveRobloxUsername rejects username with space', () => {
  withTempStore((store) => {
    assert.throws(() => saveRobloxUsername('has space', store), /Invalid Roblox username/);
  });
});

test('saveRobloxUsername rejects username exceeding 20 chars', () => {
  withTempStore((store) => {
    assert.throws(() => saveRobloxUsername('x'.repeat(21), store), /Invalid Roblox username/);
  });
});

test('saveRobloxUsername rejects username with special chars', () => {
  withTempStore((store) => {
    assert.throws(() => saveRobloxUsername('hello!', store), /Invalid Roblox username/);
    assert.throws(() => saveRobloxUsername('foo@bar', store), /Invalid Roblox username/);
  });
});

// validateRobloxUsernameSoft tests

test('validateRobloxUsernameSoft returns ok:true for empty string', () => {
  assert.deepEqual(validateRobloxUsernameSoft(''), { ok: true });
});

test('validateRobloxUsernameSoft returns warning for length < 4', () => {
  const result = validateRobloxUsernameSoft('ab');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /short/i.test(result.warning));
});

test('validateRobloxUsernameSoft returns warning for blocklisted word "team"', () => {
  const result = validateRobloxUsernameSoft('team');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /common english word/i.test(result.warning));
});

test('validateRobloxUsernameSoft returns ok:true for valid username', () => {
  assert.deepEqual(validateRobloxUsernameSoft('Vincent_Feng69'), { ok: true });
});

test('validateRobloxUsernameSoft is case-insensitive for blocklist', () => {
  const result = validateRobloxUsernameSoft('TEAM');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /common english word/i.test(result.warning));
});

test('validateRobloxUsernameSoft returns warning for blocklisted word "ping"', () => {
  const result = validateRobloxUsernameSoft('ping');
  assert.equal(result.ok, false);
});

test('validateRobloxUsernameSoft returns ok:true for 4-char non-blocklisted username', () => {
  assert.deepEqual(validateRobloxUsernameSoft('Cool'), { ok: true });
});

// Schema v2 → v3 migration tests

test('pre-v3 settings file (v2 without calibrationData/tracking) migrates cleanly to v7', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyng-settings-test-prev3-'));
  try {
    const filePath = path.join(dir, 'pyng-settings-test.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        avatar: null,
        hotkey: { accelerator: 'Z', mode: 'hold' },
        firstRunHintShown: false,
        robloxUsername: 'OldUser',
      }),
    );
    const store = createSettingsStore({ cwd: dir, name: 'pyng-settings-test' });
    const s = loadSettings(store);
    assert.equal(s.version, 7);
    assert.equal(s.robloxUsername, 'OldUser');
    assert.equal(s.pingColor, DEFAULT_PING_COLOR);
    assert.equal(s.calibrationData, undefined);
    assert.deepEqual(s.tracking, { fps: 'auto' });
    assert.equal(s.manualTrackingProfile, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy hotkey Z migrates to P once', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyng-settings-test-hotkey-'));
  try {
    const filePath = path.join(dir, 'pyng-settings-test.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 4,
        avatar: null,
        hotkey: { accelerator: 'Z', mode: 'hold' },
        firstRunHintShown: false,
        robloxUsername: '',
        tracking: { fps: 'auto' },
      }),
    );
    const store = createSettingsStore({ cwd: dir, name: 'pyng-settings-test' });
    assert.deepEqual(loadSettings(store).hotkey, { accelerator: 'P', mode: 'hold' });
    assert.deepEqual(getHotkey(store), { accelerator: 'P', mode: 'hold' });
    assert.equal(loadSettings(store).version, 7);
    saveHotkey('Z', 'press', store);
    assert.deepEqual(getHotkey(store), { accelerator: 'Z', mode: 'press' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy press-Z hotkey migrates to press-P', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pyng-settings-test-hotkey-'));
  try {
    const filePath = path.join(dir, 'pyng-settings-test.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 4,
        avatar: null,
        hotkey: { accelerator: 'Z', mode: 'press' },
        firstRunHintShown: false,
        robloxUsername: '',
        tracking: { fps: 'auto' },
      }),
    );
    const store = createSettingsStore({ cwd: dir, name: 'pyng-settings-test' });
    assert.deepEqual(loadSettings(store).hotkey, { accelerator: 'P', mode: 'press' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// manualTrackingProfile tests

test('saveManualTrackingProfile persists manual FOV, DPI, and sensitivity', () => {
  withTempStore((store) => {
    saveManualTrackingProfile(
      { enabled: true, fovH: 103, mouseDpi: 1600, inGameSensitivity: 0.5 },
      store,
    );
    const got = getManualTrackingProfile(store);
    assert.ok(got);
    assert.equal(got.enabled, true);
    assert.equal(got.fovH, 103);
    assert.equal(got.mouseDpi, 1600);
    assert.equal(got.inGameSensitivity, 0.5);
    assert.equal(getManualHorizontalFov(store), 103);
    assert.equal(estimateManualMousePixelsPerDegree(store), 8);
  });
});

test('manual tracking profile is ignored when disabled', () => {
  withTempStore((store) => {
    saveManualTrackingProfile(
      { enabled: false, fovH: 103, mouseDpi: 1600, inGameSensitivity: 0.5 },
      store,
    );
    assert.equal(getManualHorizontalFov(store), null);
    assert.equal(estimateManualMousePixelsPerDegree(store), null);
  });
});

test('saveManualTrackingProfile validates numeric ranges', () => {
  withTempStore((store) => {
    assert.throws(
      () =>
        saveManualTrackingProfile(
          { enabled: true, fovH: 10, mouseDpi: 800, inGameSensitivity: 1 },
          store,
        ),
      /manual tracking fov/,
    );
    assert.throws(
      () =>
        saveManualTrackingProfile(
          { enabled: true, fovH: 90, mouseDpi: 10, inGameSensitivity: 1 },
          store,
        ),
      /manual tracking dpi/,
    );
    assert.throws(
      () =>
        saveManualTrackingProfile(
          { enabled: true, fovH: 90, mouseDpi: 800, inGameSensitivity: 0 },
          store,
        ),
      /manual tracking sensitivity/,
    );
  });
});

// saveCalibrationData / getCalibrationData tests

test('saveCalibrationData persists and getCalibrationData reads it back', () => {
  withTempStore((store) => {
    const data = { pixelsPerDegree: 10.5, mousePixelsPerDegree: 9.2, calibratedAt: 1700000000000 };
    saveCalibrationData(data, store);
    const got = getCalibrationData(store);
    assert.ok(got);
    assert.equal(got.pixelsPerDegree, 10.5);
    assert.equal(got.mousePixelsPerDegree, 9.2);
    assert.equal(got.calibratedAt, 1700000000000);
  });
});

test('getCalibrationData returns null when no calibration saved', () => {
  withTempStore((store) => {
    assert.equal(getCalibrationData(store), null);
  });
});

// saveTrackingFps / getTrackingFps tests

test('saveTrackingFps with auto persists and getTrackingFps reads it back', () => {
  withTempStore((store) => {
    saveTrackingFps('auto', store);
    assert.equal(getTrackingFps(store), 'auto');
  });
});

test('saveTrackingFps with 10 persists and getTrackingFps reads it back', () => {
  withTempStore((store) => {
    saveTrackingFps(10, store);
    assert.equal(getTrackingFps(store), 10);
  });
});

test('saveTrackingFps with 15 persists and getTrackingFps reads it back', () => {
  withTempStore((store) => {
    saveTrackingFps(15, store);
    assert.equal(getTrackingFps(store), 15);
  });
});

test('saveTrackingFps with 30 persists and getTrackingFps reads it back', () => {
  withTempStore((store) => {
    saveTrackingFps(30, store);
    assert.equal(getTrackingFps(store), 30);
  });
});

test('saveTrackingFps with 60 persists and getTrackingFps reads it back', () => {
  withTempStore((store) => {
    saveTrackingFps(60, store);
    assert.equal(getTrackingFps(store), 60);
  });
});

test('saveTrackingFps throws on invalid value', () => {
  withTempStore((store) => {
    // @ts-expect-error invalid fps value for test
    assert.throws(() => saveTrackingFps(120, store), /invalid tracking fps/);
  });
});

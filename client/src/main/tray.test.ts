// These tests require Electron's `Tray`, `Menu`, `nativeImage`, and
// `BrowserWindow` APIs. Same pattern as avatarNormalize.test.ts — defer
// electron-binding imports to inside the test body and skip under plain Node
// so `npm test` stays green; run via `npm run test:electron`.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isElectron = typeof process.versions.electron === 'string';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.resolve(HERE, '..', '..', 'build', 'tray-iconTemplate.png');

test('tray icon asset exists at the path tray.ts references', () => {
  assert.equal(existsSync(ICON_PATH), true, `expected tray icon at ${ICON_PATH}`);
});

test('createTray constructs and destroys cleanly', { skip: !isElectron }, async () => {
  const { createTray } = await import('./tray.js');
  const handle = createTray(() => null);
  try {
    assert.equal(handle.tray.isDestroyed(), false);
    assert.equal(handle.tray.listenerCount('click'), 1);
    assert.ok(typeof handle.destroy === 'function');
  } finally {
    handle.destroy();
  }
  assert.equal(handle.tray.isDestroyed(), true);
});

test(
  'createTray getDashboard callback captures the registered window',
  { skip: !isElectron },
  async () => {
    const { createTray } = await import('./tray.js');
    const { BrowserWindow } = await import('electron');
    const win = new BrowserWindow({ show: false, width: 100, height: 100 });
    try {
      const handle = createTray(() => win);
      try {
        // Click-to-show behavior can't be simulated without a real UI session;
        // full coverage lives in the manual smoke checklist. We're only
        // verifying the construction path here.
        assert.equal(handle.tray.isDestroyed(), false);
      } finally {
        handle.destroy();
      }
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  },
);

test('destroy is idempotent', { skip: !isElectron }, async () => {
  const { createTray } = await import('./tray.js');
  const handle = createTray(() => null);
  handle.destroy();
  handle.destroy();
  assert.equal(handle.tray.isDestroyed(), true);
});

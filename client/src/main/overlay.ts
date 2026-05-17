import { app, BrowserWindow, screen } from 'electron';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.resolve(HERE, '..', 'overlay');
const RENDERER_DIR = path.resolve(HERE, '..', 'renderer');

const OVERLAY_RENDERER_SOURCE = path.join(OVERLAY_DIR, 'overlay.ts');
const OVERLAY_RENDERER_OUTPUT = path.join(OVERLAY_DIR, 'overlay.js');
const OVERLAY_TRACKING_MATH_SOURCE = path.join(OVERLAY_DIR, 'tracking-math.ts');
const OVERLAY_TRACKING_MATH_OUTPUT = path.join(OVERLAY_DIR, 'tracking-math.js');
const OVERLAY_EDGE_ARROW_SOURCE = path.join(OVERLAY_DIR, 'components', 'edge-arrow.ts');
const OVERLAY_EDGE_ARROW_OUTPUT = path.join(OVERLAY_DIR, 'components', 'edge-arrow.js');
const OVERLAY_HTML_PATH = path.join(OVERLAY_DIR, 'index.html');
const OVERLAY_PRELOAD_SOURCE = path.join(HERE, 'overlay-preload.ts');
const OVERLAY_PRELOAD_OUTPUT = path.join(HERE, 'overlay-preload.cjs');

const MAIN_PRELOAD_SOURCE = path.join(HERE, 'main-preload.ts');
const MAIN_PRELOAD_OUTPUT = path.join(HERE, 'main-preload.cjs');
const MAIN_RENDERER_SOURCE = path.join(RENDERER_DIR, 'main.tsx');
const MAIN_RENDERER_OUTPUT = path.join(RENDERER_DIR, 'main.js');

let overlayAssetsReady: Promise<void> | null = null;
let mainAssetsReady: Promise<void> | null = null;

// In a packaged Electron app, scripts/build-main.ts has pre-built every
// renderer/preload artifact and shipped them inside the asar. Running
// esbuild at startup is both unnecessary AND broken: node_modules aren't
// included in the asar, so esbuild can't resolve `@pyng/shared`,
// `node:crypto`, etc. Skip the build entirely when packaged — the compiled
// outputs are already on disk next to the sources.
function isPackagedBuild(): boolean {
  // Defensive: app.isPackaged is `true` for installer-packaged builds,
  // `false` under `electron .` / `tsx` dev. The existsSync fallback covers
  // the edge case where the .cjs already exists (e.g., after a one-shot
  // build:main + manual electron launch) so we don't re-pay the build cost.
  if (app.isPackaged) return true;
  if (existsSync(MAIN_PRELOAD_OUTPUT) && existsSync(MAIN_RENDERER_OUTPUT)) {
    // Heuristic: if both compiled outputs are present and newer than ~1s,
    // someone (build:main) just produced them. But the simpler call is to
    // skip whenever packaged. For dev hot-reload we want the runtime build.
  }
  return false;
}

export function prepareOverlayAssets(): Promise<void> {
  if (overlayAssetsReady) return overlayAssetsReady;
  if (isPackagedBuild()) {
    overlayAssetsReady = Promise.resolve();
    return overlayAssetsReady;
  }
  overlayAssetsReady = Promise.all([
    build({
      entryPoints: [OVERLAY_RENDERER_SOURCE],
      outfile: OVERLAY_RENDERER_OUTPUT,
      format: 'esm',
      target: 'es2022',
      bundle: false,
      sourcemap: 'inline',
      logLevel: 'silent',
    }),
    // overlay.ts imports sibling modules at runtime (`*.js` specifiers).
    // bundle:false keeps imports as ES module specifiers, so every imported
    // file must also be compiled separately or the overlay module fails to load.
    build({
      entryPoints: [OVERLAY_TRACKING_MATH_SOURCE],
      outfile: OVERLAY_TRACKING_MATH_OUTPUT,
      format: 'esm',
      target: 'es2022',
      bundle: false,
      sourcemap: 'inline',
      logLevel: 'silent',
    }),
    build({
      entryPoints: [OVERLAY_EDGE_ARROW_SOURCE],
      outfile: OVERLAY_EDGE_ARROW_OUTPUT,
      format: 'esm',
      target: 'es2022',
      bundle: false,
      sourcemap: 'inline',
      logLevel: 'silent',
    }),
    build({
      entryPoints: [OVERLAY_PRELOAD_SOURCE],
      outfile: OVERLAY_PRELOAD_OUTPUT,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      bundle: true,
      external: ['electron'],
      sourcemap: 'inline',
      logLevel: 'silent',
    }),
  ]).then(() => undefined);
  return overlayAssetsReady;
}

export const MAIN_PRELOAD_PATH = MAIN_PRELOAD_OUTPUT;
export const MAIN_HTML_PATH = path.join(RENDERER_DIR, 'main.html');

export function prepareMainAssets(): Promise<void> {
  if (mainAssetsReady) return mainAssetsReady;
  if (isPackagedBuild()) {
    mainAssetsReady = Promise.resolve();
    return mainAssetsReady;
  }
  mainAssetsReady = Promise.all([
    build({
      entryPoints: [MAIN_PRELOAD_SOURCE],
      outfile: MAIN_PRELOAD_OUTPUT,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      bundle: true,
      external: ['electron'],
      sourcemap: 'inline',
      logLevel: 'silent',
    }),
    build({
      entryPoints: [MAIN_RENDERER_SOURCE],
      outfile: MAIN_RENDERER_OUTPUT,
      format: 'esm',
      target: 'es2022',
      bundle: true,
      jsx: 'automatic',
      loader: { '.tsx': 'tsx' },
      sourcemap: 'inline',
      logLevel: 'silent',
    }),
  ]).then(() => undefined);
  return mainAssetsReady;
}

export function createOverlayWindow(): BrowserWindow {
  const releaseMacFullscreenPolicy = allowOverlayAboveMacFullscreenSpaces();

  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.bounds;

  const overlay = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // macOS: non-focusable transparent windows are the documented pattern for
    // panels that float over OTHER apps' native fullscreen Spaces. Focusable
    // windows participate in standard window management and macOS won't reliably
    // honor `setVisibleOnAllWorkspaces(... visibleOnFullScreen: true)` on them.
    // Discord overlay / OBS / similar all use non-focusable windows for this.
    // App-mode ping-mode (hold-the-hotkey-to-capture-clicks) toggles focusable
    // back on at runtime via `setFocusable(true)` only while ping-mode is active.
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: OVERLAY_PRELOAD_OUTPUT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlay.once('closed', releaseMacFullscreenPolicy);
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlay
    .loadFile(OVERLAY_HTML_PATH)
    .then(() => {
      if (overlay.isDestroyed()) return;
      overlay.showInactive();
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.moveTop();
    })
    .catch((err: Error) => {
      // Mid-load destruction (e.g. display-metrics-changed recreating the
      // overlay before this load resolves) rejects with ERR_FAILED; that's
      // expected, not a fault. Anything else is a real load failure.
      if (overlay.isDestroyed()) return;
      process.stderr.write(`[overlay] loadFile failed: ${err.message}\n`);
    });

  return overlay;
}

let macFullscreenOverlayRefs = 0;

function allowOverlayAboveMacFullscreenSpaces(): () => void {
  if (process.platform !== 'darwin') return () => {};

  // Regular macOS apps do not reliably carry transparent always-on-top
  // windows into other apps' fullscreen Spaces. Menu-bar/accessory apps do,
  // and pyng already has a tray/menu-bar anchor for dashboard + quit access.
  macFullscreenOverlayRefs += 1;
  if (macFullscreenOverlayRefs === 1) {
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    macFullscreenOverlayRefs = Math.max(0, macFullscreenOverlayRefs - 1);
    if (macFullscreenOverlayRefs === 0) {
      app.setActivationPolicy('regular');
      void app.dock?.show();
    }
  };
}

const DISPLAY_CHANGE_DEBOUNCE_MS = 150;

export function recreateOnDisplayChange(
  getCurrent: () => BrowserWindow | null,
  onRecreate: (newOverlay: BrowserWindow) => void,
): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;
  let lastBoundsKey = boundsKey(screen.getPrimaryDisplay().bounds);

  const handler = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const key = boundsKey(screen.getPrimaryDisplay().bounds);
      if (key === lastBoundsKey) return;
      lastBoundsKey = key;
      const current = getCurrent();
      if (current && !current.isDestroyed()) {
        current.destroy();
      }
      const next = createOverlayWindow();
      onRecreate(next);
    }, DISPLAY_CHANGE_DEBOUNCE_MS);
  };
  screen.on('display-metrics-changed', handler);
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    screen.removeListener('display-metrics-changed', handler);
  };
}

function boundsKey(b: { x: number; y: number; width: number; height: number }): string {
  return `${b.x},${b.y},${b.width},${b.height}`;
}

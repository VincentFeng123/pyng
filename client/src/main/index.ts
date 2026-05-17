import { app, type BrowserWindow, globalShortcut, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvelope, type OverlayShowPingPayload } from '@pyng/shared';
import { IPC_CHANNELS } from '@pyng/shared';
import { checkAccessibilityPermission, showAccessibilityPrompt } from './accessibility.js';
import { loadConfig } from './config.js';
import { WsClient } from './net/wsClient.js';
import { runGenerateFlow, runRedeemFlow, PairInvalidError, type FlowMode } from './pairingFlow.js';
import {
  createOverlayWindow,
  prepareMainAssets,
  prepareOverlayAssets,
  recreateOnDisplayChange,
} from './overlay.js';
import { echoLocalPing, wireOverlayIpc } from './overlayBridge.js';
import { PeerAvatarStore } from './peerAvatars.js';
import {
  loadSettings,
  getRobloxUsername,
  getPingColor,
  getCalibrationData,
  getTrackingFps,
  getManualHorizontalFov,
  estimateManualMousePixelsPerDegree,
} from './settings.js';
import { DEFAULT_PIXELS_PER_DEGREE, DEFAULT_MOUSE_PIXELS_PER_DEGREE } from './settings.js';
import { registerSettingsIpc } from './settings-ipc.js';
import { createMainWindow, destroyMainWindow, getMainWindow } from './main-window.js';
import { PairStateMachine } from './state-machine.js';
import { registerPairIpc, registerSoloPairIpc } from './pair-ipc.js';
import { createDevStatusWindow } from './dev-status-window.js';
import {
  registerHotkey,
  registerKeyboardMovementListener,
  registerMouseDeltaListener,
} from './input/hotkey.js';
import { wireInput } from './input/input-bridge.js';
import { V2_PING_COOLDOWN_MS, V2_PING_TTL_MS } from './input/ping-mode.js';
import { createTray } from './tray.js';
import { checkScreenRecordingPermission, showScreenRecordingPrompt } from './screenRecording.js';
import { OcrLoop } from './ocr/ocrLoop.js';
import {
  PeerUsernameStore,
  publishOwnUsername,
  republishOnUsernameChange,
} from './matching/peerUsername.js';
import { UsernameMatcher } from './matching/matcher.js';
import {
  registerCalibrationHandlers,
  setCalibrationTrackingLoop,
  notifyCalibrationMouseDelta,
} from './tracking/calibration-handler.js';
import { TrackingLoop } from './tracking/tracking-loop.js';
import { PingTracker } from './tracking/ping-tracker.js';
import { ConfidenceEstimator } from './tracking/confidence.js';
import { loadGameConfig, getMaskRegions, computeFovV } from './tracking/game-masks.js';
import { warmup } from './tracking/motion-estimator.js';

type Config =
  | { ok: true; mode: 'app' }
  | { ok: true; mode: 'solo' }
  | { ok: true; mode: 'legacy-generate'; serverUrl: string; overlay: boolean; devStatus: boolean }
  | {
      ok: true;
      mode: 'legacy-redeem';
      serverUrl: string;
      code: string;
      overlay: boolean;
      devStatus: boolean;
    }
  | { ok: false; error: string };

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function flagPresent(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseConfig(): Config {
  if (flagPresent('solo') || process.env.SOLO === '1') {
    return { ok: true, mode: 'solo' };
  }

  // Legacy CLI opt-in path. Preserves the v0/v1 one-shot pairing flow used by
  // `scripts/dev.ts`, `scripts/dev-peer.ts`, and the mock-peer regression tests.
  // v2 default launch (no flag, no env) boots the IPC-driven state machine
  // and opens the main UI window instead.
  if (flagPresent('legacy-cli') || process.env.LEGACY_CLI === '1') {
    const modeRaw = (parseFlag('mode') ?? process.env.MODE ?? '').toLowerCase();
    const serverUrl = parseFlag('server') ?? process.env.SERVER_URL ?? 'ws://localhost:7788';
    const overlay = flagPresent('overlay') || process.env.OVERLAY === '1';
    const devStatus = flagPresent('dev-status') || process.env.DEV_STATUS === '1';

    if (modeRaw !== 'generate' && modeRaw !== 'redeem') {
      return {
        ok: false,
        error: `--legacy-cli requires MODE='generate' or 'redeem' (got '${modeRaw}')`,
      };
    }

    if (modeRaw === 'redeem') {
      const code = (parseFlag('code') ?? process.env.CODE ?? '').toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) {
        return {
          ok: false,
          error: `CODE must be a 6-character alphanumeric code (got '${code}')`,
        };
      }
      return { ok: true, mode: 'legacy-redeem', serverUrl, code, overlay, devStatus };
    }
    return { ok: true, mode: 'legacy-generate', serverUrl, overlay, devStatus };
  }

  return { ok: true, mode: 'app' };
}

function makeLogger(prefix: string): (line: string) => void {
  return (line) => process.stdout.write(`${prefix} ${line}\n`);
}

function screenOnlyTrackingEnabled(): boolean {
  if (process.env.PYNG_ENABLE_MOUSE_TRACKING === '1') return false;
  return (
    process.env.PYNG_SCREEN_ONLY_TRACKING === '1' || process.env.PYNG_DISABLE_MOUSE_TRACKING === '1'
  );
}

// Temporary kill switch: leave the tracking implementation intact, but keep it
// out of the app path unless explicitly re-enabled while iterating.
const TRACKING_ENABLED = process.env.PYNG_ENABLE_TRACKING === '1';

function trackingFovH(): number {
  const manualFov = getManualHorizontalFov();
  if (manualFov !== null) return manualFov;
  try {
    const cfg = loadGameConfig('phantom-forces');
    return cfg.fovH;
  } catch {
    return 90;
  }
}

function trackingFovV(width: number, height: number): number {
  const fovH = trackingFovH();
  try {
    const cfg = loadGameConfig('phantom-forces');
    if (getManualHorizontalFov() === null && cfg.fovV !== null) return cfg.fovV;
    return computeFovV(fovH, width, height);
  } catch {
    return computeFovV(fovH, width, height);
  }
}

type OverlayBounds = { width: number; height: number };
const FALLBACK_OVERLAY_BOUNDS: OverlayBounds = { width: 1920, height: 1080 };

function getSafeOverlayBounds(overlay: BrowserWindow | null | undefined): OverlayBounds {
  if (!overlay || overlay.isDestroyed()) return { ...FALLBACK_OVERLAY_BOUNDS };
  const b = overlay.getContentBounds();
  return { width: b.width, height: b.height };
}

function trackingMousePixelsPerDegree(): number {
  const manual = estimateManualMousePixelsPerDegree();
  if (manual !== null) return manual;
  const data = getCalibrationData();
  return data?.mousePixelsPerDegree ?? DEFAULT_MOUSE_PIXELS_PER_DEGREE;
}

function trackingFovLearningEnabled(): boolean {
  return getManualHorizontalFov() === null;
}

async function runSoloMode(): Promise<void> {
  const log = makeLogger('[client:solo]');
  log('preparing main + overlay assets');
  await Promise.all([prepareMainAssets(), prepareOverlayAssets()]);

  if (TRACKING_ENABLED) {
    // Warm up native OpenCV BEFORE the tracking loop's first frame so the first
    // visible ping does not pay the module load cost. Solo mode lets us test
    // the tracking pipeline end-to-end without a paired peer + spectator gate.
    try {
      await warmup();
      log('opencv warmup complete');
    } catch (err) {
      log(`opencv warmup failed: ${String(err)}; tracking will be disabled`);
    }
  } else {
    log('tracking disabled temporarily (set PYNG_ENABLE_TRACKING=1 to re-enable)');
  }

  const overlay = createOverlayWindow();
  log('overlay opened');

  const settings = loadSettings();
  const selfAvatar = settings.avatar?.imageBase64 ?? null;

  // Solo mode is a test/demo rig. Hardcode P so the user has a deterministic
  // hotkey regardless of their saved settings.hotkey.accelerator. The full
  // app-mode flow still honors the user's configured hotkey via settings.
  const accessAccelerator = 'P';

  // --- Solo-mode tracking subsystem ---
  // Mirror the runAppMode wiring but start unconditionally — there's no pair
  // or spectator state to gate on. Lets the user test ping direction-locking
  // in any game just by running dev:solo + pressing P.
  const pingTracker = new PingTracker();
  const confidenceEstimator = new ConfidenceEstimator();
  const screenOnlyTracking = screenOnlyTrackingEnabled();
  let shuttingDown = false;

  const trackingLoop = new TrackingLoop({
    pingTracker,
    confidence: confidenceEstimator,
    emitPositionUpdate: (payload) => {
      if (!overlay.isDestroyed()) {
        overlay.webContents.send(IPC_CHANNELS.OVERLAY_UPDATE_PING_POSITION, payload);
      }
    },
    getOverlayBounds: () => {
      return getSafeOverlayBounds(overlay);
    },
    getMaskRegions: () => {
      try {
        const cfg = loadGameConfig('phantom-forces');
        return getMaskRegions(cfg);
      } catch {
        return [];
      }
    },
    getFovH: () => {
      return trackingFovH();
    },
    getFovV: () => {
      const b = getSafeOverlayBounds(overlay);
      return trackingFovV(b.width, b.height);
    },
    getPixelsPerDegree: () => {
      const data = getCalibrationData();
      return data?.pixelsPerDegree ?? DEFAULT_PIXELS_PER_DEGREE;
    },
    getMousePixelsPerDegree: () => {
      return trackingMousePixelsPerDegree();
    },
    getTrackingFps,
    getFovLearningEnabled: trackingFovLearningEnabled,
    mouseTrackingEnabled: TRACKING_ENABLED && !screenOnlyTracking,
  });

  const unregisterMouseListener =
    !TRACKING_ENABLED || screenOnlyTracking
      ? () => {}
      : registerMouseDeltaListener((dx, dy, eventTimeNs) => {
          if (shuttingDown || overlay.isDestroyed()) return;
          if (!trackingLoop.applyMouseDelta(dx, dy, eventTimeNs)) {
            confidenceEstimator.recordMouseDelta(dx, dy);
          }
          notifyCalibrationMouseDelta(dx, dy);
        });
  const unregisterKeyboardListener = TRACKING_ENABLED
    ? registerKeyboardMovementListener((state) => {
        if (shuttingDown || overlay.isDestroyed()) return;
        trackingLoop.applyKeyboardState(state, state.eventTimeNs);
      })
    : () => {};
  if (TRACKING_ENABLED && screenOnlyTracking) {
    log('screen-only tracking enabled; mouse deltas ignored');
  }

  setCalibrationTrackingLoop(trackingLoop, unregisterMouseListener);
  const unsubPairIpc = registerSoloPairIpc();
  const unsubSettingsIpc = registerSettingsIpc();
  const unsubCalibrationHandlers = registerCalibrationHandlers(() => getMainWindow());

  if (TRACKING_ENABLED) {
    const soloScreenRecording = checkScreenRecordingPermission();
    if (!soloScreenRecording.granted) {
      log(
        'macOS Screen Recording permission not granted; tracking will not move pings. Showing prompt.',
      );
      void showScreenRecordingPrompt();
    } else {
      // Unconditional start — solo skips the spectator-state gate.
      trackingLoop.start();
      log(
        'tracking loop started (native 540p target; Electron fallback capped for input responsiveness)',
      );
    }
  }
  // --- End tracking subsystem ---

  let lastFireAt = 0;
  function firePing(): void {
    if (overlay.isDestroyed()) return;
    const now = Date.now();
    if (now - lastFireAt < V2_PING_COOLDOWN_MS) {
      return;
    }
    lastFireAt = now;
    const cursor = screen.getCursorScreenPoint();
    // Normalize against the overlay's CONTENT bounds, not the display bounds.
    // On macOS the overlay window can be pinned below the menu bar (~24 DIP
    // vertical inset) even though createOverlayWindow asked for the full
    // display bounds. The renderer's `window.innerWidth/Height` reports the
    // content area, so we must match that here — otherwise cursor coords get
    // a proportional Y offset that displaces the chevron tip from the
    // cursor's actual pixel.
    const { x, y, width, height } = overlay.getContentBounds();
    if (width <= 0 || height <= 0) return;
    const normX = Math.min(1, Math.max(0, (cursor.x - x) / width));
    const normY = Math.min(1, Math.max(0, (cursor.y - y) / height));
    const messageId = randomUUID();
    const payload: OverlayShowPingPayload = {
      coords: { x: normX, y: normY },
      color: getPingColor(),
      ttl: V2_PING_TTL_MS,
      messageId,
      receivedAt: Date.now(),
      senderSessionId: 'solo-self',
      avatarBase64: selfAvatar,
    };
    echoLocalPing(
      overlay,
      payload,
      TRACKING_ENABLED ? pingTracker : null,
      TRACKING_ENABLED ? () => trackingLoop.notifyPingAdded() : undefined,
    );
    log(`ping messageId=${messageId} at (${normX.toFixed(3)}, ${normY.toFixed(3)})`);
  }

  // uiohook-napi captures keystrokes at OS-level — works in fullscreen game
  // contexts where Electron's globalShortcut doesn't. Wrap as press-only:
  // onHoldStart fires the ping immediately, onHoldEnd is a no-op since solo
  // doesn't enter overlay-capture mode like paired+hold does.
  let unregisterHotkey: (() => void) | null = null;
  let unregisterGlobalShortcut: (() => void) | null = null;
  const access = checkAccessibilityPermission();
  if (!access.granted) {
    log(`macOS Accessibility permission not granted; hotkey registration skipped. Showing prompt.`);
    void showAccessibilityPrompt();
  } else {
    try {
      unregisterHotkey = registerHotkey(accessAccelerator, {
        onHoldStart: firePing,
        onHoldEnd: () => {
          /* no-op: solo is press-only */
        },
      });
      log(`hotkey registered: ${accessAccelerator} (press to drop ping at cursor)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`hotkey registration failed: ${message}; trying globalShortcut fallback`);
    }
  }
  if (globalShortcut.register(accessAccelerator, firePing)) {
    unregisterGlobalShortcut = () => {
      globalShortcut.unregister(accessAccelerator);
    };
    log(`globalShortcut registered: ${accessAccelerator} (fallback)`);
  } else {
    log(`globalShortcut registration failed: ${accessAccelerator}`);
  }

  const restoreOverlay = (): void => {
    if (shuttingDown || overlay.isDestroyed()) return;
    overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.moveTop();
  };
  const hideOverlayForDashboard = (): void => {
    if (!overlay.isDestroyed()) overlay.hide();
  };

  hideOverlayForDashboard();
  const dashboard = createMainWindow();
  dashboard.on('hide', restoreOverlay);
  dashboard.on('minimize', restoreOverlay);
  log('main window opened (solo)');

  const trayHandle = createTray(() => getMainWindow(), {
    tooltip: 'pyng (solo)',
    beforeOpenDashboard: hideOverlayForDashboard,
  });
  log('tray icon created (solo dashboard)');

  const cleanup = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown (${signal})`);
    if (unregisterHotkey) unregisterHotkey();
    if (unregisterGlobalShortcut) unregisterGlobalShortcut();
    unregisterMouseListener();
    unregisterKeyboardListener();
    trackingLoop.stop();
    unsubPairIpc();
    unsubSettingsIpc();
    unsubCalibrationHandlers();
    trayHandle.destroy();
    destroyMainWindow();
    if (!overlay.isDestroyed()) overlay.destroy();
  };
  const shutdown = (signal: string): void => {
    cleanup(signal);
    app.exit(0);
  };
  app.once('before-quit', () => cleanup('before-quit'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function runAppMode(): Promise<void> {
  const log = makeLogger('[client]');
  appModeActive = true;
  const config = loadConfig();
  log(`relay=${config.relayUrl} dev=${config.isDev}`);

  log('preparing main + overlay assets');
  await Promise.all([prepareMainAssets(), prepareOverlayAssets()]);

  // Screen Recording permission check (macOS). Deferred prompt so it appears
  // after the main window is open. If denied, the OCR loop is skipped — the
  // user can grant later and restart.
  const screenRecording = checkScreenRecordingPermission();
  if (!screenRecording.granted) {
    log(
      'macOS Screen Recording permission not granted; OCR loop will not start. Showing prompt after window open.',
    );
  }

  const client = new WsClient(log);
  const machine = new PairStateMachine({ client, config, log });
  await machine.start();

  // Test-only entry points. Gated by NODE_ENV=test AND a specific env var so
  // production builds cannot accidentally trigger pairing without user intent.
  // Used by client/test/integration to drive the GUI pair flow from outside
  // the Electron process (renderer-side React UI is not externally driveable
  // without a heavy DOM-testing rig).
  if (process.env.NODE_ENV === 'test') {
    if (process.env.TEST_AUTO_GENERATE === '1') {
      log('TEST_AUTO_GENERATE=1 — invoking machine.requestGenerate()');
      void machine.requestGenerate();
    } else if (process.env.TEST_AUTO_REDEEM) {
      const code = process.env.TEST_AUTO_REDEEM.toUpperCase();
      log(`TEST_AUTO_REDEEM=${code} — invoking machine.requestRedeem()`);
      void machine.requestRedeem(code);
    }
  }

  // --- OCR + username matching singletons ---

  // Dev: worker.ts is compiled to worker.js by esbuild, emitted next to index.ts
  // (or index.cjs in prod). We resolve relative to this module's location.
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const workerScriptPath = path.join(HERE, 'ocr', 'worker.js');

  // langPath: directory where tesseract.js will look for / cache eng.traineddata.
  // In dev, npm workspaces hoist tesseract.js-core to the repo root. In a
  // packaged build, tesseract.js installs its own nested copy AND only that
  // nested path is asar-unpacked (see electron-builder.yml). The top-level
  // node_modules/tesseract.js-core directory does NOT exist after packaging
  // because npm's flattening put the package nested; both asarUnpack patterns
  // in the yml are tried, but only the nested glob has a real target on disk.
  const langPath = config.isDev
    ? path.join(HERE, '..', '..', '..', 'node_modules', 'tesseract.js-core')
    : path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'tesseract.js',
        'node_modules',
        'tesseract.js-core',
      );

  const peerUsernames = new PeerUsernameStore();

  // Register inbound peer:username caching — mirrors peer:avatar registration in state-machine.ts.
  // We track whether the OCR loop is running to handle the late-arrival case (peer's username
  // arrives after pair-established).
  let ocrLoopRunning = false;

  const unsubPeerUsernameListener = client.onMessage((envelope) => {
    if (envelope.type !== 'peer:username') return;
    peerUsernames.set(envelope.payload.sessionId, envelope.payload.robloxUsername);
    log(
      `received peer username sessionId=${envelope.payload.sessionId} username=${envelope.payload.robloxUsername}`,
    );

    // Late-arrival: peer's username arrived after pair-established; start OCR if not running.
    const state = machine.getState();
    if (state.pair.kind === 'paired' && !ocrLoopRunning && screenRecording.granted) {
      const peerUsername = peerUsernames.getPeerUsername(state.pair.sessionId);
      if (peerUsername) {
        log(`[ocr] starting OCR loop (late peer:username arrival) peerUsername=${peerUsername}`);
        ocrLoop.start(peerUsername);
        ocrLoopRunning = true;
        machine.setPeerRobloxUsername(peerUsername);
      }
    }
  });

  const ocrLoop = new OcrLoop({
    workerScriptPath,
    langPath,
    onDetected: (username, confidence) => {
      const state = machine.getState();
      if (state.pair.kind !== 'paired') return;
      log(`[ocr] detected username=${username} confidence=${confidence.toFixed(2)}`);
      client.sendEnvelope(
        createEnvelope(
          'username:announce',
          { detectedUsername: username, confidence, game: 'unknown' },
          { groupId: state.pair.groupId },
        ),
      );
    },
    onLost: () => {
      log('[ocr] peer username lost (debounce elapsed)');
    },
  });

  const matcher = new UsernameMatcher({
    client,
    getOwnUsername: () => getRobloxUsername(),
    getGroupId: () => {
      const s = machine.getState();
      return s.pair.kind === 'paired' ? s.pair.groupId : null;
    },
    onMatchStateChange: (state) => {
      log(`[matcher] spectator state → ${state}`);
      machine.setSpectatorState(state);
    },
  });

  const unsubMatcher = matcher.start();

  const unsubUsernameChange = republishOnUsernameChange(client, machine, peerUsernames, log);

  // --- End OCR + username matching singletons ---

  const unsubPairIpc = registerPairIpc(machine);
  const unsubSettingsIpc = registerSettingsIpc();

  // --- Tracking subsystem singletons ---
  const pingTracker = new PingTracker();
  const confidenceEstimator = new ConfidenceEstimator();
  const screenOnlyTracking = screenOnlyTrackingEnabled();
  let shuttingDown = false;

  const trackingLoop = new TrackingLoop({
    pingTracker,
    confidence: confidenceEstimator,
    emitPositionUpdate: (payload) => {
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send(IPC_CHANNELS.OVERLAY_UPDATE_PING_POSITION, payload);
      }
    },
    getOverlayBounds: () => {
      return getSafeOverlayBounds(overlay);
    },
    getMaskRegions: () => {
      try {
        const cfg = loadGameConfig('phantom-forces');
        return getMaskRegions(cfg);
      } catch {
        return [];
      }
    },
    getFovH: () => {
      return trackingFovH();
    },
    getFovV: () => {
      const b = getSafeOverlayBounds(overlay);
      return trackingFovV(b.width, b.height);
    },
    getPixelsPerDegree: () => {
      const data = getCalibrationData();
      return data?.pixelsPerDegree ?? DEFAULT_PIXELS_PER_DEGREE;
    },
    getMousePixelsPerDegree: () => {
      return trackingMousePixelsPerDegree();
    },
    getTrackingFps,
    getFovLearningEnabled: trackingFovLearningEnabled,
    mouseTrackingEnabled: TRACKING_ENABLED && !screenOnlyTracking,
  });

  const unregisterMouseListener =
    !TRACKING_ENABLED || screenOnlyTracking
      ? () => {}
      : registerMouseDeltaListener((dx, dy, eventTimeNs) => {
          if (shuttingDown || !overlay || overlay.isDestroyed()) return;
          if (
            machine.getState().pair.kind !== 'paired' ||
            !trackingLoop.applyMouseDelta(dx, dy, eventTimeNs)
          ) {
            confidenceEstimator.recordMouseDelta(dx, dy);
          }
          notifyCalibrationMouseDelta(dx, dy);
        });
  const unregisterKeyboardListener = TRACKING_ENABLED
    ? registerKeyboardMovementListener((state) => {
        if (shuttingDown || !overlay || overlay.isDestroyed()) return;
        if (machine.getState().pair.kind !== 'paired') return;
        trackingLoop.applyKeyboardState(state, state.eventTimeNs);
      })
    : () => {};
  if (!TRACKING_ENABLED) {
    log('[tracking] disabled temporarily (set PYNG_ENABLE_TRACKING=1 to re-enable)');
  } else if (screenOnlyTracking) {
    log('[tracking] screen-only tracking enabled; mouse deltas ignored');
  }

  setCalibrationTrackingLoop(trackingLoop, unregisterMouseListener);

  const unsubCalibrationHandlers = registerCalibrationHandlers(() => getMainWindow());

  let trackingActive = false;
  const unsubTracking = machine.subscribe((state) => {
    const shouldTrack = TRACKING_ENABLED && state.pair.kind === 'paired';
    if (shouldTrack && !trackingActive) {
      trackingLoop.start();
      trackingActive = true;
      log('[tracking] started (paired)');
    } else if (!shouldTrack && trackingActive) {
      trackingLoop.stop();
      trackingActive = false;
      log('[tracking] stopped');
    }
  });
  // --- End tracking subsystem singletons ---

  // Pre-flight Accessibility check. uiohook silently swallows keyboard
  // events on macOS when permission is missing — the user would never see
  // their pings fire. Surfacing it BEFORE wireInput connects to the state
  // machine means we don't leave a non-functional registration in place.
  // wireInput still runs either way: the hotkey path stays inactive until
  // permission is granted + the user restarts, but the rest of the dashboard
  // (pair flow, settings tab, tray) is fully usable in the meantime.
  const access = checkAccessibilityPermission();
  if (!access.granted) {
    log('macOS Accessibility permission not granted; hotkey will not fire until granted.');
    void showAccessibilityPrompt();
  }

  let overlay: BrowserWindow | null = null;
  let unsubBridge: (() => void) | null = null;
  let unsubDisplay: (() => void) | null = null;

  const unsubInput = wireInput({
    machine,
    client,
    peerAvatars: machine.getPeerAvatars(),
    latency: machine.getLatencyTracker(),
    getOverlay: () => overlay,
    log,
    getPingTracker: () => (TRACKING_ENABLED ? pingTracker : null),
    getTrackingLoop: () => (TRACKING_ENABLED ? trackingLoop : null),
  });

  // Overlay window lifetime is tied to the paired state.
  // Also manages OCR loop and matcher lifecycle on pair transitions.
  const unsubMachine = machine.subscribe((state) => {
    if (state.pair.kind === 'paired' && !overlay) {
      const { sessionId, groupId } = state.pair;
      log(`opening overlay window (groupId=${groupId})`);
      overlay = createOverlayWindow();
      unsubBridge = wireOverlayIpc(
        client,
        overlay,
        log,
        sessionId,
        machine.getPeerAvatars(),
        TRACKING_ENABLED ? pingTracker : null,
        TRACKING_ENABLED ? () => trackingLoop.notifyPingAdded() : undefined,
      );
      unsubDisplay = recreateOnDisplayChange(
        () => overlay,
        (next) => {
          unsubBridge?.();
          overlay = next;
          unsubBridge = wireOverlayIpc(
            client,
            overlay,
            log,
            sessionId,
            machine.getPeerAvatars(),
            TRACKING_ENABLED ? pingTracker : null,
            TRACKING_ENABLED ? () => trackingLoop.notifyPingAdded() : undefined,
          );
          log('overlay recreated after display change');
        },
      );

      // Publish own username on pair.
      publishOwnUsername(client, groupId, sessionId, getRobloxUsername(), log);

      // Start OCR loop if we already know the peer's username and have permission.
      if (screenRecording.granted) {
        const peerUsername = peerUsernames.getPeerUsername(sessionId);
        if (peerUsername && !ocrLoopRunning) {
          log(`[ocr] starting OCR loop peerUsername=${peerUsername}`);
          ocrLoop.start(peerUsername);
          ocrLoopRunning = true;
          machine.setPeerRobloxUsername(peerUsername);
        }
      } else {
        // Show the prompt now that the main window is open.
        showScreenRecordingPrompt(getMainWindow()).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[screenRecording] prompt failed: ${msg}`);
        });
      }
    } else if (state.pair.kind !== 'paired' && overlay) {
      log('closing overlay window (unpaired)');
      unsubBridge?.();
      unsubDisplay?.();
      unsubBridge = null;
      unsubDisplay = null;
      if (!overlay.isDestroyed()) overlay.destroy();
      overlay = null;

      // Tear down OCR + matcher on unpair.
      if (ocrLoopRunning) {
        ocrLoop.stop();
        ocrLoopRunning = false;
      }
      matcher.reset();
      peerUsernames.clear();
      machine.setPeerRobloxUsername(null);
    }
  });

  createMainWindow();
  log('main window opened');

  const trayHandle = createTray(() => getMainWindow());
  log('tray icon created');

  const cleanup = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown (${signal})`);
    unsubInput();
    unsubTracking();
    unregisterMouseListener();
    unregisterKeyboardListener();
    trackingLoop.stop();
    unsubMachine();
    unsubMatcher();
    unsubPeerUsernameListener();
    unsubUsernameChange();
    unsubBridge?.();
    unsubDisplay?.();
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    if (ocrLoopRunning) ocrLoop.stop();
    unsubPairIpc();
    unsubSettingsIpc();
    unsubCalibrationHandlers();
    trayHandle.destroy();
    destroyMainWindow();
    machine.shutdown();
  };
  const shutdown = (signal: string): void => {
    cleanup(signal);
    app.exit(0);
  };
  app.once('before-quit', () => cleanup('before-quit'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  app.on('activate', () => {
    createMainWindow();
  });
}

async function runLegacyFlow(
  flowMode: FlowMode,
  cfg: { serverUrl: string; overlay: boolean; devStatus: boolean; code?: string },
): Promise<void> {
  const log = makeLogger(`[client:${flowMode}]`);
  const client = new WsClient(log);
  const peerAvatars = new PeerAvatarStore();

  // Same peer:avatar listener pattern as v1 — register before pair so
  // server-replayed avatars aren't dropped.
  const unsubAvatarListener = client.onMessage((msg) => {
    if (msg.type !== 'peer:avatar') return;
    peerAvatars.set(msg.payload.sessionId, msg.payload.imageBase64);
    log(
      `received peer avatar sessionId=${msg.payload.sessionId} size=${msg.payload.imageBase64.length}`,
    );
  });

  if (cfg.overlay) {
    log('preparing overlay assets');
    await prepareOverlayAssets();
  }

  try {
    log(`connecting to ${cfg.serverUrl}`);
    await client.connect(cfg.serverUrl);
    log('connected');

    const flowOpts = { postPairHold: !cfg.overlay };
    const { groupId, sessionId } =
      flowMode === 'generate'
        ? await runGenerateFlow(client, log, flowOpts)
        : await runRedeemFlow(client, cfg.code!, log, flowOpts);

    const settings = loadSettings();
    if (settings.avatar) {
      peerAvatars.set(sessionId, settings.avatar.imageBase64);
      const envelope = createEnvelope(
        'peer:avatar',
        { sessionId, imageBase64: settings.avatar.imageBase64 },
        { groupId },
      );
      client.sendEnvelope(envelope);
      log(`published own avatar (size=${settings.avatar.imageBase64.length} bytes)`);
    } else {
      log('no avatar in settings; skipping peer:avatar publish');
    }

    if (!cfg.overlay) {
      unsubAvatarListener();
      client.close(1000);
      log('done');
      app.exit(0);
      return;
    }

    log(`opening overlay window (groupId=${groupId})`);
    let overlay: BrowserWindow = createOverlayWindow();
    let devStatus: BrowserWindow | null = cfg.devStatus
      ? createDevStatusWindow({ groupId, sessionId, serverUrl: cfg.serverUrl })
      : null;
    let unsubBridge = wireOverlayIpc(client, overlay, log, sessionId, peerAvatars);

    const unsubDisplay = recreateOnDisplayChange(
      () => overlay,
      (next) => {
        unsubBridge();
        overlay = next;
        unsubBridge = wireOverlayIpc(client, overlay, log, sessionId, peerAvatars);
        log('overlay recreated after display change');
      },
    );

    const shutdown = (signal: string): void => {
      log(`shutdown (${signal})`);
      unsubAvatarListener();
      unsubBridge();
      unsubDisplay();
      if (!overlay.isDestroyed()) overlay.destroy();
      if (devStatus && !devStatus.isDestroyed()) devStatus.destroy();
      devStatus = null;
      client.close(1000);
      app.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    log('overlay live; SIGINT to exit');
  } catch (err) {
    unsubAvatarListener();
    if (err instanceof PairInvalidError) {
      log(`pair:invalid reason=${err.reason}`);
      client.close(1000);
      app.exit(1);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`fatal: ${message}`);
    client.close(1011);
    app.exit(1);
  }
}

async function main(): Promise<void> {
  const config = parseConfig();
  if (!config.ok) {
    process.stderr.write(`[client] config error: ${config.error}\n`);
    app.exit(1);
    return;
  }

  if (config.mode === 'solo') {
    await runSoloMode();
    return;
  }
  if (config.mode === 'app') {
    if (TRACKING_ENABLED) {
      // Pre-warm native OpenCV so the first tracking frame doesn't block.
      await warmup().catch(() => {
        /* non-fatal — tracking degrades gracefully */
      });
    }
    await runAppMode();
    return;
  }
  if (config.mode === 'legacy-generate') {
    await runLegacyFlow('generate', {
      serverUrl: config.serverUrl,
      overlay: config.overlay,
      devStatus: config.devStatus,
    });
    return;
  }
  await runLegacyFlow('redeem', {
    serverUrl: config.serverUrl,
    overlay: config.overlay,
    devStatus: config.devStatus,
    code: config.code,
  });
}

let appModeActive = false;

app.on('window-all-closed', () => {
  // In app mode the tray is the persistent anchor — even when the main and
  // overlay windows are both hidden/destroyed, the user keeps the app alive
  // via the tray and re-opens the dashboard from there. Quit only via tray
  // "Quit" or explicit signal.
  if (appModeActive) return;
  // Legacy CLI, settings-only, and solo modes: quit when the last window
  // closes (no tray to anchor to). macOS exception preserved for the
  // legacy/settings cases where the dock retains the app.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.whenReady().then(() => {
  void main();
});

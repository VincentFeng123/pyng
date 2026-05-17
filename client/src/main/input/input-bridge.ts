import { type BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import {
  IPC_CHANNELS,
  type InputHotkeyRegistrationErrorPayload,
  type InputRebindHotkeyPayload,
  type OverlayPingModeClickPayload,
} from '@pyng/shared';
import type { LatencyTracker } from '../latency-tracker.js';
import { sendPingDrop } from '../pingSender.js';
import { getPingColor, loadSettings, saveHotkey } from '../settings.js';
import type { WsClient } from '../net/wsClient.js';
import type { PeerAvatarStore } from '../peerAvatars.js';
import type { MachineState, PairStateMachine } from '../state-machine.js';
import type { PingTracker } from '../tracking/ping-tracker.js';
import type { TrackingLoop } from '../tracking/tracking-loop.js';
import { HotkeyParseError, registerHotkey } from './hotkey.js';
import {
  enterPingMode,
  exitPingMode,
  normalizeClickToCoords,
  V2_PING_COOLDOWN_MS,
  V2_PING_TTL_MS,
} from './ping-mode.js';

export type InputBridgeDeps = {
  machine: PairStateMachine;
  client: WsClient;
  peerAvatars: PeerAvatarStore;
  latency: LatencyTracker;
  getOverlay: () => BrowserWindow | null;
  log: (line: string) => void;
  getPingTracker?: () => PingTracker | null;
  getTrackingLoop?: () => TrackingLoop | null;
};

type ActiveBinding = {
  accelerator: string;
  mode: 'hold' | 'press';
  unregister: () => void;
};

/**
 * Wires the global hotkey + ping-mode flow to the state machine and overlay.
 *
 * Lifecycle:
 * - When the state machine transitions to `paired`, register the hotkey from
 *   the user's settings and listen for `OVERLAY_PING_MODE_CLICK` IPC events.
 * - When the state machine leaves `paired` (or shuts down), unregister and
 *   force-exit ping mode so the overlay doesn't stay in click-capture if a
 *   hold was in progress at the time.
 * - When the renderer requests a rebind via `INPUT_REBIND_HOTKEY`, persist
 *   the new accelerator + mode in settings, unregister the old binding, and
 *   register the new one. If registration fails (parse error, OS conflict),
 *   broadcast `INPUT_HOTKEY_REGISTRATION_ERROR` and keep the prior binding.
 */
export function wireInput(deps: InputBridgeDeps): () => void {
  const {
    machine,
    client,
    peerAvatars,
    latency,
    getOverlay,
    log,
    getPingTracker,
    getTrackingLoop,
  } = deps;
  let binding: ActiveBinding | null = null;
  let pendingClickSession = false;
  let lastFireAt = 0;

  const onCooldown = (): boolean => {
    return Date.now() - lastFireAt < V2_PING_COOLDOWN_MS;
  };

  const markFired = (): void => {
    lastFireAt = Date.now();
  };

  const dropBinding = (): void => {
    if (!binding) return;
    binding.unregister();
    binding = null;
  };

  const fireHoldEnd = (overlay: BrowserWindow): void => {
    pendingClickSession = false;
    exitPingMode(overlay);
  };

  const installBinding = (accelerator: string, mode: 'hold' | 'press'): void => {
    dropBinding();
    let unregister: () => void;
    try {
      unregister = registerHotkey(accelerator, {
        onHoldStart: () => {
          const overlay = getOverlay();
          if (!overlay || overlay.isDestroyed()) return;
          if (machine.getState().pair.kind !== 'paired') return;
          if (mode === 'press') {
            // Press-mode: fire immediately at the current cursor position.
            // For v2 we don't actually have a cursor-position read path on
            // press because of Roblox capture; press-mode users are in
            // non-capture contexts where the renderer's last-known cursor
            // is whatever the OS reports. We dispatch via the overlay click
            // path with center-of-screen as a fallback; documented as a
            // best-effort opt-in.
            firePingAtCenter();
            return;
          }
          pendingClickSession = true;
          enterPingMode(overlay);
        },
        onHoldEnd: () => {
          const overlay = getOverlay();
          if (!overlay || overlay.isDestroyed()) return;
          if (mode === 'press') return;
          // Hold released without click is a no-op (the "I changed my mind"
          // affordance). Just exit ping-mode.
          fireHoldEnd(overlay);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`hotkey registration failed: ${message}`);
      broadcastRegistrationError(getOverlay(), accelerator, message);
      return;
    }
    binding = { accelerator, mode, unregister };
    log(`hotkey registered accelerator='${accelerator}' mode='${mode}'`);
  };

  const firePingAtCenter = (): void => {
    const overlay = getOverlay();
    if (!overlay || overlay.isDestroyed()) return;
    const state = machine.getState();
    if (state.pair.kind !== 'paired') return;
    if (onCooldown()) return;
    markFired();
    sendPingDrop({
      client,
      overlay,
      selfSessionId: state.pair.sessionId,
      groupId: state.pair.groupId,
      coords: { x: 0.5, y: 0.5 },
      color: getPingColor(),
      ttl: V2_PING_TTL_MS,
      peerAvatars,
      latency,
      pingTracker: getPingTracker?.() ?? null,
      onPingTracked: () => getTrackingLoop?.()?.notifyPingAdded(),
    });
  };

  // Subscribe to state-machine transitions: install/drop the binding to
  // mirror the paired state.
  const unsubMachine = machine.subscribe((state: MachineState) => {
    if (state.pair.kind === 'paired') {
      if (!binding) {
        const settings = loadSettings();
        installBinding(settings.hotkey.accelerator, settings.hotkey.mode);
      }
      return;
    }
    if (binding) {
      const overlay = getOverlay();
      if (overlay && !overlay.isDestroyed() && pendingClickSession) {
        fireHoldEnd(overlay);
      }
      dropBinding();
    }
  });

  // IPC: renderer reports a click while in ping-mode → main fires the ping
  // and exits ping-mode.
  const onClick = (_event: IpcMainEvent, payload: OverlayPingModeClickPayload): void => {
    const overlay = getOverlay();
    if (!overlay || overlay.isDestroyed()) return;
    if (!pendingClickSession) return; // click outside an active hold session
    const state = machine.getState();
    if (state.pair.kind !== 'paired') {
      fireHoldEnd(overlay);
      return;
    }
    if (onCooldown()) {
      // Cooldown swallows the ping, but we still exit ping-mode — the user
      // released the hotkey expecting a ping, no need to leave the cursor
      // trapped in the overlay.
      fireHoldEnd(overlay);
      return;
    }
    markFired();
    const coords = normalizeClickToCoords(
      payload.pxX,
      payload.pxY,
      payload.screenW,
      payload.screenH,
    );
    sendPingDrop({
      client,
      overlay,
      selfSessionId: state.pair.sessionId,
      groupId: state.pair.groupId,
      coords,
      color: getPingColor(),
      ttl: V2_PING_TTL_MS,
      peerAvatars,
      latency,
      pingTracker: getPingTracker?.() ?? null,
      onPingTracked: () => getTrackingLoop?.()?.notifyPingAdded(),
    });
    fireHoldEnd(overlay);
  };
  ipcMain.on(IPC_CHANNELS.OVERLAY_PING_MODE_CLICK, onClick);

  // IPC: renderer requests a hotkey rebind.
  const onRebind = (_event: IpcMainEvent, payload: InputRebindHotkeyPayload): void => {
    try {
      saveHotkey(payload.accelerator, payload.mode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`hotkey rebind rejected: ${message}`);
      broadcastRegistrationError(getOverlay(), payload.accelerator, message);
      return;
    }
    // Only re-register live if we're currently paired (binding active).
    if (machine.getState().pair.kind === 'paired') {
      installBinding(payload.accelerator, payload.mode);
    }
  };
  ipcMain.on(IPC_CHANNELS.INPUT_REBIND_HOTKEY, onRebind);

  return () => {
    ipcMain.removeListener(IPC_CHANNELS.OVERLAY_PING_MODE_CLICK, onClick);
    ipcMain.removeListener(IPC_CHANNELS.INPUT_REBIND_HOTKEY, onRebind);
    unsubMachine();
    const overlay = getOverlay();
    if (overlay && !overlay.isDestroyed() && pendingClickSession) {
      fireHoldEnd(overlay);
    }
    dropBinding();
  };
}

function broadcastRegistrationError(
  overlay: BrowserWindow | null,
  accelerator: string,
  message: string,
): void {
  if (!overlay || overlay.isDestroyed()) return;
  const payload: InputHotkeyRegistrationErrorPayload = { accelerator, message };
  overlay.webContents.send(IPC_CHANNELS.INPUT_HOTKEY_REGISTRATION_ERROR, payload);
}

// Re-export for tests that need to drive hold events without touching uiohook.
export { HotkeyParseError };

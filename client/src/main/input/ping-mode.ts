import { type BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@pyng/shared';
import { DEFAULT_PING_COLOR } from '../settings.js';

// Default accent for v2 pings. Runtime sends read the user's persisted color.
export const V2_PING_COLOR = DEFAULT_PING_COLOR;
export const V2_PING_TTL_MS = 500;
// Cooldown between successive ping fires — prevents key-repeat / fat-finger
// from double-firing. Intentional taps are well above 150ms apart; key-repeat
// auto-rate on macOS is ~30ms per event so this catches all of them.
export const V2_PING_COOLDOWN_MS = 150;

export function enterPingMode(overlay: BrowserWindow): void {
  if (overlay.isDestroyed()) return;
  overlay.setIgnoreMouseEvents(false);
  overlay.webContents.send(IPC_CHANNELS.OVERLAY_ENTER_PING_MODE, {});
}

export function exitPingMode(overlay: BrowserWindow): void {
  if (overlay.isDestroyed()) return;
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.webContents.send(IPC_CHANNELS.OVERLAY_EXIT_PING_MODE, {});
}

export function normalizeClickToCoords(
  pxX: number,
  pxY: number,
  screenW: number,
  screenH: number,
): { x: number; y: number } {
  if (screenW <= 0 || screenH <= 0) {
    return { x: 0.5, y: 0.5 };
  }
  return {
    x: Math.min(1, Math.max(0, pxX / screenW)),
    y: Math.min(1, Math.max(0, pxY / screenH)),
  };
}

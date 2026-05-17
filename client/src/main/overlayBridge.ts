import type { BrowserWindow } from 'electron';
import { screen } from 'electron';
import { IPC_CHANNELS, type OverlayShowPingPayload } from '@pyng/shared';
import type { WsClient } from './net/wsClient.js';
import type { PeerAvatarStore } from './peerAvatars.js';
import type { PingTracker } from './tracking/ping-tracker.js';
import { loadGameConfig, computeFovV } from './tracking/game-masks.js';

export type WireOverlayIpcOptions = {
  client: WsClient;
  overlay: BrowserWindow;
  log: (line: string) => void;
  selfSessionId: string;
  peerAvatars: PeerAvatarStore;
  pingTracker?: PingTracker | null;
  onPingTracked?: () => void;
};

export function wireOverlayIpc(
  client: WsClient,
  overlay: BrowserWindow,
  log: (line: string) => void,
  selfSessionId: string,
  peerAvatars: PeerAvatarStore,
  pingTracker?: PingTracker | null,
  onPingTracked?: () => void,
): () => void {
  return client.onMessage((msg) => {
    if (overlay.isDestroyed()) return;

    if (msg.type === 'ping:drop') {
      if (msg.payload.senderSessionId === selfSessionId) {
        // Server should exclude us from broadcast. Belt-and-suspenders: if a ping
        // claiming our own sessionId ever arrives, the local echo path already
        // showed it — don't double-render.
        log(`ping suppressed (self-claim) messageId=${msg.messageId}`);
        return;
      }
      const coords = devPingAtCursor(overlay) ?? msg.payload.coords;
      const payload: OverlayShowPingPayload = {
        coords,
        color: msg.payload.color,
        ttl: msg.payload.ttl,
        messageId: msg.messageId,
        receivedAt: Date.now(),
        senderSessionId: msg.payload.senderSessionId,
        avatarBase64: peerAvatars.get(msg.payload.senderSessionId),
      };

      log(
        `forwarding ping to overlay messageId=${msg.messageId} hasAvatar=${payload.avatarBase64 !== null}`,
      );
      overlay.webContents.send(IPC_CHANNELS.OVERLAY_SHOW_PING, payload);
      log(`ping received messageId=${msg.messageId}`);

      if (pingTracker != null) {
        const bounds = overlay.getContentBounds();
        if (bounds.width > 0 && bounds.height > 0) {
          try {
            const cfg = loadGameConfig('phantom-forces');
            const fovV = cfg.fovV ?? computeFovV(cfg.fovH, bounds.width, bounds.height);
            const screenX = coords.x * bounds.width;
            const screenY = coords.y * bounds.height;
            pingTracker.addPing(
              msg.messageId,
              screenX,
              screenY,
              bounds.width,
              bounds.height,
              cfg.fovH,
              fovV,
              msg.payload.ttl ?? 2500,
              msg.payload.senderSessionId,
            );
            onPingTracked?.();
          } catch (err) {
            log(`[tracking] addPing failed: ${String(err)}`);
          }
        }
      }
      return;
    }

    if (msg.type === 'ping:clear') {
      overlay.webContents.send(IPC_CHANNELS.OVERLAY_CLEAR_PINGS, {});
      return;
    }
  });
}

export function echoLocalPing(
  overlay: BrowserWindow,
  payload: OverlayShowPingPayload,
  pingTracker?: PingTracker | null,
  onPingTracked?: () => void,
): void {
  if (overlay.isDestroyed()) return;

  overlay.webContents.send(IPC_CHANNELS.OVERLAY_SHOW_PING, payload);

  if (pingTracker != null) {
    const bounds = overlay.getContentBounds();
    if (bounds.width > 0 && bounds.height > 0) {
      try {
        const cfg = loadGameConfig('phantom-forces');
        const fovV = cfg.fovV ?? computeFovV(cfg.fovH, bounds.width, bounds.height);
        const screenX = payload.coords.x * bounds.width;
        const screenY = payload.coords.y * bounds.height;
        pingTracker.addPing(
          payload.messageId,
          screenX,
          screenY,
          bounds.width,
          bounds.height,
          cfg.fovH,
          fovV,
          payload.ttl ?? 2500,
          payload.senderSessionId,
        );
        onPingTracked?.();
      } catch {
        // suppress — echoLocalPing is a fire-and-forget path
      }
    }
  }
}

function devPingAtCursor(overlay: BrowserWindow): { x: number; y: number } | null {
  if (process.env.DEV_PING_AT_CURSOR !== '1') return null;
  const cursor = screen.getCursorScreenPoint();
  const bounds = overlay.getBounds();
  return {
    x: clamp01((cursor.x - bounds.x) / bounds.width),
    y: clamp01((cursor.y - bounds.y) / bounds.height),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

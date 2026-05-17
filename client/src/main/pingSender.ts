import type { BrowserWindow } from 'electron';
import { createEnvelope, type OverlayShowPingPayload } from '@pyng/shared';
import type { LatencyTracker } from './latency-tracker.js';
import type { WsClient } from './net/wsClient.js';
import { echoLocalPing } from './overlayBridge.js';
import type { PeerAvatarStore } from './peerAvatars.js';
import type { PingTracker } from './tracking/ping-tracker.js';

export type SendPingDropOptions = {
  client: WsClient;
  overlay: BrowserWindow;
  selfSessionId: string;
  groupId: string;
  coords: { x: number; y: number };
  color: string;
  ttl: number;
  peerAvatars: PeerAvatarStore;
  // Optional. When provided, the messageId is recorded as in-flight at send
  // time so an incoming `ping:ack` from the server can produce a round-trip
  // sample. Omitted in solo mode (no server) and legacy CLI flows that
  // don't surface latency.
  latency?: LatencyTracker;
  pingTracker?: PingTracker | null;
  onPingTracked?: () => void;
};

export function sendPingDrop(opts: SendPingDropOptions): string {
  const {
    client,
    overlay,
    selfSessionId,
    groupId,
    coords,
    color,
    ttl,
    peerAvatars,
    latency,
    pingTracker,
    onPingTracked,
  } = opts;
  const envelope = createEnvelope(
    'ping:drop',
    { coords, color, ttl, senderSessionId: selfSessionId },
    { groupId },
  );
  latency?.recordSend(envelope.messageId);
  client.sendEnvelope(envelope);
  const echoPayload: OverlayShowPingPayload = {
    coords,
    color,
    ttl,
    messageId: envelope.messageId,
    receivedAt: Date.now(),
    senderSessionId: selfSessionId,
    avatarBase64: peerAvatars.get(selfSessionId),
  };
  echoLocalPing(overlay, echoPayload, pingTracker, onPingTracked);
  return envelope.messageId;
}

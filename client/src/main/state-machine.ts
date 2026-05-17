import { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  createEnvelope,
  type PairStatePayload,
  type PeerAvatarPayload,
} from '@pyng/shared';
import type { ClientConfig } from './config.js';
import { LatencyTracker } from './latency-tracker.js';
import type { WsClient } from './net/wsClient.js';
import { PeerAvatarStore } from './peerAvatars.js';
import {
  PairInvalidError,
  runGenerateFlow,
  runRedeemFlow,
  runResumeFlow,
  type FlowOptions,
} from './pairingFlow.js';
import {
  clearPersistentPair,
  getPersistentPair,
  loadSettings,
  savePersistentPair,
} from './settings.js';
import { AbortFlowError } from './state-machine-errors.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type PairState =
  | { kind: 'unpaired'; error?: string }
  | { kind: 'generating'; code?: string; expiresAt?: number; sessionId?: string }
  | { kind: 'redeeming'; code: string; sessionId?: string }
  | { kind: 'paired'; groupId: string; sessionId: string };

export type MachineState = {
  connection: ConnectionState;
  pair: PairState;
  // True after a disconnect-while-paired event has dropped the user back to
  // unpaired. Cleared on the user's next pair action (generate/redeem) or
  // when they dismiss the renderer banner. Server-side `pair:resume` is
  // intentionally NOT attempted; v2's relay doesn't implement grace periods.
  pairLostHint: boolean;
  // Rolling-mean round-trip latency from ping:ack measurements; null when
  // not paired or no samples have arrived yet. See latency-tracker.ts.
  latencyMs: number | null;
  spectatorState: 'idle' | 'spectating' | 'spectated' | null;
  peerRobloxUsername: string | null;
};

// Stepped backoff for reconnect attempts: 1s, 2s, 4s, 8s, then 8s repeating
// (cap). The cap is intentional — we don't escalate beyond 8s because the
// user is visibly told the connection dropped and can decide whether to
// keep the app open or close it.
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

export type StateMachineDeps = {
  client: WsClient;
  config: ClientConfig;
  log: (line: string) => void;
};

export class PairStateMachine {
  private state: MachineState = {
    connection: 'disconnected',
    pair: { kind: 'unpaired' },
    pairLostHint: false,
    latencyMs: null,
    spectatorState: null,
    peerRobloxUsername: null,
  };
  private readonly client: WsClient;
  private readonly config: ClientConfig;
  private readonly log: (line: string) => void;
  private readonly peerAvatars = new PeerAvatarStore();
  private readonly latency = new LatencyTracker();
  private readonly listeners = new Set<(s: MachineState) => void>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private unsubAvatarListener: (() => void) | null = null;
  private unsubPairBrokenListener: (() => void) | null = null;
  private unsubAckListener: (() => void) | null = null;
  private unsubLatencyListener: (() => void) | null = null;
  private unsubCloseListener: (() => void) | null = null;
  private inFlightAbort: AbortController | null = null;
  private shuttingDown = false;

  constructor(deps: StateMachineDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.log = deps.log;
  }

  getState(): MachineState {
    return this.state;
  }

  getPeerAvatars(): PeerAvatarStore {
    return this.peerAvatars;
  }

  getLatencyTracker(): LatencyTracker {
    return this.latency;
  }

  subscribe(cb: (s: MachineState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async start(): Promise<void> {
    // Register peer:avatar listener up front so server-replayed avatars
    // (sent right after pair:established) aren't dropped.
    this.unsubAvatarListener = this.client.onMessage((msg) => {
      if (msg.type !== 'peer:avatar') return;
      this.peerAvatars.set(msg.payload.sessionId, msg.payload.imageBase64);
      this.log(
        `received peer avatar sessionId=${msg.payload.sessionId} size=${msg.payload.imageBase64.length}`,
      );
    });
    this.unsubPairBrokenListener = this.client.onMessage((msg) => {
      if (msg.type !== 'pair:broken') return;
      if (this.state.pair.kind !== 'paired') return;
      this.log(`pair:broken reason=${msg.payload.reason}`);
      clearPersistentPair();
      this.peerAvatars.clear();
      this.latency.reset();
      this.setStateAtomic({
        connection: this.state.connection,
        pair: { kind: 'unpaired', error: `pair ended: ${msg.payload.reason}` },
        pairLostHint: false,
        latencyMs: null,
        spectatorState: null,
        peerRobloxUsername: null,
      });
    });
    // Hook ping:ack arrivals into the latency tracker. The server sends an
    // ack to the sender on every ping:drop receipt. The in-flight map only
    // contains our own sends (recordSend is called from pingSender), so acks
    // for other group members' pings are silently dropped by recordAck's
    // unknown-id check.
    this.unsubAckListener = this.client.onMessage((msg) => {
      if (msg.type !== 'ping:ack') return;
      this.latency.recordAck(msg.payload.messageId);
    });
    // Re-broadcast machine state when the rolling-mean latency changes so
    // the renderer's PairStatePayload reflects fresh latency without
    // needing a separate IPC channel.
    this.unsubLatencyListener = this.latency.subscribe((latencyMs) => {
      if (this.state.latencyMs === latencyMs) return;
      this.state = { ...this.state, latencyMs };
      this.notify();
    });
    this.unsubCloseListener = this.client.onClose((code, reason) => {
      this.onSocketClosed(code, reason);
    });
    await this.connect();
  }

  async requestGenerate(): Promise<void> {
    if (this.state.pair.kind !== 'unpaired') {
      throw new Error(`cannot generate from state '${this.state.pair.kind}'`);
    }
    if (this.state.connection !== 'connected') {
      throw new Error('cannot generate while disconnected from relay');
    }
    this.clearPairLostHint();
    this.transitionPair({ kind: 'generating' });
    this.inFlightAbort = new AbortController();
    const signal = this.inFlightAbort.signal;
    try {
      const opts: FlowOptions = {
        postPairHold: false,
        signal,
        onCode: (code, expiresAt) => {
          if (this.state.pair.kind === 'generating') {
            this.transitionPair({ ...this.state.pair, code, expiresAt });
          }
        },
        onSessionId: (sessionId) => {
          if (this.state.pair.kind === 'generating') {
            this.transitionPair({ ...this.state.pair, sessionId });
          }
        },
      };
      const { groupId, sessionId } = await runGenerateFlow(this.client, this.log, opts);
      this.onPaired(groupId, sessionId);
    } catch (err) {
      this.onFlowError(err);
    } finally {
      this.inFlightAbort = null;
    }
  }

  async requestRedeem(code: string): Promise<void> {
    if (this.state.pair.kind !== 'unpaired') {
      throw new Error(`cannot redeem from state '${this.state.pair.kind}'`);
    }
    if (this.state.connection !== 'connected') {
      throw new Error('cannot redeem while disconnected from relay');
    }
    this.clearPairLostHint();
    this.transitionPair({ kind: 'redeeming', code });
    this.inFlightAbort = new AbortController();
    const signal = this.inFlightAbort.signal;
    try {
      const opts: FlowOptions = {
        postPairHold: false,
        signal,
        onSessionId: (sessionId) => {
          if (this.state.pair.kind === 'redeeming') {
            this.transitionPair({ ...this.state.pair, sessionId });
          }
        },
      };
      const { groupId, sessionId } = await runRedeemFlow(this.client, code, this.log, opts);
      this.onPaired(groupId, sessionId);
    } catch (err) {
      this.onFlowError(err);
    } finally {
      this.inFlightAbort = null;
    }
  }

  requestUnpair(): void {
    const paired = this.state.pair.kind === 'paired' ? this.state.pair : null;
    if (this.inFlightAbort) {
      this.inFlightAbort.abort();
      this.inFlightAbort = null;
    }
    if (paired) {
      try {
        this.client.send('pair:revoke', { groupId: paired.groupId }, { groupId: paired.groupId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`pair:revoke send failed: ${message}`);
      }
    }
    clearPersistentPair();
    this.peerAvatars.clear();
    this.latency.reset();
    this.clearPairLostHint();
    this.transitionPair({ kind: 'unpaired' });
  }

  dismissPairLostHint(): void {
    this.clearPairLostHint();
  }

  setSpectatorState(spectatorState: MachineState['spectatorState']): void {
    if (this.state.spectatorState === spectatorState) return;
    this.state = { ...this.state, spectatorState };
    this.notify();
  }

  setPeerRobloxUsername(peerRobloxUsername: string | null): void {
    if (this.state.peerRobloxUsername === peerRobloxUsername) return;
    this.state = { ...this.state, peerRobloxUsername };
    this.notify();
  }

  private clearPairLostHint(): void {
    if (!this.state.pairLostHint) return;
    this.state = { ...this.state, pairLostHint: false };
    this.notify();
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.unsubAvatarListener) {
      this.unsubAvatarListener();
      this.unsubAvatarListener = null;
    }
    if (this.unsubPairBrokenListener) {
      this.unsubPairBrokenListener();
      this.unsubPairBrokenListener = null;
    }
    if (this.unsubAckListener) {
      this.unsubAckListener();
      this.unsubAckListener = null;
    }
    if (this.unsubLatencyListener) {
      this.unsubLatencyListener();
      this.unsubLatencyListener = null;
    }
    if (this.unsubCloseListener) {
      this.unsubCloseListener();
      this.unsubCloseListener = null;
    }
    if (this.inFlightAbort) {
      this.inFlightAbort.abort();
      this.inFlightAbort = null;
    }
    this.listeners.clear();
    try {
      this.client.close(1000);
    } catch {
      // ignore
    }
  }

  private async connect(): Promise<void> {
    // First attempt uses 'connecting'; subsequent retry attempts use
    // 'reconnecting' so the renderer can distinguish "fresh boot" from
    // "lost connection, trying again."
    const isRetry = this.reconnectAttempt > 0;
    this.transitionConnection(isRetry ? 'reconnecting' : 'connecting');
    try {
      await this.client.connect(this.config.relayUrl);
      this.reconnectAttempt = 0;
      this.transitionConnection('connected');
      this.log(`connected to ${this.config.relayUrl}`);
      await this.resumePersistentPair();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`connect failed: ${message}`);
      this.transitionConnection('disconnected');
      this.scheduleReconnect();
    }
  }

  private nextReconnectDelay(): number {
    const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    return RECONNECT_BACKOFF_MS[idx] ?? 8_000;
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;
    const delay = this.nextReconnectDelay();
    this.reconnectAttempt += 1;
    this.log(`reconnect scheduled in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private onSocketClosed(code: number, reason: string): void {
    if (this.shuttingDown) return;
    this.log(`socket closed code=${code} reason=${reason}`);
    if (this.inFlightAbort) {
      this.inFlightAbort.abort();
      this.inFlightAbort = null;
    }
    // Disconnect-while-paired: drop live state, but keep the saved groupId.
    // Cloudflare-backed long-term pairs can resume automatically on reconnect.
    // The transition away from 'paired' triggers the input-bridge subscriber
    // (input-bridge.ts) which unregisters the hotkey AND fires
    // fireHoldEnd → exitPingMode if a hold was in progress. This is the
    // hold-mid-disconnect safety guarantee from the task spec.
    if (this.state.pair.kind === 'paired') {
      this.peerAvatars.clear();
      this.latency.reset();
      this.setStateAtomic({
        connection: 'disconnected',
        pair: { kind: 'unpaired' },
        pairLostHint: true,
        latencyMs: null,
        spectatorState: null,
        peerRobloxUsername: null,
      });
    } else if (this.state.pair.kind === 'generating' || this.state.pair.kind === 'redeeming') {
      this.setStateAtomic({
        connection: 'disconnected',
        pair: { kind: 'unpaired', error: 'connection lost during pairing' },
        pairLostHint: this.state.pairLostHint,
        latencyMs: this.state.latencyMs,
        spectatorState: null,
        peerRobloxUsername: null,
      });
    } else {
      this.transitionConnection('disconnected');
    }
    this.scheduleReconnect();
  }

  private onPaired(groupId: string, sessionId: string): void {
    savePersistentPair(groupId);
    this.transitionPair({ kind: 'paired', groupId, sessionId });
    this.publishOwnAvatar(groupId, sessionId);
  }

  private async resumePersistentPair(): Promise<void> {
    const savedPair = getPersistentPair();
    if (!savedPair || this.state.pair.kind !== 'unpaired') return;

    this.log(`attempting pair resume groupId=${savedPair.groupId}`);
    this.inFlightAbort = new AbortController();
    const signal = this.inFlightAbort.signal;
    try {
      const { groupId, sessionId } = await runResumeFlow(this.client, savedPair.groupId, this.log, {
        signal,
      });
      this.clearPairLostHint();
      this.onPaired(groupId, sessionId);
    } catch (err) {
      if (err instanceof PairInvalidError) {
        this.log(`saved pair invalid reason=${err.reason}; clearing saved pair`);
        clearPersistentPair();
        this.transitionPair({ kind: 'unpaired', error: `saved pair invalid: ${err.reason}` });
        return;
      }
      if (err instanceof AbortFlowError) {
        this.log('pair resume cancelled');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(`pair resume failed: ${message}`);
    } finally {
      this.inFlightAbort = null;
    }
  }

  private publishOwnAvatar(groupId: string, sessionId: string): void {
    const settings = loadSettings();
    if (!settings.avatar) {
      this.log('no avatar in settings; skipping peer:avatar publish');
      return;
    }
    this.peerAvatars.set(sessionId, settings.avatar.imageBase64);
    const envelope = createEnvelope<'peer:avatar'>(
      'peer:avatar',
      { sessionId, imageBase64: settings.avatar.imageBase64 } satisfies PeerAvatarPayload,
      { groupId },
    );
    this.client.sendEnvelope(envelope);
    this.log(`published own avatar (size=${settings.avatar.imageBase64.length} bytes)`);
  }

  private onFlowError(err: unknown): void {
    if (err instanceof PairInvalidError) {
      this.log(`pair:invalid reason=${err.reason}`);
      this.transitionPair({ kind: 'unpaired', error: `pair invalid: ${err.reason}` });
      return;
    }
    if (err instanceof AbortFlowError) {
      this.log('pair flow cancelled');
      // Unpair already issued via requestUnpair; nothing more to do.
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.log(`pair flow error: ${message}`);
    this.transitionPair({ kind: 'unpaired', error: message });
  }

  private transitionConnection(next: ConnectionState): void {
    if (this.state.connection === next) return;
    this.state = { ...this.state, connection: next };
    this.notify();
  }

  private transitionPair(next: PairState): void {
    this.state = { ...this.state, pair: next };
    this.notify();
  }

  // Atomic batch update — used when multiple fields change in the same tick
  // (e.g., disconnect-while-paired: connection→disconnected, pair→unpaired,
  // pairLostHint→true). One notify, one renderer broadcast.
  private setStateAtomic(next: MachineState): void {
    this.state = next;
    this.notify();
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb(this.state);
    broadcastStateToAllWindows(this.state);
  }
}

function broadcastStateToAllWindows(state: MachineState): void {
  const payload: PairStatePayload = state;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC_CHANNELS.PAIR_STATE_CHANGED, payload);
  }
}

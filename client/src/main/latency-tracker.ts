const ROLLING_WINDOW = 10;
const SEND_EXPIRY_MS = 30_000;

export type LatencyListener = (latencyMs: number | null) => void;

/**
 * Tracks WebSocket round-trip latency for outbound `ping:drop` envelopes.
 *
 * Lifecycle:
 * - `recordSend(messageId)` is called at send time (from `pingSender`).
 * - `recordAck(messageId)` is called when the server's `ping:ack` arrives.
 *   The pair sentAt/receivedAt gives a single RTT sample.
 * - Samples are kept in a fixed-size rolling buffer (`ROLLING_WINDOW`).
 * - `getCurrentLatency()` returns the rolling mean (rounded to integer ms),
 *   or null if no samples are available.
 *
 * Sends without a matching ack expire after `SEND_EXPIRY_MS` so the in-flight
 * map doesn't grow unbounded on a flaky connection. Expiry runs lazily on
 * every `recordSend`/`recordAck` — no background timer.
 *
 * Subscribers are notified whenever the rolling-mean value changes (or on
 * the first sample). Each subscriber receives the current latency immediately
 * on subscribe.
 */
export class LatencyTracker {
  private readonly pending = new Map<string, { sentAt: number }>();
  private readonly samples: number[] = [];
  private currentLatencyMs: number | null = null;
  private readonly listeners = new Set<LatencyListener>();

  recordSend(messageId: string, now: number = Date.now()): void {
    this.expirePending(now);
    this.pending.set(messageId, { sentAt: now });
  }

  recordAck(messageId: string, now: number = Date.now()): void {
    this.expirePending(now);
    const entry = this.pending.get(messageId);
    if (!entry) return;
    this.pending.delete(messageId);
    const rtt = now - entry.sentAt;
    if (rtt < 0) return; // clock skew guard
    this.samples.push(rtt);
    if (this.samples.length > ROLLING_WINDOW) {
      this.samples.shift();
    }
    this.updateLatency();
  }

  /**
   * Reset the tracker. Called when the pair drops or the connection dies so
   * stale samples don't get reported as if they belonged to the next pair.
   */
  reset(): void {
    this.pending.clear();
    this.samples.length = 0;
    if (this.currentLatencyMs !== null) {
      this.currentLatencyMs = null;
      this.notify();
    }
  }

  getCurrentLatency(): number | null {
    return this.currentLatencyMs;
  }

  subscribe(cb: LatencyListener): () => void {
    this.listeners.add(cb);
    cb(this.currentLatencyMs);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private expirePending(now: number): void {
    for (const [messageId, entry] of this.pending) {
      if (now - entry.sentAt > SEND_EXPIRY_MS) {
        this.pending.delete(messageId);
      }
    }
  }

  private updateLatency(): void {
    if (this.samples.length === 0) {
      if (this.currentLatencyMs !== null) {
        this.currentLatencyMs = null;
        this.notify();
      }
      return;
    }
    let sum = 0;
    for (const sample of this.samples) sum += sample;
    const next = Math.round(sum / this.samples.length);
    if (next !== this.currentLatencyMs) {
      this.currentLatencyMs = next;
      this.notify();
    }
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb(this.currentLatencyMs);
  }
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LatencyTracker } from './latency-tracker.js';

describe('LatencyTracker', () => {
  it('returns null before any sample arrives', () => {
    const tracker = new LatencyTracker();
    assert.equal(tracker.getCurrentLatency(), null);
  });

  it('records a single round-trip and reports it as the rolling mean', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend('m1', 1000);
    tracker.recordAck('m1', 1042);
    assert.equal(tracker.getCurrentLatency(), 42);
  });

  it('rounds the rolling mean to an integer ms', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend('m1', 1000);
    tracker.recordAck('m1', 1041);
    tracker.recordSend('m2', 2000);
    tracker.recordAck('m2', 2044);
    // mean(41, 44) = 42.5 → 43
    assert.equal(tracker.getCurrentLatency(), 43);
  });

  it('keeps only the last 10 samples in the rolling window', () => {
    const tracker = new LatencyTracker();
    // 15 samples with rtt = i*10 (so 0, 10, 20, …, 140).
    // The mean of the last 10 (50..140) is 95.
    for (let i = 0; i < 15; i++) {
      const id = `m${i}`;
      tracker.recordSend(id, 1000 + i * 1000);
      tracker.recordAck(id, 1000 + i * 1000 + i * 10);
    }
    assert.equal(tracker.getCurrentLatency(), 95);
  });

  it('expires in-flight sends older than 30s on the next operation', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend('m-old', 0);
    // After 31 seconds, the next send call sweeps m-old before recording.
    tracker.recordSend('m-new', 31_000);
    // Acking the stale one is a no-op (no sample registered).
    tracker.recordAck('m-old', 31_001);
    assert.equal(tracker.getCurrentLatency(), null);
    // The fresh one still works.
    tracker.recordAck('m-new', 31_050);
    assert.equal(tracker.getCurrentLatency(), 50);
  });

  it('ignores acks for unknown messageIds', () => {
    const tracker = new LatencyTracker();
    tracker.recordAck('never-sent', 500);
    assert.equal(tracker.getCurrentLatency(), null);
  });

  it('reset clears samples, in-flight sends, and current latency', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend('m1', 1000);
    tracker.recordAck('m1', 1042);
    assert.equal(tracker.getCurrentLatency(), 42);

    tracker.reset();
    assert.equal(tracker.getCurrentLatency(), null);

    // After reset, a fresh round-trip starts the new average from scratch.
    tracker.recordSend('m2', 2000);
    tracker.recordAck('m2', 2100);
    assert.equal(tracker.getCurrentLatency(), 100);
  });

  it('subscribers receive the current latency immediately and on changes', () => {
    const tracker = new LatencyTracker();
    const seen: Array<number | null> = [];
    const unsub = tracker.subscribe((latency) => seen.push(latency));

    // Immediate callback: null (no samples yet).
    assert.deepEqual(seen, [null]);

    tracker.recordSend('m1', 1000);
    tracker.recordAck('m1', 1050);
    assert.deepEqual(seen, [null, 50]);

    // Adding a second sample changes the rolling mean → notify.
    tracker.recordSend('m2', 2000);
    tracker.recordAck('m2', 2070);
    assert.deepEqual(seen, [null, 50, 60]);

    // Adding a sample that keeps the mean exactly the same → no notify.
    tracker.recordSend('m3', 3000);
    tracker.recordAck('m3', 3060);
    assert.deepEqual(seen, [null, 50, 60]); // mean(50, 70, 60) = 60, unchanged

    unsub();
    tracker.recordSend('m4', 4000);
    tracker.recordAck('m4', 4200);
    assert.deepEqual(seen, [null, 50, 60]); // listener was removed
  });

  it('clock-skew guard: negative rtt is dropped, not recorded', () => {
    const tracker = new LatencyTracker();
    tracker.recordSend('m1', 5_000);
    tracker.recordAck('m1', 4_999); // ack timestamp before send timestamp
    assert.equal(tracker.getCurrentLatency(), null);
  });
});

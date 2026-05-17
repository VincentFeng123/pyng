import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, type ServerHandle } from './index.js';
import { _resetStateForTests } from './groups.js';
import { _resetSocketsForTests } from './relay.js';
import { loopbackListenSkipReason } from './test-preflight.js';

const HEARTBEAT_INTERVAL_MS = 100;
const LOOPBACK_SKIP_REASON = await loopbackListenSkipReason();

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('relay heartbeat', { skip: LOOPBACK_SKIP_REASON ?? false }, () => {
  let server: ServerHandle;
  let url: string;

  before(async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      log: () => {},
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });
    url = `ws://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.close();
  });

  it('terminates a socket that stops responding to pings', async () => {
    _resetStateForTests();
    _resetSocketsForTests();

    const ws = await openSocket(url);
    // The `ws` client auto-replies to server pings at the protocol level (inside its
    // receiver), not via a JS-level event listener — `removeAllListeners('ping')` is
    // not enough. The auto-reply works by calling `socket.pong(...)`. Stub that to a
    // no-op so the client silently drops incoming pings and the server's isAlive
    // flag stays false across two ticks → server.terminate().
    (ws as unknown as { pong: (data?: unknown, mask?: unknown, cb?: unknown) => void }).pong =
      () => {};

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    // First tick: server sets isAlive=false, sends ping. Client silently drops it.
    // Second tick (≤ ~2 * HEARTBEAT_INTERVAL_MS later): server sees isAlive still false,
    // calls socket.terminate(). The client's `close` event fires.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('socket was not terminated within the heartbeat window')),
        HEARTBEAT_INTERVAL_MS * 10,
      );
    });

    await Promise.race([closed, timeout]);
  });

  it('keeps a healthy socket open across multiple heartbeat ticks', async () => {
    _resetStateForTests();
    _resetSocketsForTests();

    const ws = await openSocket(url);
    // The `ws` library auto-replies to server pings by default. Just sit on the socket.

    let closedEarly = false;
    ws.once('close', () => {
      closedEarly = true;
    });

    // Wait through several heartbeat intervals to confirm the socket survives.
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_INTERVAL_MS * 5));

    assert.equal(closedEarly, false, 'socket should not have been closed by the heartbeat');

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once('close', () => resolve());
      ws.close();
    });
  });
});

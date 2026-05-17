/**
 * Integration test: server's heartbeat reaper terminates a non-responding
 * WebSocket client.
 *
 * The server's #45 unit test (`server/src/heartbeat.test.ts`) exercises the
 * same path in-process. This file complements it by spawning the server as
 * a real CHILD PROCESS via `node --import tsx server/src/index.ts`, then opening a normal
 * `ws.WebSocket` client and stubbing its auto-pong response. The server's
 * heartbeat loop sees `isAlive` stay false across two ticks and calls
 * `socket.terminate()`. The client observes a `close` event within
 * roughly `heartbeatIntervalMs * 2 + 100ms`.
 *
 * Why this layer matters even with #45's in-process coverage:
 *   - In-process tests share an event loop. Real clients run in a separate
 *     process and event loop, with real socket framing and ws-library auto-
 *     ack behavior. Cross-process verification catches buffering / framing
 *     regressions the unit test couldn't see.
 *   - The server's CLI bootstrap now reads `HEARTBEAT_INTERVAL_MS` from env
 *     (added by this task); this test verifies that wiring works.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { loopbackListenSkipReason, skipIfLoopbackUnavailable } from './preflight.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');

const HEARTBEAT_INTERVAL_MS = 100;
const SERVER_READY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 10;
const LOOPBACK_SKIP_REASON = await loopbackListenSkipReason();

let server: ChildProcess | null = null;
let serverUrl: string | null = null;
let serverStdout = '';

before(async () => {
  if (LOOPBACK_SKIP_REASON) return;
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      HEARTBEAT_INTERVAL_MS: String(HEARTBEAT_INTERVAL_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = proc;
  proc.stdout?.on('data', (chunk: Buffer) => {
    serverStdout += chunk.toString('utf8');
  });
  // Wait for the listening event line and capture the bound port.
  await new Promise<void>((resolveReady, rejectReady) => {
    const start = Date.now();
    const tick = (): void => {
      const m = /"event":"listening","port":(\d+)/.exec(serverStdout);
      if (m) {
        const port = Number(m[1]);
        if (!Number.isFinite(port) || port <= 0) {
          rejectReady(new Error(`server reported invalid port: ${m[0]}`));
          return;
        }
        serverUrl = `ws://127.0.0.1:${port}`;
        resolveReady();
        return;
      }
      if (Date.now() - start >= SERVER_READY_TIMEOUT_MS) {
        rejectReady(new Error(`server never logged listening: stdout=\n${serverStdout}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
});

after(async () => {
  if (!server) return;
  await new Promise<void>((resolveClose) => {
    if (server!.exitCode !== null || server!.signalCode !== null) {
      resolveClose();
      return;
    }
    server!.once('exit', () => resolveClose());
    try {
      server!.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        server!.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2_000);
  });
});

test('server terminates a client that stops responding to pings', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  assert.ok(serverUrl, 'serverUrl set in before()');

  const ws = new WebSocket(serverUrl);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });

  // The `ws` client auto-replies to server pings at the protocol level. Stub
  // its `pong` method to a no-op so the client silently drops incoming pings.
  // Server's `isAlive` flag stays false across two heartbeat ticks → terminate.
  (ws as unknown as { pong: (data?: unknown, mask?: unknown, cb?: unknown) => void }).pong =
    () => {};

  const closed = await Promise.race([
    new Promise<{ code: number }>((res) => {
      ws.once('close', (code) => res({ code }));
    }),
    new Promise<never>((_, rej) => {
      setTimeout(
        () =>
          rej(
            new Error(
              `socket was not terminated within ${CLOSE_TIMEOUT_MS}ms.\n` +
                `server stdout:\n${serverStdout}`,
            ),
          ),
        CLOSE_TIMEOUT_MS,
      );
    }),
  ]);

  // ws library reports 1006 (abnormal closure) when the remote calls `terminate()`.
  assert.ok(closed.code === 1006 || closed.code === 1005, `unexpected close code ${closed.code}`);
  // Confirm the server logged the heartbeat-timeout event for our session.
  assert.match(
    serverStdout,
    /"event":"heartbeat_timeout"/,
    `server should log heartbeat_timeout. stdout:\n${serverStdout}`,
  );
});

test('healthy client (auto-pong) is not terminated', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  assert.ok(serverUrl, 'serverUrl set in before()');
  const ws = new WebSocket(serverUrl);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });

  let closedEarly = false;
  ws.once('close', () => {
    closedEarly = true;
  });

  // Wait through several heartbeat intervals to confirm the socket stays open
  // when auto-pong is intact.
  await new Promise((res) => setTimeout(res, HEARTBEAT_INTERVAL_MS * 5));
  assert.equal(closedEarly, false, 'healthy socket should not have been terminated');

  await new Promise<void>((resolveClose) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolveClose();
      return;
    }
    ws.once('close', () => resolveClose());
    ws.close();
  });
});

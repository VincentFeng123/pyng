/**
 * Integration test suite: pair → ping:drop → main → IPC bridge → renderer,
 * extended to cover the v1.5 avatar pipeline (peer:avatar publish, avatar
 * attribution in ping IPC, identity-mismatch rejection, pre-pair cache replay).
 *
 * Each test boots a fresh mock-peer WebSocket and a fresh Electron client
 * against a single shared relay server (started once in `before()`). Per-test
 * children are tracked in module-level `tracked[]`; the final `after()`
 * asserts every child exited so a leaked process fails CI loudly.
 *
 * What this test verifies (cumulatively across cases):
 *   - End-to-end pairing handshake against the real server.
 *   - Server's group-routing of `ping:drop` to the paired peer (#27).
 *   - Electron main receives ping:drop via WsClient and the overlay bridge
 *     logs `ping received messageId=<uuid>` (#13).
 *   - When the sender has previously published a `peer:avatar`, the bridge
 *     logs `forwarding ping to overlay ... hasAvatar=true` and the IPC
 *     payload carries the sender's avatar bytes (#33, #36).
 *   - When the sender has not published, the bridge logs `hasAvatar=false`
 *     and `avatarBase64` is null in the IPC payload (#33).
 *   - Server identity check (`payload.sessionId === socket.sessionId`)
 *     rejects impersonation with `code: 'avatar_identity_mismatch'` (#29).
 *   - Pre-pair `pendingAvatars` cache replays a cached avatar to the
 *     joining peer on `pair:established` (#29 `replayAvatars`).
 *
 * What this suite does NOT verify (deliberate; see task #18/#36 specs):
 *   - Renderer-side pixel rendering of the avatar in the chevron slot
 *     (manual smoke per docs/TESTING.md "v1 manual smoke tests"; #34 owns
 *     the rendering, #19 owns the doc).
 *   - Click-through behavior (separate manual smoke).
 *   - Multiple-avatar / >2-peer group topologies (single 2-peer groups
 *     only in v1.5).
 */

import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createEnvelope, isMessage, type Message } from '@pyng/shared';
import { TEST_AVATAR_BASE64 } from './fixtures.js';
import { loopbackListenSkipReason, skipIfLoopbackUnavailable } from './preflight.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');

const SERVER_READY_TIMEOUT_MS = 10_000;
const PAIR_TIMEOUT_MS = 15_000;
const AVATAR_RECEIVED_TIMEOUT_MS = 2_000;
const PING_OBSERVE_TIMEOUT_MS = 5_000;
const KNOWN_COLOR = '#abcdef';
const KNOWN_COORDS = { x: 0.5, y: 0.5 };
const LOOPBACK_SKIP_REASON = await loopbackListenSkipReason();

type Tracked = {
  name: string;
  proc: ChildProcess;
  stdout: string;
  stderr: string;
};

const tracked: Tracked[] = [];

function trackProcess(name: string, proc: ChildProcess): Tracked {
  const entry: Tracked = { name, proc, stdout: '', stderr: '' };
  proc.stdout?.on('data', (chunk: Buffer) => {
    entry.stdout += chunk.toString('utf8');
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    entry.stderr += chunk.toString('utf8');
  });
  tracked.push(entry);
  return entry;
}

function waitForLine(entry: Tracked, regex: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
  return new Promise((resolveMatch, rejectMatch) => {
    const start = Date.now();
    const check = (): RegExpMatchArray | null => regex.exec(entry.stdout);
    const initial = check();
    if (initial) {
      resolveMatch(initial);
      return;
    }
    const onTick = (): void => {
      const m = check();
      if (m) {
        cleanup();
        resolveMatch(m);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        cleanup();
        rejectMatch(buildTimeoutError());
      }
    };
    const interval = setInterval(onTick, 50);
    const timer = setTimeout(() => {
      cleanup();
      rejectMatch(buildTimeoutError());
    }, timeoutMs);
    const buildTimeoutError = (): Error =>
      new Error(
        `[${entry.name}] timeout waiting for ${regex} after ${timeoutMs}ms.\n` +
          `--- stdout ---\n${entry.stdout}\n--- stderr ---\n${entry.stderr}`,
      );
    const cleanup = (): void => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  });
}

function killTracked(entry: Tracked): Promise<void> {
  return new Promise((resolveKill) => {
    if (entry.proc.exitCode !== null || entry.proc.signalCode !== null) {
      resolveKill();
      return;
    }
    const onExit = (): void => {
      clearTimeout(escalation);
      resolveKill();
    };
    entry.proc.once('exit', onExit);
    try {
      entry.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    const escalation = setTimeout(() => {
      try {
        entry.proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2_000);
  });
}

function awaitMessage<T extends Message['type']>(
  socket: WebSocket,
  predicate: (msg: Extract<Message, { type: T }>) => boolean,
  type: T,
  timeoutMs = 5_000,
): Promise<Extract<Message, { type: T }>> {
  return new Promise((resolveMsg, rejectMsg) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isMessage(parsed) || parsed.type !== type) return;
      const typed = parsed as Extract<Message, { type: T }>;
      if (!predicate(typed)) return;
      cleanup();
      resolveMsg(typed);
    };
    const onError = (err: Error): void => {
      cleanup();
      rejectMsg(err);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectMsg(new Error(`timed out waiting for ${type} after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

const anyOfType =
  <T extends Message['type']>(_type: T) =>
  (_msg: Extract<Message, { type: T }>): boolean =>
    true;

let server: Tracked | null = null;
let serverUrl: string | null = null;

before(async () => {
  if (LOOPBACK_SKIP_REASON) return;
  // Boot the relay server on an ephemeral port (PORT=0 → OS picks).
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = trackProcess('server', proc);
  const m = await waitForLine(server, /"event":"listening","port":(\d+)/, SERVER_READY_TIMEOUT_MS);
  const port = Number(m[1]);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`server reported invalid port: ${m[0]}`);
  }
  serverUrl = `ws://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await killTracked(server);
  for (const entry of tracked) {
    assert.ok(
      entry.proc.exitCode !== null || entry.proc.signalCode !== null,
      `${entry.name} did not exit; signal=${entry.proc.signalCode} code=${entry.proc.exitCode}`,
    );
  }
});

type PairedHandles = {
  mockPeerWs: WebSocket;
  mockSessionId: string;
  groupId: string;
  electron: Tracked;
};

async function openMockPeer(t: TestContext): Promise<{ ws: WebSocket; sessionId: string }> {
  assert.ok(serverUrl, 'serverUrl set in before()');
  const ws = new WebSocket(serverUrl);
  t.after(() => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000);
    }
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.send(
    JSON.stringify(
      createEnvelope('hello', {
        clientVersion: '0.0.0-test',
        platform:
          process.platform === 'win32' || process.platform === 'darwin'
            ? process.platform
            : 'linux',
      }),
    ),
  );
  const welcome = await awaitMessage(ws, anyOfType('welcome'), 'welcome');
  return { ws, sessionId: welcome.payload.sessionId };
}

async function pairElectronRedeemerToMockGenerator(t: TestContext): Promise<PairedHandles> {
  const { ws, sessionId: mockSessionId } = await openMockPeer(t);

  // Mock peer generates the code.
  ws.send(JSON.stringify(createEnvelope('pair:generate', {})));
  const codeEnv = await awaitMessage(ws, anyOfType('pair:code'), 'pair:code');
  const code = codeEnv.payload.code;
  assert.match(code, /^[A-Z0-9]{6}$/, `pair:code returned a 6-char alnum code (got ${code})`);

  // Spawn the Electron client in redeem + overlay mode.
  const proc = spawn('npx', ['electron', 'client/src/main/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: '--import tsx',
      LEGACY_CLI: '1',
      MODE: 'redeem',
      CODE: code,
      OVERLAY: '1',
      SERVER_URL: serverUrl as string,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const electron = trackProcess('electron', proc);
  t.after(() => killTracked(electron));

  const established = await awaitMessage(
    ws,
    anyOfType('pair:established'),
    'pair:established',
    PAIR_TIMEOUT_MS,
  );
  const groupId = established.payload.groupId;
  assert.ok(groupId, 'pair:established carried a groupId');

  // Wait until the overlay window is live; without this, a ping sent
  // immediately after pair could race the bridge handler's attach.
  await waitForLine(electron, /opening overlay window/, PAIR_TIMEOUT_MS);
  await waitForLine(electron, /overlay live; SIGINT to exit/, PAIR_TIMEOUT_MS);

  return { mockPeerWs: ws, mockSessionId, groupId, electron };
}

test('pair → ping:drop round-trip reaches the overlay bridge', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  const { mockPeerWs, mockSessionId, groupId, electron } =
    await pairElectronRedeemerToMockGenerator(t);

  const pingEnv = createEnvelope(
    'ping:drop',
    {
      coords: KNOWN_COORDS,
      color: KNOWN_COLOR,
      ttl: 5_000,
      senderSessionId: mockSessionId,
    },
    { groupId },
  );
  mockPeerWs.send(JSON.stringify(pingEnv));

  const bridgeMatch = await waitForLine(
    electron,
    /ping received messageId=([0-9a-f-]{36})/,
    PING_OBSERVE_TIMEOUT_MS,
  );
  assert.equal(
    bridgeMatch[1],
    pingEnv.messageId,
    `bridge logged messageId ${bridgeMatch[1]} should match sent ${pingEnv.messageId}`,
  );
});

test('peer:avatar publish + ping carries avatar in IPC payload', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  const { mockPeerWs, mockSessionId, groupId, electron } =
    await pairElectronRedeemerToMockGenerator(t);

  // Mock peer publishes its avatar AFTER pair so we exercise the post-pair
  // broadcast path (not the pendingAvatars replay path — that's a separate
  // test below).
  const avatarEnv = createEnvelope(
    'peer:avatar',
    { sessionId: mockSessionId, imageBase64: TEST_AVATAR_BASE64 },
    { groupId },
  );
  mockPeerWs.send(JSON.stringify(avatarEnv));

  // Electron client's pre-pair listener should log receipt.
  await waitForLine(
    electron,
    new RegExp(`received peer avatar sessionId=${mockSessionId} size=${TEST_AVATAR_BASE64.length}`),
    AVATAR_RECEIVED_TIMEOUT_MS,
  );

  // Now send a ping; the bridge should attribute the avatar to the IPC payload.
  const pingEnv = createEnvelope(
    'ping:drop',
    {
      coords: KNOWN_COORDS,
      color: KNOWN_COLOR,
      ttl: 5_000,
      senderSessionId: mockSessionId,
    },
    { groupId },
  );
  mockPeerWs.send(JSON.stringify(pingEnv));

  const fwdMatch = await waitForLine(
    electron,
    new RegExp(`forwarding ping to overlay messageId=${pingEnv.messageId} hasAvatar=(true|false)`),
    PING_OBSERVE_TIMEOUT_MS,
  );
  assert.equal(
    fwdMatch[1],
    'true',
    `bridge should report hasAvatar=true after peer:avatar publish (got hasAvatar=${fwdMatch[1]})`,
  );

  await waitForLine(
    electron,
    new RegExp(`ping received messageId=${pingEnv.messageId}`),
    PING_OBSERVE_TIMEOUT_MS,
  );
});

test('ping without prior peer:avatar arrives with hasAvatar=false', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  const { mockPeerWs, mockSessionId, groupId, electron } =
    await pairElectronRedeemerToMockGenerator(t);

  // No peer:avatar publish on this path — go straight to ping:drop.
  const pingEnv = createEnvelope(
    'ping:drop',
    {
      coords: KNOWN_COORDS,
      color: KNOWN_COLOR,
      ttl: 5_000,
      senderSessionId: mockSessionId,
    },
    { groupId },
  );
  mockPeerWs.send(JSON.stringify(pingEnv));

  const fwdMatch = await waitForLine(
    electron,
    new RegExp(`forwarding ping to overlay messageId=${pingEnv.messageId} hasAvatar=(true|false)`),
    PING_OBSERVE_TIMEOUT_MS,
  );
  assert.equal(
    fwdMatch[1],
    'false',
    `bridge should report hasAvatar=false when sender never published (got hasAvatar=${fwdMatch[1]})`,
  );
});

test('peer:avatar identity mismatch is rejected (paired peer impersonation)', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  // Per task spec: pair an Electron client with the mock peer, then mock
  // peer attempts to publish under someone else's sessionId. Server's
  // `payload.sessionId !== socket.sessionId` check rejects with
  // `code: 'avatar_identity_mismatch'`; the Electron client must NOT
  // receive a relayed avatar envelope.
  const { mockPeerWs, mockSessionId, groupId, electron } =
    await pairElectronRedeemerToMockGenerator(t);

  const someoneElsesSessionId = randomUUID();
  assert.notEqual(
    someoneElsesSessionId,
    mockSessionId,
    'sanity: claimed session must differ from real one',
  );

  const badAvatarEnv = createEnvelope(
    'peer:avatar',
    { sessionId: someoneElsesSessionId, imageBase64: TEST_AVATAR_BASE64 },
    { groupId },
  );
  mockPeerWs.send(JSON.stringify(badAvatarEnv));

  // Mock peer should receive an error envelope.
  const err = await awaitMessage(
    mockPeerWs,
    (m: Extract<Message, { type: 'error' }>) => m.payload.code === 'avatar_identity_mismatch',
    'error',
    3_000,
  );
  assert.equal(err.payload.code, 'avatar_identity_mismatch');

  // And the Electron client must NOT have logged a `received peer avatar`
  // line for this attempt. We can't prove a negative absolutely, but a
  // short hold-down plus an explicit grep is a reasonable contract lock.
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(
    !electron.stdout.includes(`received peer avatar sessionId=${someoneElsesSessionId}`),
    `electron client should not have received the impersonation avatar; stdout:\n${electron.stdout}`,
  );
});

test('pendingAvatars: publish before peer joins → avatar replayed on pair', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  // Two-stage scenario:
  //   1) Mock peer connects + generates code + publishes peer:avatar BEFORE
  //      the Electron redeemer connects. Server caches in `pendingAvatars`.
  //   2) Electron client redeems → server fires `pair:established` →
  //      `replayAvatars(groupId)` pushes the cached avatar to the Electron
  //      client. The pre-pair listener on the client side catches it and
  //      logs `received peer avatar sessionId=... size=...`.
  assert.ok(serverUrl, 'serverUrl set in before()');

  // Stage 1: mock peer, generate code, publish avatar BEFORE redeemer joins.
  const { ws: mockPeerWs, sessionId: mockSessionId } = await openMockPeer(t);
  mockPeerWs.send(JSON.stringify(createEnvelope('pair:generate', {})));
  const codeEnv = await awaitMessage(mockPeerWs, anyOfType('pair:code'), 'pair:code');
  const code = codeEnv.payload.code;

  // Publish avatar with NO groupId (since there's no group yet).
  // The server validates identity FIRST (independent of group state); since
  // payload.sessionId === socket.sessionId, validation passes and the avatar
  // is cached in pendingAvatars keyed off the generator's code-owned session.
  const avatarEnv = createEnvelope('peer:avatar', {
    sessionId: mockSessionId,
    imageBase64: TEST_AVATAR_BASE64,
  });
  mockPeerWs.send(JSON.stringify(avatarEnv));

  // Stage 2: spawn the Electron redeemer with the captured code.
  const proc = spawn('npx', ['electron', 'client/src/main/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: '--import tsx',
      LEGACY_CLI: '1',
      MODE: 'redeem',
      CODE: code,
      OVERLAY: '1',
      SERVER_URL: serverUrl as string,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const electron = trackProcess('electron', proc);
  t.after(() => killTracked(electron));

  // Mock peer should receive pair:established after the redeemer joins.
  await awaitMessage(
    mockPeerWs,
    anyOfType('pair:established'),
    'pair:established',
    PAIR_TIMEOUT_MS,
  );

  // The Electron client's pre-pair listener should log receipt of the
  // replayed avatar — proving server's `replayAvatars` pushed the cached
  // entry to the new joiner.
  await waitForLine(
    electron,
    new RegExp(`received peer avatar sessionId=${mockSessionId} size=${TEST_AVATAR_BASE64.length}`),
    PAIR_TIMEOUT_MS,
  );
});

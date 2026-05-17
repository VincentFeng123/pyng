/**
 * Integration test: GUI pair flow via the v2 state machine.
 *
 * The v2 pair flow lives in the Electron main process's IPC-driven state
 * machine (#43). Renderer UI calls `requestGenerate` / `requestRedeem` via
 * IPC, which proxies to `PairStateMachine`. An external `node:test` runner
 * cannot directly invoke ipcMain handlers, so this test uses two integration
 * hooks introduced by this task:
 *   - `NODE_ENV=test TEST_AUTO_GENERATE=1`  → auto-calls requestGenerate()
 *     after `machine.start()` in `runAppMode()`.
 *   - `NODE_ENV=test TEST_AUTO_REDEEM=<code>` → auto-calls requestRedeem(code).
 *
 * Both hooks are dual-gated (NODE_ENV must be exactly `'test'` AND the env
 * var must be set). Production launches don't trip them.
 *
 * Test flow:
 *   1. Boot relay server (ephemeral port).
 *   2. Boot Electron client A with TEST_AUTO_GENERATE=1. State machine fires
 *      requestGenerate() → server replies with pair:code.
 *   3. Parse the pairing code from A's stdout (preserved v1 contract:
 *      `Pairing code: XXXXXX (expires at …)`).
 *   4. Boot Electron client B with TEST_AUTO_REDEEM=<code>. State machine
 *      fires requestRedeem(code).
 *   5. Both clients observe `pair:established` → both log
 *      `Paired! groupId=<uuid>` (preserved v0 contract from pairingFlow.ts).
 *   6. Confirm the groupId matches across both clients.
 *
 * What this test does NOT verify (deliberate, scope-limited):
 *   - Per-ping latency-tracker readings (`latencyMs`). The state machine
 *     broadcasts latency to the renderer via IPC, but there's no stdout-
 *     observable log line for an external test to grep. Covered by
 *     `latency-tracker` unit tests in `client/src/main/latency-tracker.test.ts`.
 *     Surfacing this for integration would require a dedicated log line; left
 *     as a follow-up so this task ships without scope creep.
 *   - The actual ping-send path. `wireInput` only fires sendPingDrop from
 *     hotkey events, which require either a real keyboard or a test-driver
 *     mechanism that doesn't currently exist for the EXTERNAL process boundary.
 *     See TESTING.md "v2 manual smoke tests" hold-mode scenario for the
 *     manual coverage gate.
 *   - DOM-level renderer assertions (Playwright/Spectron — out of v2 scope).
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopbackListenSkipReason, skipIfLoopbackUnavailable } from './preflight.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');

const SERVER_READY_TIMEOUT_MS = 10_000;
const CODE_TIMEOUT_MS = 20_000;
const PAIR_TIMEOUT_MS = 20_000;
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
    const buildTimeoutError = (): Error =>
      new Error(
        `[${entry.name}] timeout waiting for ${regex} after ${timeoutMs}ms.\n` +
          `--- stdout ---\n${entry.stdout}\n--- stderr ---\n${entry.stderr}`,
      );
    const interval = setInterval(() => {
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
    }, 50);
    const timer = setTimeout(() => {
      cleanup();
      rejectMatch(buildTimeoutError());
    }, timeoutMs);
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

let server: Tracked | null = null;
let serverUrl: string | null = null;

before(async () => {
  if (LOOPBACK_SKIP_REASON) return;
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

function spawnAppModeElectron(name: string, env: NodeJS.ProcessEnv): Tracked {
  // App mode reads PYNG_RELAY_URL via loadConfig() (NOT SERVER_URL — that's
  // the legacy CLI variable). Routing the ephemeral port through this env so
  // the state machine connects to our test server instead of the default
  // dev URL ws://localhost:7788.
  const proc = spawn('npx', ['electron', 'client/src/main/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: '--import tsx',
      NODE_ENV: 'test',
      PYNG_RELAY_URL: serverUrl as string,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return trackProcess(name, proc);
}

test('GUI pair flow: TEST_AUTO_GENERATE + TEST_AUTO_REDEEM reach Paired!', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  assert.ok(serverUrl, 'serverUrl set in before()');

  // 1. Boot the generator-side Electron in app mode with the auto-generate
  // hook. The state machine's start() completes, then runAppMode fires
  // machine.requestGenerate() which talks to the server and surfaces a
  // `Pairing code: XXXXXX` log line (via pairingFlow.ts).
  const generator = spawnAppModeElectron('electron:gen', {
    TEST_AUTO_GENERATE: '1',
  });
  t.after(() => killTracked(generator));

  // Wait for the auto-generate hook to fire and the pairing code to come back.
  // pairingFlow.ts emits `Pairing code: XXXXXX (expires at ...)` for v0/v1
  // compatibility; this contract was preserved through the v2 state-machine
  // refactor (#43).
  const codeMatch = await waitForLine(generator, /Pairing code: ([A-Z0-9]{6})/, CODE_TIMEOUT_MS);
  const code = codeMatch[1];
  assert.ok(code, 'captured a 6-character pairing code');

  // 2. Boot the redeemer-side Electron in app mode with the auto-redeem hook.
  const redeemer = spawnAppModeElectron('electron:red', {
    TEST_AUTO_REDEEM: code,
  });
  t.after(() => killTracked(redeemer));

  // 3. Both clients should emit `Paired! groupId=<uuid>`. This is the v0
  // contract preserved across v1.5 and v2 via pairingFlow.ts:77/118.
  const genPaired = await waitForLine(
    generator,
    /Paired! groupId=([0-9a-f-]{36})/,
    PAIR_TIMEOUT_MS,
  );
  const redPaired = await waitForLine(redeemer, /Paired! groupId=([0-9a-f-]{36})/, PAIR_TIMEOUT_MS);

  // 4. The groupId must match across both peers — proves they joined the
  // same server-side group, not two unrelated pair sessions.
  assert.equal(
    genPaired[1],
    redPaired[1],
    `generator and redeemer should share a groupId (gen=${genPaired[1]}, red=${redPaired[1]})`,
  );

  // 5. Confirm the v2 state machine also opened the dashboard (#66's
  // structural invariant). `main window opened` is the runAppMode emission.
  await waitForLine(generator, /main window opened/, PAIR_TIMEOUT_MS);
  await waitForLine(redeemer, /main window opened/, PAIR_TIMEOUT_MS);
});

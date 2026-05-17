/**
 * Regression test for #67: legacy modes must NOT open the consolidated
 * dashboard window introduced by #66, while app and solo modes do.
 *
 * Asserts a structural invariant of `client/src/main/index.ts`:
 *   - `runAppMode()` and `runSoloMode()` are the dashboard callers.
 *   - `parseConfig()` returns `'app'` mode only when no LEGACY_CLI / SOLO /
 *     SETTINGS flag/env is set.
 *   - Therefore legacy CLI generate/redeem do not log `main window opened`.
 *
 * Four cases are exercised:
 *   1. LEGACY_CLI=1 MODE=generate → expect `[client:generate]`, NO mount log.
 *   2. LEGACY_CLI=1 MODE=redeem  → expect `[client:redeem]`,  NO mount log.
 *      (Uses a bogus CODE; client will get `pair:invalid` and exit 1, but
 *      not before the positive-control prefix lands and the negative window
 *      passes.)
 *   3. SOLO=1                     → expect `main window opened`.
 *   4. (no env, app mode)         → expect `main window opened` (POSITIVE
 *      control — catches the inverse regression where #66 accidentally gates
 *      the dashboard behind a flag).
 *
 * Test infrastructure mirrors `ping-roundtrip.test.ts`: shared server in
 * module-level `before()`, per-test Electron via `t.after()`, module-level
 * orphan-assert in `after()`.
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
const POSITIVE_LOG_TIMEOUT_MS = 10_000;
const NEGATIVE_OBSERVATION_WINDOW_MS = 5_000;
const APP_MODE_MOUNT_TIMEOUT_MS = 15_000;
const DASHBOARD_MOUNT_REGEX = /main window opened/;
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

function spawnElectron(name: string, env: NodeJS.ProcessEnv): Tracked {
  const proc = spawn('npx', ['electron', 'client/src/main/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_OPTIONS: '--import tsx', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return trackProcess(name, proc);
}

async function assertNotEmittedWithin(
  entry: Tracked,
  regex: RegExp,
  windowMs: number,
): Promise<void> {
  await new Promise((res) => setTimeout(res, windowMs));
  assert.ok(
    !regex.test(entry.stdout),
    `[${entry.name}] expected NOT to emit ${regex} within ${windowMs}ms but did.\n` +
      `--- stdout ---\n${entry.stdout}\n--- stderr ---\n${entry.stderr}`,
  );
}

test('legacy generate mode does not open the dashboard', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  assert.ok(serverUrl, 'serverUrl set in before()');
  const electron = spawnElectron('electron:legacy-generate', {
    LEGACY_CLI: '1',
    MODE: 'generate',
    SERVER_URL: serverUrl,
  });
  t.after(() => killTracked(electron));

  // Positive control: the legacy generate path logs `[client:generate]`
  // from its first connect message.
  await waitForLine(electron, /\[client:generate\]/, POSITIVE_LOG_TIMEOUT_MS);

  // Negative: the dashboard mount log must NOT appear within the observation
  // window. Dashboard startup is unreachable from this legacy env.
  await assertNotEmittedWithin(electron, DASHBOARD_MOUNT_REGEX, NEGATIVE_OBSERVATION_WINDOW_MS);
});

test('legacy redeem mode does not open the dashboard', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  assert.ok(serverUrl, 'serverUrl set in before()');
  // A bogus code triggers pair:invalid and the client exits 1, but the
  // positive-control log line lands before that; the negative window
  // completes inside the 5s before the exit propagates.
  const electron = spawnElectron('electron:legacy-redeem', {
    LEGACY_CLI: '1',
    MODE: 'redeem',
    CODE: 'AAAAAA',
    SERVER_URL: serverUrl,
  });
  t.after(() => killTracked(electron));

  await waitForLine(electron, /\[client:redeem\]/, POSITIVE_LOG_TIMEOUT_MS);
  await assertNotEmittedWithin(electron, DASHBOARD_MOUNT_REGEX, NEGATIVE_OBSERVATION_WINDOW_MS);
});

test('solo mode DOES open the dashboard', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  const electron = spawnElectron('electron:solo', {
    SOLO: '1',
  });
  t.after(() => killTracked(electron));

  await waitForLine(electron, DASHBOARD_MOUNT_REGEX, APP_MODE_MOUNT_TIMEOUT_MS);
});

test('app mode (no flag) DOES open the dashboard — positive control', async (t) => {
  if (skipIfLoopbackUnavailable(t, LOOPBACK_SKIP_REASON)) return;
  assert.ok(serverUrl, 'serverUrl set in before()');
  // No LEGACY_CLI / SOLO / SETTINGS env: parseConfig returns 'app', and
  // runAppMode calls createMainWindow + logs `main window opened`.
  const electron = spawnElectron('electron:app', {
    SERVER_URL: serverUrl,
  });
  t.after(() => killTracked(electron));

  await waitForLine(electron, DASHBOARD_MOUNT_REGEX, APP_MODE_MOUNT_TIMEOUT_MS);
});

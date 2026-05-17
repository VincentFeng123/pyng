/**
 * dev-peer — v1 ping-test launcher.
 *
 * Boots the relay server, an Electron client in overlay-redeem mode, and a
 * mock-peer in interactive generate mode. The mock-peer's stdin is INHERITED
 * from the parent terminal so the user's `p` / `c` / `q` keypresses reach
 * mock-peer's raw-mode stdin handler. The Electron client receives the
 * relayed `ping:drop` envelopes and renders them on its transparent overlay.
 *
 * Wired to `npm run dev:peer`.
 *
 * Behavior summary:
 *   1. Spawn server, wait for `"event":"listening"`.
 *   2. Spawn mock-peer (generate + interactive), parse `code = XXXXXX` from
 *      its stdout.
 *   3. Spawn Electron client (redeem + overlay), feed it the captured code.
 *   4. After both peers log a paired marker, print the READY banner.
 *   5. Run indefinitely until either the mock-peer exits (user pressed 'q')
 *      or SIGINT/SIGTERM reaches the orchestrator. In either case, kill
 *      remaining children and exit cleanly.
 *
 * Differences from dev.ts (deliberate, not refactor candidates):
 *   - Mock-peer stdio is `['inherit', 'pipe', 'pipe']`. dev.ts uses fully
 *     piped stdio because it never needs interactive input.
 *   - No 30-second hard timeout — overlay sessions are long-lived.
 *   - No auto-shutdown on pair: the whole point is to stay alive for
 *     interactive ping testing.
 *
 * Deferred (NOT here):
 *   - PNG/screenshot capture of the overlay (verification by camera/Loom)
 *   - automatic ping injection (would replace the user's keypresses)
 *   - multi-client (>2-peer) topology tests
 */

import { spawn, type ChildProcess } from 'node:child_process';

const CONFIGURED_SERVER_URL = process.env.SERVER_URL;
const SERVER_PORT = process.env.PORT ?? (CONFIGURED_SERVER_URL ? '7788' : '0');
const SERVER_HOST = process.env.HOST ?? '127.0.0.1';
let activeServerUrl = CONFIGURED_SERVER_URL ?? `ws://${SERVER_HOST}:7788`;
const CODE_REGEX = /code = ([A-Z0-9]{6})/;
const ELECTRON_PAIRED_REGEX = /Paired! groupId=/;
const MOCK_PAIRED_REGEX = /paired groupId=/;
const LISTENING_REGEX = /"event":"listening","port":(\d+)/;

type Child = {
  name: string;
  proc: ChildProcess;
  exitCode: number | null;
};

const children: Child[] = [];
let shuttingDown = false;
let pairingCode: string | null = null;
let mockPaired = false;
let electronPaired = false;
let readyAnnounced = false;

function log(line: string): void {
  process.stdout.write(`[dev-peer] ${line}\n`);
}

function streamWithPrefix(
  stream: NodeJS.ReadableStream,
  prefix: string,
  out: NodeJS.WritableStream,
  onLine?: (line: string) => void,
): void {
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      out.write(`${prefix} ${line}\n`);
      if (onLine) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      out.write(`${prefix} ${buf}\n`);
      if (onLine) onLine(buf);
      buf = '';
    }
  });
}

function trackChild(name: string, proc: ChildProcess): Child {
  const child: Child = { name, proc, exitCode: null };
  children.push(child);
  proc.on('exit', (code) => {
    child.exitCode = code ?? 0;
    log(`${name} exited code=${child.exitCode}`);
    onChildExit(child);
  });
  proc.on('error', (err) => {
    process.stderr.write(`[dev-peer] ${name} spawn error: ${err.message}\n`);
    shutdown(1);
  });
  return child;
}

function onChildExit(child: Child): void {
  if (shuttingDown) return;
  // Any child exiting in dev-peer means the session is over; tear everything
  // down. Exit code 0 if the trigger was the mock-peer quitting cleanly
  // (user pressed 'q'), 1 otherwise (premature failure, electron crash, etc.).
  const cleanMockQuit = child.name === 'mock-peer' && child.exitCode === 0;
  if (cleanMockQuit) {
    log('mock-peer quit cleanly — shutting down remaining children');
    shutdown(0);
    return;
  }
  process.stderr.write(
    `[dev-peer] ${child.name} exited unexpectedly (code=${child.exitCode}) — shutting down\n`,
  );
  shutdown(child.exitCode === 0 ? 0 : 1);
}

function killChild(child: Child): void {
  if (child.exitCode !== null) return;
  try {
    child.proc.kill('SIGTERM');
  } catch {
    // ignore
  }
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) killChild(c);
  const allExited = (): boolean => children.every((c) => c.exitCode !== null);
  const finish = (): void => {
    if (allExited()) process.exit(code);
  };
  for (const c of children) c.proc.on('exit', finish);
  finish();
  // Hard escalation: SIGKILL after 3s if anything is still alive.
  setTimeout(() => {
    for (const c of children) {
      if (c.exitCode === null) {
        try {
          c.proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    process.exit(code);
  }, 3_000).unref();
}

function maybeAnnounceReady(): void {
  if (readyAnnounced) return;
  if (!mockPaired || !electronPaired) return;
  readyAnnounced = true;
  log(
    "READY — focus the terminal running mock-peer and press 'p' to drop a ping. Press Ctrl+C to quit.",
  );
}

type SpawnedChild = {
  proc: ChildProcess;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
};

function spawnPiped(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: 'inherit' | 'ignore' = 'ignore',
): SpawnedChild {
  const proc = spawn(cmd, args, {
    cwd: process.cwd(),
    env,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  if (!proc.stdout || !proc.stderr) {
    throw new Error(`spawn ${cmd} did not return piped stdout/stderr`);
  }
  return { proc, stdout: proc.stdout, stderr: proc.stderr };
}

function spawnServer(): Child {
  log('starting server');
  const { proc, stdout, stderr } = spawnPiped(
    process.execPath,
    ['--import', 'tsx', 'server/src/index.ts'],
    {
      ...process.env,
      PORT: SERVER_PORT,
      HOST: SERVER_HOST,
    },
  );
  const child = trackChild('server', proc);
  streamWithPrefix(stdout, '[server]', process.stdout, (line) => {
    const match = LISTENING_REGEX.exec(line);
    if (match) onServerReady(Number(match[1]));
  });
  streamWithPrefix(stderr, '[server!]', process.stderr);
  return child;
}

let serverReady = false;
function onServerReady(port: number): void {
  if (serverReady) return;
  serverReady = true;
  if (!CONFIGURED_SERVER_URL) {
    activeServerUrl = `ws://${SERVER_HOST}:${port}`;
  }
  log('server ready — spawning mock-peer (generate + interactive)');
  spawnMockPeer();
}

function spawnMockPeer(): Child {
  // stdin inherited so raw-mode keypresses reach mock-peer directly.
  const { proc, stdout, stderr } = spawnPiped(
    process.execPath,
    ['--import', 'tsx', 'scripts/mock-peer.ts'],
    {
      ...process.env,
      MODE: 'generate',
      MOCK_PEER_INTERACTIVE: '1',
      SERVER_URL: activeServerUrl,
    },
    'inherit',
  );
  const child = trackChild('mock-peer', proc);
  streamWithPrefix(stdout, '[mock-peer]', process.stdout, (line) => {
    const m = CODE_REGEX.exec(line);
    if (m && !pairingCode) {
      pairingCode = m[1] ?? null;
      if (pairingCode) {
        log(`captured pairing code ${pairingCode} — spawning Electron redeemer`);
        spawnElectronRedeemer(pairingCode);
      }
    }
    if (MOCK_PAIRED_REGEX.test(line)) {
      mockPaired = true;
      maybeAnnounceReady();
    }
  });
  streamWithPrefix(stderr, '[mock-peer!]', process.stderr);
  return child;
}

function spawnElectronRedeemer(code: string): Child {
  const { proc, stdout, stderr } = spawnPiped(
    'npx',
    ['electron', 'client/src/main/index.ts'],
    {
      ...process.env,
      NODE_OPTIONS: '--import tsx',
      LEGACY_CLI: '1',
      MODE: 'redeem',
      CODE: code,
      OVERLAY: '1',
      DEV_STATUS: '1',
      DEV_PING_AT_CURSOR: '1',
      SERVER_URL: activeServerUrl,
    },
    'ignore',
  );
  const child = trackChild('electron', proc);
  streamWithPrefix(stdout, '[client]', process.stdout, (line) => {
    if (ELECTRON_PAIRED_REGEX.test(line)) {
      electronPaired = true;
      maybeAnnounceReady();
    }
  });
  streamWithPrefix(stderr, '[client!]', process.stderr);
  return child;
}

process.on('SIGINT', () => {
  log('SIGINT — shutting down');
  shutdown(0);
});
process.on('SIGTERM', () => {
  log('SIGTERM — shutting down');
  shutdown(0);
});
process.on('exit', () => {
  for (const c of children) {
    if (c.exitCode === null) {
      try {
        c.proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }
});

log('starting ping-test session');
spawnServer();

/**
 * dev — v0 orchestrator.
 *
 * Boots the relay server, then drives a generate-side Electron client + a
 * redeem-side peer through the pairing handshake. The redeem side is another
 * Electron instance by default, or the mock-peer script when invoked with --mock.
 *
 * Wired to root scripts:
 *   npm run dev        → server + two Electron clients (generate + redeem)
 *   npm run dev:mock   → server + Electron generate + mock-peer redeem
 *
 * Acceptance behavior:
 *   - Server listening detected via `"event":"listening"` line on its stdout.
 *   - Generator's code parsed from `Pairing code: XXXXXX` (regex below).
 *   - Both peers must log `Paired!` and exit 0 → orchestrator exits 0.
 *   - 30-second hard timeout if pairing isn't observed → exits 1.
 *
 * Deferred (intentionally NOT here):
 *   - restart-on-crash, hot reload, watch-mode for the client
 *   - packaging, signing, CI-specific tuning
 *   - latency / packet-loss simulation (lives in mock-peer when added)
 */

import { spawn, type ChildProcess } from 'node:child_process';

const CONFIGURED_SERVER_URL = process.env.SERVER_URL;
const SERVER_PORT = process.env.PORT ?? (CONFIGURED_SERVER_URL ? '7788' : '0');
const SERVER_HOST = process.env.HOST ?? '127.0.0.1';
let activeServerUrl = CONFIGURED_SERVER_URL ?? `ws://${SERVER_HOST}:7788`;
const HARD_TIMEOUT_MS = 30_000;
const CODE_REGEX = /Pairing code: ([A-Z0-9]{6})/;
const PAIRED_REGEX = /Paired!/;
const LISTENING_REGEX = /"event":"listening","port":(\d+)/;

type Child = {
  name: string;
  proc: ChildProcess;
  exitCode: number | null;
};

const children: Child[] = [];
const mockMode = process.argv.includes('--mock');

let shuttingDown = false;
let pairedGen = false;
let pairedRed = false;
let pairingCode: string | null = null;

const hardTimeout = setTimeout(() => {
  process.stderr.write(`[dev] hard timeout: pairing not observed within ${HARD_TIMEOUT_MS}ms\n`);
  shutdown(1);
}, HARD_TIMEOUT_MS);

function log(line: string): void {
  process.stdout.write(`[dev] ${line}\n`);
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
    process.stderr.write(`[dev] ${name} spawn error: ${err.message}\n`);
    shutdown(1);
  });
  return child;
}

function onChildExit(child: Child): void {
  if (shuttingDown) return;
  if (child.name === 'server') {
    // Server is killed only by us at the end of a successful run.
    if (pairedGen && pairedRed) return;
    process.stderr.write(`[dev] server exited prematurely (code=${child.exitCode})\n`);
    shutdown(1);
    return;
  }
  if (child.exitCode !== 0) {
    process.stderr.write(`[dev] ${child.name} exited non-zero (code=${child.exitCode})\n`);
    shutdown(1);
    return;
  }
  maybeFinish();
}

function maybeFinish(): void {
  if (!pairedGen || !pairedRed) return;
  const gen = children.find((c) => c.name === 'gen');
  const red = children.find((c) => c.name === 'red' || c.name === 'mock-red');
  if (!gen || !red) return;
  if (gen.exitCode === 0 && red.exitCode === 0) {
    log('both peers paired and exited cleanly — shutting down server');
    shutdown(0);
  }
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
  clearTimeout(hardTimeout);
  for (const c of children) killChild(c);
  // Give children up to 2s to exit before hard-exiting the orchestrator.
  setTimeout(() => process.exit(code), 2_000).unref();
  // If they all exit sooner, exit immediately.
  const allExited = (): boolean => children.every((c) => c.exitCode !== null);
  const check = (): void => {
    if (allExited()) process.exit(code);
  };
  for (const c of children) c.proc.on('exit', check);
  check();
}

function pipedSpawn(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { proc: ChildProcess; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream } {
  const proc = spawn(cmd, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!proc.stdout || !proc.stderr) {
    throw new Error(`spawn ${cmd} did not return piped stdout/stderr`);
  }
  return { proc, stdout: proc.stdout, stderr: proc.stderr };
}

function spawnServer(): Child {
  log('starting server');
  const { proc, stdout, stderr } = pipedSpawn(
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
  log('server ready — spawning generate-side client');
  spawnGenerator();
}

function spawnGenerator(): Child {
  const { proc, stdout, stderr } = pipedSpawn('npx', ['electron', 'client/src/main/index.ts'], {
    ...process.env,
    NODE_OPTIONS: '--import tsx',
    LEGACY_CLI: '1',
    MODE: 'generate',
    SERVER_URL: activeServerUrl,
  });
  const child = trackChild('gen', proc);
  streamWithPrefix(stdout, '[gen]', process.stdout, (line) => {
    const m = CODE_REGEX.exec(line);
    if (m && !pairingCode) {
      pairingCode = m[1] ?? null;
      if (pairingCode) {
        log(`captured pairing code ${pairingCode} — spawning redeem-side peer`);
        spawnRedeemer(pairingCode);
      }
    }
    if (PAIRED_REGEX.test(line)) {
      pairedGen = true;
      log('generate peer logged Paired!');
    }
  });
  streamWithPrefix(stderr, '[gen!]', process.stderr);
  return child;
}

function spawnRedeemer(code: string): Child {
  if (mockMode) {
    const { proc, stdout, stderr } = pipedSpawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/mock-peer.ts'],
      {
        ...process.env,
        MODE: 'redeem',
        CODE: code,
        SERVER_URL: activeServerUrl,
      },
    );
    const child = trackChild('mock-red', proc);
    streamWithPrefix(stdout, '[mock-red]', process.stdout, (line) => {
      // mock-peer logs "paired groupId=" rather than "Paired!".
      if (/paired groupId=/.test(line)) {
        pairedRed = true;
        log('mock-peer redeemer paired');
      }
    });
    streamWithPrefix(stderr, '[mock-red!]', process.stderr);
    return child;
  }
  const { proc, stdout, stderr } = pipedSpawn('npx', ['electron', 'client/src/main/index.ts'], {
    ...process.env,
    NODE_OPTIONS: '--import tsx',
    LEGACY_CLI: '1',
    MODE: 'redeem',
    CODE: code,
    SERVER_URL: activeServerUrl,
  });
  const child = trackChild('red', proc);
  streamWithPrefix(stdout, '[red]', process.stdout, (line) => {
    if (PAIRED_REGEX.test(line)) {
      pairedRed = true;
      log('redeem peer logged Paired!');
    }
  });
  streamWithPrefix(stderr, '[red!]', process.stderr);
  return child;
}

process.on('SIGINT', () => {
  log('SIGINT — shutting down');
  shutdown(130);
});
process.on('SIGTERM', () => {
  log('SIGTERM — shutting down');
  shutdown(143);
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

log(mockMode ? 'starting in --mock mode' : 'starting in dual-electron mode');
spawnServer();

/**
 * dev-solo — v2 visual-only demo launcher.
 *
 * Spawns a single Electron process in SOLO mode:
 *   - opens the transparent overlay window
 *   - registers the user's configured hotkey
 *   - on hold-then-click, echoes a LOCAL ping (no server, no peer)
 *
 * Useful for tweaking the overlay's visual surface or hotkey responsiveness
 * without standing up the relay server, mock-peer, or pairing flow.
 *
 * Wired to `npm run dev:solo`.
 *
 * Behavior:
 *   1. Spawn Electron with SOLO=1.
 *   2. Stream stdout/stderr through with a [solo] prefix.
 *   3. Exit on SIGINT after forwarding to the child.
 */
import { spawn, type ChildProcess } from 'node:child_process';

function log(line: string): void {
  process.stdout.write(`[solo] ${line}\n`);
}

function streamWithPrefix(
  stream: NodeJS.ReadableStream,
  prefix: string,
  out: NodeJS.WritableStream,
): void {
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      out.write(`${prefix} ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      out.write(`${prefix} ${buf}\n`);
      buf = '';
    }
  });
}

log('starting Electron in SOLO mode');
const proc: ChildProcess = spawn('npx', ['electron', 'client/src/main/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_OPTIONS: '--import tsx',
    SOLO: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (proc.stdout) streamWithPrefix(proc.stdout, '[client]', process.stdout);
if (proc.stderr) streamWithPrefix(proc.stderr, '[client!]', process.stderr);

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (proc.exitCode === null) {
    try {
      proc.kill('SIGINT');
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    process.exit(code);
  }, 3_000).unref();
}

proc.on('exit', (code) => {
  log(`Electron exited code=${code ?? 0}`);
  shutdown(code ?? 0);
});
proc.on('error', (err) => {
  process.stderr.write(`[solo] spawn error: ${err.message}\n`);
  shutdown(1);
});

process.on('SIGINT', () => {
  log('SIGINT — shutting down');
  shutdown(0);
});
process.on('SIGTERM', () => {
  log('SIGTERM — shutting down');
  shutdown(0);
});

/**
 * mock-peer — v0/v1.5/v2 driver for one side of the pairing handshake.
 *
 * Drives one side of the pairing handshake against the local relay server.
 * Run via `node --import tsx scripts/mock-peer.ts`. Two instances (one
 * generate, one redeem) pair through the server. Intended for solo-developer
 * iteration without a second physical machine.
 *
 * Env / CLI:
 *   MODE                   'generate' | 'redeem'        required (or implied by --gui-pair)
 *   CODE                   6-char pairing code          required when MODE=redeem (unless --gui-pair)
 *   SERVER_URL             ws://host:port               default ws://localhost:7788
 *   MOCK_PEER_INTERACTIVE  '1' to enable keypress mode  default off
 *   --interactive          alias for MOCK_PEER_INTERACTIVE=1
 *   --gui-pair             v2: prompts stdin for a code typed in by the dev
 *                          (e.g., relayed from the Electron GUI's pairing UI).
 *                          Implies MODE=redeem; ignores CODE env.
 *   MOCK_PEER_ECHO_PING    '1' to send a mirroring ping:drop ~100ms after each
 *                          received ping:drop. Useful for round-trip latency
 *                          testing now that v2 has client-side ping:ack flow.
 *                          Effective only in interactive mode.
 *   MOCK_PEER_AVATAR_PATH  Path to a PNG/JPG file to publish as this peer's
 *                          avatar (base64-encoded as-is; no normalization —
 *                          assume the dev provided a 64×64 image). Defaults
 *                          to the baked-in 32×32 purple square if unset.
 *                          Refuses oversized images via MAX_AVATAR_BASE64_LEN.
 *
 * Default (no flags, no env) behavior is preserved: pair, linger ~2s, exit 0.
 * This keeps `npm run dev:mock` regression-safe.
 *
 * Interactive mode: after pair:established, enters a stdin loop:
 *   'p' → send ping:drop at random normalized coords with a rotating color
 *   'c' → send ping:clear
 *   'q' → clean close (exit 0)
 * Ctrl-C also exits cleanly.
 *
 * Interactive mode ALSO logs incoming `ping:drop`, `ping:ack`, and `peer:avatar`
 * envelopes from the real peer/server. Logging summaries only (no payload bytes
 * for avatars) so the dev can verify wire activity without spamming the terminal.
 *
 * Publishes the chosen avatar via `peer:avatar` immediately after pair:established
 * so the Electron overlay can render real avatar bytes in dev:peer demos.
 *
 * Deferred to a later iteration (intentionally NOT implemented here):
 *   - MOCK_LATENCY_MS: artificial send-side latency on outbound messages
 *   - MOCK_PACKET_LOSS: probabilistic drop of inbound/outbound frames
 *   - MOCK_RESOLUTION: simulated peer display resolution for coord translation
 *   - stub overlay window for visual confirmation of incoming pings
 *
 * v3 additions (username announce / match flow):
 *   MOCK_PEER_DETECTED_USERNAME
 *     The username the mock peer will "detect" via synthetic OCR and announce
 *     to the real client. Set this to the real client's robloxUsername so the
 *     matcher fires immediately. Defaults to DEFAULT_MOCK_DETECTED_USERNAME.
 *     Example: MOCK_PEER_DETECTED_USERNAME=PhantomPro npm run dev:mock
 *
 *   Behavior (non-interactive mode only):
 *     5 seconds after pair:established, sends one username:announce envelope.
 *     Then waits up to 3 seconds for a username:match response.
 *     Logs "[mock-peer] username:match received matched=<bool>" on success.
 *     Logs "[mock-peer] username:match timeout" if 3 seconds pass with no reply.
 */

import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import {
  createEnvelope,
  isMessage,
  MAX_AVATAR_BASE64_LEN,
  type Message,
  type Platform,
} from '@pyng/shared';

const CLIENT_VERSION = '0.0.0-mock';
const HARD_TIMEOUT_MS = 30_000;
const POST_PAIR_LINGER_MS = 2_000;
const USERNAME_ANNOUNCE_DELAY_MS = 5_000;
const USERNAME_MATCH_TIMEOUT_MS = 3_000;
// Default detected username for the synthetic OCR announce. Override via
// MOCK_PEER_DETECTED_USERNAME to match the real client's robloxUsername.
const DEFAULT_MOCK_DETECTED_USERNAME = 'MockSpectatedPlayer';
const PING_TTL_MS = 1_500;
const ECHO_PING_DELAY_MS = 100;
const PING_COLORS = ['#ff3344', '#33ff66', '#3366ff', '#ffcc33'] as const;

// 32×32 solid #7c3aed (pyng accent purple) PNG, 8-bit RGBA, 104 bytes on disk.
// Hardcoded so the demo is reproducible without an external fixture file.
// Deliberately 32×32 (not 64×64) to exercise the renderer's scale-to-slot path
// — catches "renderer assumes 64×64" regressions.
//
// Regenerate with (pure Node, no deps):
//   node -e 'const z=require("node:zlib");const W=32,H=32,R=0x7c,G=0x3a,B=0xed;
//     const raw=Buffer.alloc(H*(1+W*4));
//     for(let y=0;y<H;y++){const o=y*(1+W*4);raw[o]=0;
//       for(let x=0;x<W;x++){const p=o+1+x*4;raw[p]=R;raw[p+1]=G;raw[p+2]=B;raw[p+3]=255;}}
//     const idat=z.deflateSync(raw);
//     const crc32=b=>{let c,r=0xffffffff;for(let i=0;i<b.length;i++){c=(r^b[i])&0xff;
//       for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;r=(r>>>8)^c;}return(r^0xffffffff)>>>0;};
//     const ck=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);
//       const tb=Buffer.from(t,"ascii"),cb=Buffer.alloc(4);cb.writeUInt32BE(crc32(Buffer.concat([tb,d])),0);
//       return Buffer.concat([l,tb,d,cb]);};
//     const sig=Buffer.from([137,80,78,71,13,10,26,10]),ihdr=Buffer.alloc(13);
//     ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=6;
//     console.log(Buffer.concat([sig,ck("IHDR",ihdr),ck("IDAT",idat),ck("IEND",Buffer.alloc(0))]).toString("base64"));'
const TEST_AVATAR_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMHKRjcpkgBg3E/Or6b2kEhAQEBAQEBAQEBAQEBAQSAceEceIl/4VGFEAAAAASUVORK5CYII=';

type Mode = 'generate' | 'redeem';

function resolveGuiPair(): boolean {
  return process.argv.includes('--gui-pair');
}

function readMode(guiPair: boolean): Mode {
  // --gui-pair implies redeem mode regardless of MODE env. The dev provides
  // the code interactively via stdin after the GUI peer generates one.
  if (guiPair) return 'redeem';
  const raw = process.env.MODE;
  if (raw !== 'generate' && raw !== 'redeem') {
    process.stderr.write(
      `[mock-peer] MODE env var must be 'generate' or 'redeem' (got: ${JSON.stringify(raw)})\n`,
    );
    process.exit(2);
  }
  return raw;
}

function readCode(): string {
  const code = process.env.CODE;
  if (!code || code.length === 0) {
    process.stderr.write(`[mock-peer:redeem] CODE env var is required when MODE=redeem\n`);
    process.exit(2);
  }
  return code;
}

function resolvePlatform(): Platform {
  const raw = process.platform;
  if (raw === 'win32' || raw === 'darwin' || raw === 'linux') {
    return raw;
  }
  return 'linux';
}

function resolveInteractive(): boolean {
  if (process.argv.includes('--interactive')) return true;
  return process.env.MOCK_PEER_INTERACTIVE === '1';
}

function resolveEchoPing(): boolean {
  return process.env.MOCK_PEER_ECHO_PING === '1';
}

function resolveDetectedUsername(): string {
  const raw = process.env.MOCK_PEER_DETECTED_USERNAME;
  return raw && raw.length > 0 ? raw : DEFAULT_MOCK_DETECTED_USERNAME;
}

function resolveAvatar(): string {
  const path = process.env.MOCK_PEER_AVATAR_PATH;
  if (!path || path.length === 0) return TEST_AVATAR_BASE64;
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    process.stderr.write(
      `[mock-peer] failed to read MOCK_PEER_AVATAR_PATH (${path}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  const b64 = buf.toString('base64');
  if (b64.length > MAX_AVATAR_BASE64_LEN) {
    process.stderr.write(
      `[mock-peer] MOCK_PEER_AVATAR_PATH (${path}) exceeds MAX_AVATAR_BASE64_LEN (${b64.length} > ${MAX_AVATAR_BASE64_LEN}); refusing to publish.\n`,
    );
    process.exit(2);
  }
  return b64;
}

const guiPair = resolveGuiPair();
const mode = readMode(guiPair);
const prefix = `[mock-peer:${mode}]`;
const serverUrl = process.env.SERVER_URL ?? 'ws://localhost:7788';
const interactive = resolveInteractive();
const echoPing = resolveEchoPing();
const activeAvatarBase64 = resolveAvatar();
const detectedUsername = resolveDetectedUsername();

function log(...args: unknown[]): void {
  process.stdout.write(
    `${prefix} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
  );
}

let exited = false;
let groupId: string | null = null;
let sessionId: string | null = null;
let interactiveActive = false;
let colorIndex = 0;
let usernameMatchTimer: ReturnType<typeof setTimeout> | null = null;

function teardownStdin(): void {
  if (!interactiveActive) return;
  interactiveActive = false;
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.removeListener('data', onStdinData);
    process.stdin.pause();
  } catch {
    // ignore
  }
}

function exit(code: number): void {
  if (exited) return;
  exited = true;
  clearTimeout(hardTimeout);
  teardownStdin();
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'mock_peer_done');
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  } catch {
    // ignore
  }
  process.exit(code);
}

const hardTimeout = setTimeout(() => {
  log('timeout: no terminal state reached within', HARD_TIMEOUT_MS, 'ms');
  exit(2);
}, HARD_TIMEOUT_MS);

const ws = new WebSocket(serverUrl);

ws.on('open', () => {
  log('connected', serverUrl);
  const hello = createEnvelope('hello', {
    clientVersion: CLIENT_VERSION,
    platform: resolvePlatform(),
  });
  ws.send(JSON.stringify(hello));
});

ws.on('message', (raw) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    log('protocol error: malformed json from server');
    exit(1);
    return;
  }
  if (!isMessage(parsed)) {
    log('protocol error: invalid envelope from server');
    exit(1);
    return;
  }
  onMessage(parsed);
});

ws.on('close', (code, reason) => {
  if (!exited) {
    log('server closed connection', { code, reason: reason.toString() });
    exit(1);
  }
});

ws.on('error', (err) => {
  log('socket error:', err.message);
  exit(1);
});

function onMessage(msg: Message): void {
  switch (msg.type) {
    case 'welcome': {
      sessionId = msg.payload.sessionId;
      log('welcome sessionId=', sessionId);
      if (mode === 'generate') {
        const env = createEnvelope('pair:generate', {});
        ws.send(JSON.stringify(env));
      } else if (guiPair) {
        // v2 GUI-pair flow: prompt for a code typed in by the dev (relayed
        // from the Electron GUI's pairing screen). Stdin is consumed in
        // cooked/line-buffered mode here; if interactive mode is also enabled,
        // its later setRawMode(true) call attaches its own handler after this
        // promise resolves.
        promptForCode()
          .then((code) => {
            const env = createEnvelope('pair:redeem', { code });
            ws.send(JSON.stringify(env));
          })
          .catch((err) => {
            log('gui-pair prompt failed:', err instanceof Error ? err.message : String(err));
            exit(2);
          });
      } else {
        const code = readCode();
        const env = createEnvelope('pair:redeem', { code });
        ws.send(JSON.stringify(env));
      }
      return;
    }
    case 'pair:code': {
      // Generator path: log the code, then keep waiting for pair:established.
      // The redeemer may not have connected yet.
      log('code =', msg.payload.code);
      return;
    }
    case 'pair:established': {
      groupId = msg.payload.groupId;
      log('paired groupId=', groupId);
      clearTimeout(hardTimeout);
      publishTestAvatar();
      if (interactive) {
        startInteractive();
      } else {
        scheduleUsernameAnnounce();
      }
      return;
    }
    case 'pair:invalid': {
      log('pair invalid reason=', msg.payload.reason);
      exit(1);
      return;
    }
    case 'error': {
      log('server error code=', msg.payload.code, 'message=', msg.payload.message);
      exit(1);
      return;
    }
    case 'ping:drop': {
      if (interactive) {
        const { coords, color, senderSessionId } = msg.payload;
        log(
          `received ping coords=(${coords.x.toFixed(3)}, ${coords.y.toFixed(3)}) color=${color} messageId=${msg.messageId} senderSessionId=${senderSessionId}`,
        );
        if (echoPing && groupId && sessionId) {
          setTimeout(() => sendPing(coords), ECHO_PING_DELAY_MS);
        }
      } else {
        log('ignored message type=', msg.type);
      }
      return;
    }
    case 'ping:ack': {
      if (interactive) {
        log(
          `received ping:ack messageId=${msg.payload.messageId} receivedAt=${msg.payload.receivedAt}`,
        );
      } else {
        log('ignored message type=', msg.type);
      }
      return;
    }
    case 'peer:avatar': {
      if (interactive) {
        log(
          `received peer avatar sessionId=${msg.payload.sessionId} size=${msg.payload.imageBase64.length}`,
        );
      } else {
        log('ignored message type=', msg.type);
      }
      return;
    }
    case 'username:match': {
      if (usernameMatchTimer !== null) {
        clearTimeout(usernameMatchTimer);
        usernameMatchTimer = null;
      }
      log(`username:match received matched=${msg.payload.matched}`);
      scheduleExit();
      return;
    }
    default: {
      // Out-of-scope inbound message types (latency:*, peer:username, etc.)
      // are silently ignored.
      log('ignored message type=', msg.type);
      return;
    }
  }
}

function scheduleExit(): void {
  setTimeout(() => {
    log('exiting cleanly');
    exit(0);
  }, POST_PAIR_LINGER_MS);
}

function scheduleUsernameAnnounce(): void {
  setTimeout(() => {
    if (!groupId) return;
    log(
      `sending username:announce detectedUsername=${detectedUsername} (override via MOCK_PEER_DETECTED_USERNAME)`,
    );
    const env = createEnvelope(
      'username:announce',
      { detectedUsername, confidence: 0.9, game: 'unknown' },
      { groupId },
    );
    ws.send(JSON.stringify(env));

    usernameMatchTimer = setTimeout(() => {
      usernameMatchTimer = null;
      log('username:match timeout');
      scheduleExit();
    }, USERNAME_MATCH_TIMEOUT_MS);
  }, USERNAME_ANNOUNCE_DELAY_MS);
}

function startInteractive(): void {
  if (!groupId) {
    log('interactive mode requires groupId — bug');
    exit(1);
    return;
  }
  // Try raw-mode keypress when stdin is a real TTY. Otherwise fall back to
  // line-buffered input — required when this script is spawned by
  // `dev-peer.ts` under `npm run`, where the parent process chain on macOS
  // does not reliably propagate the TTY flag through `'inherit'` stdio.
  // Line-buffered mode: user types `p` then Enter (each line is one char).
  interactiveActive = true;
  let rawModeOn = false;
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      rawModeOn = true;
    } catch (err) {
      log('raw mode unavailable:', err instanceof Error ? err.message : String(err));
    }
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onStdinData);
  if (rawModeOn) {
    log(
      `interactive — press 'p' to drop a ping at random viewport coords, 'c' to clear, 'q' to quit`,
    );
  } else {
    log(
      `interactive (line-buffered fallback, no TTY) — type 'p' + Enter to drop a ping, 'c' to clear, 'q' to quit`,
    );
  }
}

function onStdinData(chunk: string | Buffer): void {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  for (const ch of s) {
    handleKey(ch);
  }
}

function handleKey(ch: string): void {
  // Ctrl-C in raw mode arrives as 0x03.
  if (ch === '' || ch === 'q' || ch === 'Q') {
    log('quit requested');
    exit(0);
    return;
  }
  if (ch === 'p' || ch === 'P') {
    sendPing();
    return;
  }
  if (ch === 'c' || ch === 'C') {
    sendClear();
    return;
  }
  // Unknown keys are ignored.
}

function promptForCode(): Promise<string> {
  // Line-buffered, cooked-mode read of a single line from stdin. We deliberately
  // do NOT call setRawMode() here — the dev types the code visibly and hits
  // Enter, the OS handles backspace and line editing. If interactive mode
  // attaches a handler later, it will work over the same stdin without conflict.
  process.stdout.write(`${prefix} Enter pairing code from the Electron GUI: `);
  return new Promise<string>((resolveLine, rejectLine) => {
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      buf += s;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).replace(/\r$/, '');
      process.stdin.off('data', onData);
      process.stdin.pause();
      const code = line.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) {
        rejectLine(
          new Error(
            `expected a 6-character alphanumeric pairing code (got: ${JSON.stringify(line)})`,
          ),
        );
        return;
      }
      resolveLine(code);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

function publishTestAvatar(): void {
  if (!groupId || !sessionId) return;
  // activeAvatarBase64 was already size-validated at startup by resolveAvatar().
  const env = createEnvelope(
    'peer:avatar',
    { sessionId, imageBase64: activeAvatarBase64 },
    { groupId },
  );
  ws.send(JSON.stringify(env));
  log(`published test avatar (size=${activeAvatarBase64.length})`);
}

function sendPing(coords?: { x: number; y: number }): void {
  if (!groupId || !sessionId) return;
  const x = coords?.x ?? Math.random();
  const y = coords?.y ?? Math.random();
  const color = PING_COLORS[colorIndex % PING_COLORS.length] ?? PING_COLORS[0];
  colorIndex = (colorIndex + 1) % PING_COLORS.length;
  const env = createEnvelope(
    'ping:drop',
    { coords: { x, y }, color, ttl: PING_TTL_MS, senderSessionId: sessionId },
    { groupId },
  );
  ws.send(JSON.stringify(env));
  log(`dropped ping x=${x.toFixed(3)} y=${y.toFixed(3)} color=${color} messageId=${env.messageId}`);
}

function sendClear(): void {
  if (!groupId) return;
  const env = createEnvelope('ping:clear', {}, { groupId });
  ws.send(JSON.stringify(env));
  log('cleared pings');
}

process.on('SIGINT', () => {
  log('SIGINT — closing');
  exit(130);
});
process.on('SIGTERM', () => {
  log('SIGTERM — closing');
  exit(143);
});

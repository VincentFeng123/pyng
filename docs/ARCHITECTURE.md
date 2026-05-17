# Architecture

System architecture for pyng — cross-PC ping overlay for Roblox FPS games.

## High-level system

```
┌──────────────────┐                  ┌──────────────────┐
│  Alice's PC      │                  │  Bob's PC        │
│                  │                  │                  │
│  ┌────────────┐  │   WebSocket      │  ┌────────────┐  │
│  │ Electron   │──┼──────────────────┼──│ Electron   │  │
│  │  - Main UI │  │   (via relay)    │  │  - Main UI │  │
│  │  - Overlay │  │                  │  │  - Overlay │  │
│  └────────────┘  │                  │  └────────────┘  │
│       │          │                  │       │          │
│       │ reads    │                  │       │ reads    │
│       ▼          │                  │       ▼          │
│  ┌────────────┐  │                  │  ┌────────────┐  │
│  │  Roblox    │  │                  │  │  Roblox    │  │
│  │ (separate  │  │                  │  │ (separate  │  │
│  │  process)  │  │                  │  │  process)  │  │
│  └────────────┘  │                  │  └────────────┘  │
└──────────────────┘                  └──────────────────┘
         │                                     │
         └──────────────┬──────────────────────┘
                        ▼
                ┌──────────────┐
                │ Relay Server │
                │ (Node + ws)  │
                └──────────────┘
```

The relay server is stateless — it routes WebSocket messages between paired clients. No game data ever touches the server. No accounts.

## Process model (per client)

The v2 Electron client is an IPC-driven state machine in the main process, with
two renderer windows: a consolidated dashboard (Pairing + Settings tabs) and a
transparent overlay window pinned over the game. The tray icon is the
persistent app anchor — closing the dashboard hides it but keeps the app alive.

```
┌────────────────────────────────────────────────────────────────────┐
│  Electron App (single OS process; renderers are child windows)     │
│                                                                     │
│  ┌──────────────────────────┐   IPC   ┌──────────────────────────┐ │
│  │ Main process              │◄──────►│ Renderer: Dashboard       │ │
│  │                           │         │  - Pairing tab            │ │
│  │  PairStateMachine          │         │  - Settings tab           │ │
│  │   - connection state      │         │  - relay URL display      │ │
│  │   - pair state            │         │  - latency display        │ │
│  │   - peer avatars cache    │         └──────────────────────────┘ │
│  │   - latency tracker       │                                       │
│  │                           │   IPC   ┌──────────────────────────┐ │
│  │  WsClient                  │◄──────►│ Renderer: Overlay         │ │
│  │   - reconnect w/ backoff  │         │  - chevron + avatar       │ │
│  │   - heartbeat (server     │         │  - 64×84 marker per ping  │ │
│  │     pings, client pongs)  │         │  - click capture in       │ │
│  │                           │         │    ping-mode (hold)       │ │
│  │  Input bridge              │         └──────────────────────────┘ │
│  │   - global hotkey         │                                       │
│  │   - hold/press mode       │         ┌──────────────────────────┐ │
│  │   - ping-mode session     │         │ Tray (always present)     │ │
│  │                           │◄────────│  - Show/Hide dashboard    │ │
│  │  Settings store            │         │  - Quit                   │ │
│  │   - electron-store JSON   │         └──────────────────────────┘ │
│  └──────────────────────────┘                                       │
└────────────────────────────────────────────────────────────────────┘
```

The main process owns:
- The `PairStateMachine` (single source of truth for connection + pair state).
- One `WsClient` to the relay, with auto-reconnect and heartbeat pong handling.
- `PeerAvatarStore` (in-memory, group-scoped, cleared on unpair).
- `LatencyTracker` (rolling RTT, see "Latency tracking" below).
- `wireInput` (the global hotkey + hold/press ping-mode state machine).
- Window lifecycle for the dashboard, overlay, and tray.

The renderers are dumb. They receive `PAIR_STATE_CHANGED` broadcasts and call
typed IPC channels (`pair:request-generate`, `pair:request-redeem`, etc.) when
the user clicks. No business logic, no direct WebSocket access, no settings
persistence — everything goes through main.

### Launch modes

The Electron entrypoint (`client/src/main/index.ts`) selects a mode based on
process args / env, then never switches:

- **`app` (default, no flag):** opens the dashboard, connects to the relay,
  manages tray, registers hotkey on `paired`. This is the user-facing v2 mode.
- **`solo` (`--solo` or `SOLO=1`):** dashboard hidden; overlay only; hotkey
  drops local-only pings at the cursor. No server, no peer. Used for
  `npm run dev:solo` demos.
- **`legacy-cli` (`--legacy-cli` or `LEGACY_CLI=1`):** the v0/v1 one-shot
  pairing flow used by `scripts/dev.ts`, `scripts/dev-peer.ts`, and the
  mock-peer regression tests. NO dashboard window opens. See
  `docs/PAIRING.md` for the legacy flow shape.

The launch-mode switch ensures dev scripts that drive the client headlessly
never accidentally pop a window in front of a live mock-peer test.

## Data flow: ping drop

Following a single ping from click to display:

```
1. Dead player (Alice) clicks her screen at pixel (x, y)
   └─ Overlay window detects the click via global mouse listener
      or hotkey activation
   
2. Overlay → Main process (IPC: 'ping:user-clicked')
   │  payload: { x, y, screenWidth, screenHeight }
   └─ Main process normalizes to (0..1, 0..1)
   
3. Main process builds a `ping:drop` envelope:
   │  payload: {
   │    coords: { x: 0.523, y: 0.711 },
   │    color: 'red',
   │    ttl: 5000,
   │    senderSessionId: <Alice's own sessionId>,
   │  }
   │  envelope: { type, payload, messageId: uuid, timestamp, groupId }

4. Main process sends the envelope to the relay AND echoes it locally:
   ├─ WebSocket → relay (envelope as-is)
   └─ IPC 'overlay:show-ping' → Alice's overlay renderer with the same
      messageId. This lets Alice see her own ping immediately — no round-trip
      to the server, no double-render (the server's broadcast excludes the
      sender, and the renderer's `active.has(messageId)` guard would suppress
      a wire echo anyway).

5. Relay server → Bob's client (WebSocket: 'ping:drop')
   │  Same envelope. Server does NOT trust payload.senderSessionId for
   │  routing — routing is keyed off the socket-bound sessionId.

6. Bob's main process receives, drops it if `senderSessionId === selfSessionId`
   (belt-and-suspenders), otherwise IPC 'overlay:show-ping' to Bob's overlay
   renderer with the avatar slot filled from Bob's group-local avatar cache.

7. Bob's overlay renderer adds the ping marker to its display list and fades
   out after TTL.
```

End-to-end target: under 500ms.

## Pair state lifecycle

The dashboard's connection badge and the pairing tab both read from a single
`PairStatePayload` that the main process broadcasts on every transition. The
state machine is in `client/src/main/state-machine.ts`.

```
                 ┌────────────────────────────────────────┐
                 │                                        │
                 ▼                                        │
  ┌──────────────────────┐                                │
  │   unpaired           │                                │
  │  (initial / after    │                                │
  │   unpair / pair lost)│                                │
  └──────────────────────┘                                │
       │           │                                      │
       │ click     │ click "Redeem"                       │
       │ "Generate"│ + type 6-char code                   │
       ▼           ▼                                      │
  ┌──────────────────┐    ┌──────────────────┐            │
  │   generating     │    │   redeeming      │            │
  │   - showing code │    │   - sending      │            │
  │   - waiting for  │    │     pair:redeem  │            │
  │     peer redeem  │    │   - awaiting     │            │
  └──────────────────┘    │     established  │            │
       │       │          └──────────────────┘            │
       │       │ Cancel       │       │                   │
       │       └──────────────┼───────┘                   │
       │                      │                           │
       │  pair:established    │ pair:invalid              │
       │  (both clients)      │ (back to unpaired         │
       ▼                      ▼  with error)              │
  ┌──────────────────────────────────────┐                │
  │   paired                              │                │
  │   - overlay window opens              │                │
  │   - hotkey registered (from settings) │                │
  │   - peer:avatar published             │                │
  │   - ping:ack arrivals feed latency    │                │
  └──────────────────────────────────────┘                │
       │                                                  │
       │ Unpair / connection lost                         │
       └──────────────────────────────────────────────────┘
                       (pairLostHint=true on involuntary drop)
```

In parallel, an orthogonal `connection` track runs:
`disconnected → connecting → connected` on startup, and
`connected → disconnected → reconnecting → ...` on network blips with a stepped
1s/2s/4s/8s backoff. The two tracks ride on the same `PairStatePayload`.

Server-side `pair:resume` is intentionally not implemented in v2 (the server
has no grace period). On reconnect-while-paired, the state machine drops the
user back to `unpaired` with `pairLostHint=true`; the renderer surfaces a
dismissible "Connection dropped — please re-pair" banner.

## Latency tracking

The Paired screen shows a live round-trip latency to the relay, fed by
`ping:ack` envelopes (see `docs/PROTOCOL.md` for the wire flow).

```
1. User triggers ping (hold or press).
2. pingSender builds the ping:drop envelope, records messageId+sentAt in
   the LatencyTracker's in-flight map, sends to relay.
3. Relay receives, immediately emits ping:ack back with the same messageId
   and server-side receivedAt.
4. Main process onMessage('ping:ack') → tracker.recordAck(messageId).
5. Tracker computes rtt = Date.now() - sentAt, pushes into a 10-sample
   rolling window, recomputes the mean, calls its subscribers.
6. State machine subscribes; updates state.latencyMs and broadcasts the
   PairStatePayload (only when the mean actually changed — identical
   values suppress the broadcast).
7. Renderer (PairingTab) renders `42ms` / `1.2s` with green/yellow/red
   tier color (<100 / 100-300 / >=300).
```

Sender-only path: the server never sends `ping:ack` to peers. Other group
members receive only the `ping:drop` envelope (so they render their own
chevron); they don't see your RTT. In-flight entries older than 30s are
swept on the next send/ack so the map can't grow unbounded on a flaky
link.

Latency state is reset on `requestUnpair()` and on `disconnect-while-paired`.

## Data flow: spectator detection

**v3 aspirational.** Not implemented in v2 — v2 pairing is fully user-driven
(generate a code, share it, redeem it) and the hotkey fires unconditionally
while paired regardless of what's on screen. The flow below describes the
intended OCR-driven auto-activation that lands when game-detection + OCR
ships in v3.

Continuously runs at 1Hz while Roblox is the foreground process:

```
1. Main process: every 1000ms, call desktopCapturer to get primary display pixels
   
2. Main process: detect which Roblox game is running
   └─ Match window title + place ID against game configs
   
3. Main process: crop pixels to ROI from game config
   
4. OCR worker: preprocess (grayscale, scale, threshold, invert)
   
5. OCR worker: Tesseract recognize → text + confidence
   
6. OCR worker: parse with game's regex pattern
   └─ Validate: confidence > threshold, username format valid
   
7. If valid username detected:
   └─ Main → relay: 'username:announce' with detected name
   └─ Relay → Bob's client
   └─ Bob's client checks: does this match my username?
      └─ If yes: signal back 'pair:spectating' to Alice
      └─ Alice's UI updates: "Ping mode active — spectating Bob"
```

Only when both sides confirm spectator-match does ping mode activate. This prevents accidentally pinging strangers if Alice happens to spectate someone with the same name as Bob.

## Settings + avatar

Settings are per-install, per-OS-user. Stored as JSON via `electron-store`. The
v1.5 schema (`client/src/main/settings.ts`) holds one field: the user's avatar.
See `docs/SETTINGS.md` for schema details and how to add new fields.

**At pair time**, each client publishes its own avatar as a `peer:avatar` envelope:

```
1. Client: load avatar from settings store (PNG, already normalized to 64×64)
   └─ Encode to base64 (no data URL prefix)

2. Client → relay: 'peer:avatar' envelope
   │  payload: { sessionId: <self>, imageBase64: <png-base64> }

3. Relay: validate payload.sessionId === socket.sessionId (reject mismatches
   with error code 'avatar_identity_mismatch'). Cache imageBase64 in the
   group's in-memory avatars Map keyed by sessionId. Broadcast envelope to
   every OTHER group member.

4. Pre-pair publishes (generator publishes before redeemer connects) are
   pended in a sessionId-keyed map. When redeemCode creates the group, the
   pending entry is drained into the new group's avatars Map and replayed
   to the other member immediately after pair:established.

5. Peer client: receive 'peer:avatar', store imageBase64 in its in-memory
   avatar map keyed by senderSessionId. Future incoming pings render the
   avatar in the marker's slot.
```

The server caches avatars only for the lifetime of the group. No persistence,
no cross-pair carryover, no database. A republish overwrites the cached entry
and re-broadcasts; this is the recovery path if a peer reconnects fresh.

## Coordinate translation

The hardest correctness problem. See `docs/OVERLAY.md` for the math.

Summary:

- Coordinates over the wire are always normalized 0..1 against the **viewport area** (game world, not full screen including HUD)
- Each game config defines its viewport area (pixels of HUD to exclude from top/bottom/left/right)
- The dead spectator's viewport and the alive player's viewport are both game-world views of the same FOV — so normalized coords map 1:1 in viewport space
- Each client converts to/from absolute screen pixels using its own resolution + viewport area

## Stack choices and why

- **Electron** over native: cross-platform, web tech for UI, well-known transparent window patterns. Native Win32/AppKit would be faster but 5x the code.
- **WebSocket** over WebRTC: server-mediated is simpler, no NAT traversal issues, latency penalty is acceptable.
- **Tesseract.js** over cloud OCR: runs locally (privacy + speed), no API costs, good enough for high-contrast UI text. Cloud OCR is way more accurate but introduces latency and ongoing cost.
- **React** in the dashboard renderer (Pairing + Settings tabs): ecosystem maturity for Electron + dev familiarity. UI is simple enough that the framework hardly matters.
- **No React in the overlay renderer.** The overlay is plain TS + DOM (one file, ~100 lines, Web Animations API for fade-out). See `docs/OVERLAY.md`. v2 may revisit if marker composition gets complex.
- **No external state library.** The renderer holds `PairStatePayload` in `useState` and re-renders on the IPC broadcast. v2 doesn't need Redux/Zustand/etc.
- **TypeScript everywhere**: catches whole categories of bugs at compile time. Worth the boilerplate.

## Constraints encoded in architecture

1. **No game process hooks.** All OCR works on screen pixels via `desktopCapturer`. The overlay is a separate OS window. Roblox's process is never touched.

2. **No persistent user data.** No accounts, no analytics, no telemetry by default. Pair state lives in memory on the server and dies with the connection.

3. **Server is replaceable.** All trust is between paired clients. The server could be malicious or unavailable — clients should degrade gracefully.

4. **Multi-resolution is first-class.** Every coordinate that crosses the network is normalized. Local pixel coords only exist inside each client's main process.

5. **Failure modes are visible.** "OCR couldn't read the username" is a UI state, not a thrown exception. The app should never crash mid-match.

## What's out of scope for v2

- OCR-based spectator detection (the "Data flow: spectator detection" section
  above describes the intended v3 design). v2 fires the hotkey unconditionally
  while paired.
- Mobile clients.
- Voice integration.
- Multi-member groups (only 2-person pairs for v2; squads come later).
- Recording / replay of past matches.
- Stats / leaderboards.
- Custom ping types (one chevron+avatar marker for v2).
- Server-side payload validation beyond identity (`avatar_identity_mismatch`
  is the only enforced trust boundary in v2; broader hardening lives in #39).
- `pair:resume` / pair grace period (defined in the wire protocol but not
  implemented; defer to v3).
- Linux/macOS installers (Windows-only for v2 release; macOS works from source
  for development).

# pyng

A desktop overlay app that lets dead spectators in Roblox FPS games drop pings on their alive teammate's screen, across separate PCs.

## What pyng does

Two friends both install pyng on their PCs and pair via a 6-character code. When one of them dies in a supported Roblox FPS and starts spectating their teammate, pyng:

1. Detects the spectated player's username via OCR on the game's spectator UI
2. Matches that username to the paired friend's app instance via the relay server
3. Enables ping mode: the dead player clicks anywhere on their screen to drop a marker
4. The marker appears on the alive player's screen as a transparent overlay over their game

The whole loop runs end-to-end in under 500ms. No accounts, no signup, no game memory access.

## Why this is technically viable

Roblox's anti-cheat (Hyperion) is permissive about external overlays — unlike Vanguard/Ricochet/EAC on AAA shooters. Discord overlay and OBS run on Roblox without flags. Pyng uses the same architectural pattern: an OS-level transparent always-on-top window that never hooks the game process. It only:

- Reads screen pixels (for OCR)
- Draws on its own window (overlay)
- Sends/receives WebSocket messages

None of these are anti-cheat triggers because the game's process is never touched.

That said: this is a moving target. Roblox can change ToS or detection at any time. Build defensively.

## Stack

- **Desktop client:** Electron 28+ with TypeScript, React 18 for UI
- **Server:** Node.js 20 + `ws` for WebSocket relay
- **OCR:** Tesseract.js with custom preprocessing
- **Shared types:** TypeScript types in `shared/` used by both client and server
- **Build:** `electron-builder` for Windows installer (priority), macOS later

## Repository structure

```
pyng/
├── client/              # Electron desktop app
│   ├── src/
│   │   ├── main/        # Main process: window mgmt, OCR, overlay, IPC
│   │   ├── renderer/    # React UI (pairing screen, settings, status)
│   │   ├── overlay/     # Separate renderer for the transparent overlay window
│   │   └── shared/      # Client-side helpers, types
│   ├── package.json
│   └── electron-builder.yml
├── server/              # Relay server
│   ├── src/
│   │   ├── index.ts     # Entrypoint
│   │   ├── pairing.ts   # Code generation, session lookup
│   │   └── relay.ts     # Message routing between paired peers
│   └── package.json
├── shared/              # Protocol types shared between client + server
│   ├── protocol.ts      # WebSocket message schemas
│   └── games.ts         # Game config types
├── client/src/main/tracking/games/  # Per-game tracking configs (HUD masks, FOV)
│   └── phantom-forces.json          # Only the primary test game is shipped; add more via game-config-engineer
├── fixtures/            # Sample screenshots for OCR tests
│   └── <game>/<scenario>.png
├── docs/                # Detailed specs (read these before implementing)
└── .claude/agents/      # Subagent definitions
```

## Build & dev commands

```bash
# First-time setup
npm install                       # installs root + workspaces

# Development
npm run dev                       # runs server + client concurrently
npm run dev:client                # client only (Electron, hot reload)
npm run dev:server                # server only (with watch)
npm run dev:mock                  # client in mock-peer mode (single-device dev, no real network)

# Testing
npm run test                      # all unit tests
npm run test:ocr                  # OCR golden tests against fixtures/
npm run test:integration          # client <-> server integration tests

# Building
npm run build:win                 # Windows installer (NSIS .exe)
npm run build:server              # server production bundle
npm run lint                      # ESLint + TypeScript check
```

## Conventions

- **TypeScript strict mode everywhere.** No `any` without justification in a comment.
- **2-space indent**, semicolons, single quotes.
- **Functional React** with hooks. No class components.
- **All IPC messages typed** via `shared/protocol.ts`. Never send untyped objects across the IPC boundary or WebSocket.
- **All WebSocket messages** flow through one `Envelope<T>` shape with `type`, `payload`, `timestamp`. See `docs/PROTOCOL.md`.
- **Path imports:** use `@/main/...`, `@/renderer/...`, `@/shared/...` aliases. No deep relative paths.
- **Tests live next to source:** `foo.ts` + `foo.test.ts`.
- **Commit format:** Conventional Commits (`feat:`, `fix:`, `docs:`, etc.) with scopes `client`, `server`, `shared`, `games`, `docs`.

## Subagents

Don't try to do everything in the main thread. Delegate focused work to these specialists in `.claude/agents/`:

- **architect** — Use first for any feature. Plans, breaks down into tasks, decides which other agents to invoke. Does NOT write code.
- **electron-engineer** — Electron main process, transparent overlay window, IPC, screen capture, app packaging.
- **ocr-engineer** — Screen capture pipeline, Tesseract setup, image preprocessing, per-game ROI.
- **network-engineer** — WebSocket server, client connection, pairing flow, message routing.
- **ui-engineer** — React UI for pairing/settings/status. Overlay visual design.
- **game-config-engineer** — Adds support for a new Roblox FPS: captures fixtures, tunes OCR, writes game config.
- **tester** — Multi-device test scenarios, mock-peer mode, OCR golden tests, regression checklists.

## Critical constraints (these must hold)

1. **No game process hooks.** The overlay is a separate OS-level always-on-top transparent window. It is rendered by Electron and does not touch Roblox's process, memory, or rendering pipeline.

2. **OCR runs at most 1Hz**, not on every frame. Spectating doesn't change rapidly; running OCR more often wastes CPU and battery.

3. **Code-based pairing only.** No accounts, no email, no OAuth. A 6-character code (e.g., `K7M2P9`) is the entire pairing flow. Codes expire after 24 hours.

4. **End-to-end ping latency target: < 500ms.** Measured from click on dead player's screen to marker rendered on alive player's screen.

5. **Cross-resolution support is first-class.** The dead player at 1080p must be able to ping accurately for an alive player at 1440p or 4K. See `docs/OVERLAY.md` for the coordinate translation math.

6. **Fail open, not closed.** If OCR can't detect a username, the user should see "no teammate detected" — never an exception or crash. The app should never visibly break during a match.

## When you're stuck

- Read the relevant doc in `docs/` before guessing
- Look at `fixtures/` for example data
- Check `shared/protocol.ts` for message contracts
- If implementing for a specific game, check `client/src/main/tracking/games/<game>.json` first

## Detailed docs

- `docs/ARCHITECTURE.md` — System architecture, component interaction, data flow
- `docs/PROTOCOL.md` — WebSocket message protocol (full schema)
- `docs/OCR_PIPELINE.md` — OCR implementation, preprocessing, per-game ROI
- `docs/OVERLAY.md` — Transparent overlay window, coordinate translation
- `docs/GAMES.md` — Per-game configuration schema, how to add a game
- `docs/PAIRING.md` — Code-based pairing flow, session lifecycle
- `docs/TESTING.md` — Multi-device testing approach, mock-peer mode

Read these. They have specifics that aren't in this overview.

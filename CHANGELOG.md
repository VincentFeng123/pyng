# Changelog

All notable changes to pyng. Newest at top. The protocol is additive-only since v0.0 — older clients can talk to newer servers and vice versa within reason.

## 0.2.0 — 2026-05-14

First public release. The headline change is a real GUI pairing experience instead of the CLI-driven one-shot pair from v1.

- GUI dashboard with two tabs: **Pairing** (generate / redeem 6-character code, paired status with group + session ids, latency display) and **Settings** (avatar picker, hotkey rebind, relay URL display).
- Cursor-capture-aware ping input: hold the bound hotkey (default `Z`) to make the cursor reappear over the overlay, then click anywhere to drop a ping at that exact pixel. Release the hotkey without clicking to cancel. Press-mode is retained as an opt-in via Settings.
- System tray icon with a Dashboard / Quit menu; clicking the icon re-opens the dashboard. Closing the dashboard hides instead of quits, so the tray anchors the app.
- WebSocket reconnect with stepped backoff (1s → 2s → 4s → 8s, cap at 8s). Connection-state badge in the dashboard (green / pulsing yellow / red). If the user was paired when the connection dropped, the renderer shows a dismissible "Connection dropped — please re-pair." banner.
- Server hosted on Railway at `wss://pyng-relay.up.railway.app` with WebSocket ping/pong heartbeat.
- macOS Accessibility permission pre-flight check with a custom explanation dialog and a deep-link button to the right System Settings pane. Solo and app modes both use `uiohook-napi` so the hotkey fires in fullscreen game contexts.
- Windows NSIS installer (`pyng-Setup-0.2.0.exe`, ~89 MB) with desktop + Start menu shortcuts, user-installable (no UAC), preserves user data on uninstall.
- Public landing page (`pyng.pages.dev`) with download button, 4-step how-it-works, and beta warning copy.
- New dev/test entrypoints: `npm run dev:solo` (overlay-only local pings, no server), `npm run dev:peer` (mock-peer for solo developer cross-network testing).
- Protocol version unchanged (`0` — additive only this round).

## 0.1.5 — 2026-04-XX

Avatar pings and visual polish.

- New `peer:avatar` envelope: clients publish their normalized 64×64 PNG avatar at pair time; the server caches per-group and replays to new joiners. Identity-validated against the socket's session id; oversize payloads dropped.
- Ping marker redesigned: avatar circle above a concave pin-shape chevron, color-tinted per ping. Tip lands pixel-exactly at the sender's cursor coord. Smaller and softer than v0's red dot.
- Settings window for avatar picker + electron-store persistence (PNG/JPG up to 1 MB, auto-cropped + resized).
- Sender-echo via local IPC: dropping a ping shows your own marker immediately without a wire round-trip.
- `npm run dev:solo` and mock-peer test avatar baked in for reproducible demos.

## 0.1.0 — 2026-03-XX

The overlay layer and ping routing.

- Transparent always-on-top fullscreen `BrowserWindow` with click-through (`setIgnoreMouseEvents(true, { forward: true })`).
- WebSocket relay: clients connect to a single server that forwards `ping:drop` / `ping:clear` envelopes between paired peers.
- Normalized viewport coordinates (0..1) so a 1080p sender's ping lands correctly on a 1440p or 4K peer.
- Per-game config files for the (future) OCR pipeline; v1 does not yet auto-detect spectated usernames.

## 0.0.x — 2026-02-XX

Pairing skeleton.

- Code-based 6-character pairing handshake (charset excludes 0/O/1/I/l). 10-minute code expiry.
- Server-mediated pair state stored in-memory (no database, no accounts).
- Stable `Envelope<T>` shape for every WebSocket message (`type`, `payload`, `messageId`, `timestamp`).

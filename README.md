# pyng

Cross-PC pings for Roblox FPS games. When you're dead and spectating your
friend, click on your screen and the ping appears on their screen as a
transparent overlay.

No accounts. No game integration. No memory access. Runs alongside Discord,
OBS, and any other tools you already use.

## Install

Windows installer: see `landing/` for the user-facing download page (links to
the latest GitHub release).

To run from source for development:

```bash
git clone <repo>
cd pyng
npm install
npm run dev
```

`npm run dev` boots the relay server and two paired Electron clients on the
same machine — useful for full-loop testing without a second PC.

## Pair + ping

1. Both players install pyng and open the app.
2. One player clicks "Generate code" in the Pairing tab and reads the 6-char
   code to the other (Discord voice, IRL, etc.). The other types it in the
   "Redeem" input and clicks "Pair."
3. With the overlay live, hold the configured hotkey (default `Z`); the
   cursor appears over the game; release to drop a ping at the cursor. Your
   friend sees a chevron with your avatar on their screen.

Latency is shown on the Paired screen — green is good (<100ms), yellow is
okay (100-300ms), red is slow (>=300ms).

## Build from source

```bash
npm install
npm run dev          # full local stack (relay + 2 paired clients)
npm run dev:peer     # one Electron client + scripted mock peer for solo testing
npm run dev:solo     # overlay-only demo, no server, no peer
npm run build:win    # Windows NSIS installer
```

The `dev:peer` and `dev:solo` modes don't need a server (mock peer / no peer
respectively). `npm run dev` starts a local relay on `ws://localhost:7788`.

For production builds, the client points at the Railway-hosted relay
(`wss://pyng-relay.up.railway.app`); override with `PYNG_RELAY_URL=...` for
self-hosted relays. See `server/DEPLOY.md` for relay deploy instructions.

## Architecture

The relay server routes WebSocket messages between paired clients; the
Electron client owns a state machine, a transparent overlay window, a global
hotkey, and a per-install settings store. See:

- `docs/ARCHITECTURE.md` — process model, data flows, pair state lifecycle,
  latency tracking
- `docs/PROTOCOL.md` — WebSocket envelope shapes + routing rules
- `docs/PAIRING.md` — code-based pairing flow
- `docs/OVERLAY.md` — transparent window setup, chevron+avatar marker design,
  coordinate translation math
- `docs/SETTINGS.md` — settings schema and rebind UX
- `docs/GAMES.md` — supported games + aspect-ratio caveats
- `docs/TESTING.md` — manual smoke procedures and automated coverage map
- `CLAUDE.md` — full development guide for contributors

## License

TBD.

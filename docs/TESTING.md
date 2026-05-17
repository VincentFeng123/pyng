# Testing

Multi-device testing for pyng is genuinely hard. This doc lays out the strategy to keep it tractable.

## The problem

The product only works when two clients are connected to the same relay server, both with Roblox FPS running, with one player dead and spectating the other. To test the full happy path you need:

- 2 PCs
- 2 Roblox accounts
- A live FPS match where one player can reliably die
- The server running somewhere both can reach

That's a lot of setup for each test cycle. We won't do it every time. Instead, we layer tests by cost.

## Test layers (cheapest to most expensive)

### Layer 1: Unit tests
Pure logic, no IO. Fast. Run on every save.

```bash
npm run test
```

Coverage targets:
- All coordinate translation math
- Pair code generation (uniqueness, charset)
- Protocol message validation
- OCR pipeline functions (preprocess, parse, validate)
- State machines (OCR state, pair state)

### Layer 2: OCR golden tests
Fixture screenshots → expected outputs. Empirical but reproducible.

```bash
npm run test:ocr
npm run test:ocr -- --game=phantom-forces
```

Per-game accuracy gate: > 95% across all fixtures before that game's config can be merged.

### Layer 3: Integration tests (single-machine)
Spin up the server and two clients in the same process. Test full message flow with a real WebSocket connection.

```bash
npm run test:integration
```

Coverage:
- Pair: generate → redeem → established
- Ping: drop → receive
- Reconnect: disconnect → reconnect → resume
- Cross-resolution coord translation (mock different resolutions)

### Layer 4: Mock-peer mode (single-machine, manual)
Run the real Electron app + a mock peer for live interaction testing without a second PC.

```bash
npm run dev:mock
```

This boots:
1. Your Electron app (Alice) — full real version
2. A mock peer (Bob) — headless, just responds to messages and logs what it would render
3. Local relay server
4. Both clients auto-paired

Configurable via env vars:
- `MOCK_LATENCY_MS=200` simulate 200ms each direction
- `MOCK_PACKET_LOSS=0.1` drop 10% of messages
- `MOCK_RESOLUTION=1440p` mock Bob on different resolution
- `MOCK_GAME=phantom-forces` mock Bob "spectating" you in this game

The mock peer can optionally render its received pings on a stub window so you can visually verify they arrived.

### Layer 5: Multi-device manual tests
Two real PCs with two real Roblox sessions. Slow, but the only way to verify the product actually works end-to-end. Run before every release.

See "Multi-device test scenarios" below.

## v1 manual smoke tests

These three checks cover behaviors that can't be asserted from `npm run test:integration` (which only verifies the pair → ping:drop → overlay-bridge log path). Run them on a single dev machine before tagging a v1 release; they take ~3 minutes total.

All three start the same way:

```bash
npm run dev:peer
```

Wait until the orchestrator prints `[dev-peer] READY — focus the terminal running mock-peer and press 'p' to drop a ping. Press Ctrl+C to quit.` Keep the mock-peer terminal focused so keypresses reach its raw-mode stdin.

### 1. Overlay visibility

**What this checks:** the overlay BrowserWindow is created transparent and frameless, and the renderer canvas only draws on incoming `ping:drop`. Any visible artifact (white flash, black rectangle, gray border) is a regression.

**Procedure:**
1. With `npm run dev:peer` running and READY printed, scan the entire primary display.
2. Press `p` in the mock-peer terminal.

**Pass criteria:**
- Before pressing `p`: no visible window, no flash, no border, no shadow. The desktop wallpaper / underlying apps look identical to when pyng is not running.
- After pressing `p`: a single ping circle appears at a random position on the primary display **within 200 ms** of the keypress (mock-peer log line `dropped ping x=... y=...` and the visual appearance should feel simultaneous).
- The circle fades or disappears after its TTL (5000 ms, configured in mock-peer's `PING_TTL_MS`).
- Pressing `p` again places a second circle in a different color (round-robin from `PING_COLORS`: `#ff3344 → #33ff66 → #3366ff → #ffcc33`).
- Pressing `c` clears all visible circles within 200 ms.

**Fail signals:**
- Any visible window chrome, border, opaque background, or full-screen flash before the first ping.
- Ping circles delayed > 1 s after `dropped ping` is logged.
- Circles persist past their TTL or never clear on `c`.
- Multiple identical-color circles in a row (palette rotation broken).

### 2. Click-through

**What this checks:** the overlay window is set to `setIgnoreMouseEvents(true)` so the OS routes clicks through it to the window underneath. Without this, the overlay would swallow every click on the primary display while pyng is running — unusable.

**Procedure (macOS):**
1. With `npm run dev:peer` running, open TextEdit, create a new document, type a sentence so there's some content. Position the TextEdit window covering most of the primary display.
2. Press `p` in the mock-peer terminal a few times so circles are visible on top of TextEdit.
3. Click anywhere on TextEdit's window — directly through a visible ping circle is the strictest case.
4. Drag-select text in TextEdit by click-and-dragging across an area where a ping circle is rendered.
5. Repeat with a Finder window (drag a file, resize the window).

**Procedure (Windows):**
Same as macOS but with Notepad instead of TextEdit, and File Explorer instead of Finder.

**Pass criteria:**
- TextEdit / Notepad receives focus, the cursor blinks in it, and typed keystrokes land in the document.
- Click-and-drag selects text inside TextEdit / Notepad even when the cursor passes under a visible ping circle.
- Finder / Explorer windows accept clicks for selection, drag, and resize — including underneath a ping circle.

**Fail signals:**
- The application underneath does NOT receive the click (selection doesn't move, focus doesn't transfer, drag doesn't start).
- A ping circle "blocks" a region you can't click through.
- The OS treats the overlay as the active window when clicking inside it.

**Honest gaps (macOS-specific):**
- This test is fully manual on macOS. Programmatic click-through verification would need TCC accessibility permissions for the test harness (System Settings → Privacy & Security → Accessibility) plus AppleScript or `CGEventPost` to drive synthetic clicks and observe which app received them. We did not invest in this — the developer's primary platform is macOS but Windows is the production target.
- Windows can be automated later via UI Automation (`UIAClient` / `pywinauto`) and inspection of the foreground window after a synthetic click. This is deferred until a Windows CI runner exists.

### 3. Display change resilience

**What this checks:** Electron's `screen.on('display-metrics-changed', ...)` handler fires when resolution or display layout changes, the overlay window is recreated against the new primary display bounds, and the IPC bridge is re-wired so subsequent pings still land.

**Procedure (macOS):**
1. With `npm run dev:peer` running, press `p` once to confirm pings work; observe the circle.
2. Open System Settings → Displays. Change the primary display's resolution to a different scaled option (e.g., from "Default for display" to "More Space" or to a different pixel resolution).
3. Watch the terminal where dev:peer is running.
4. Wait 2–3 seconds for the OS and the overlay to settle.
5. Press `p` again.

**Procedure (Windows):**
Same flow via Settings → System → Display → "Display resolution".

**Pass criteria:**
- The terminal logs `[client:redeem] overlay recreated after display change` within ~1 s of the resolution change. (This message is emitted by the main process when its `display-metrics-changed` listener fires and recreates the overlay.)
- The orchestrator does NOT exit, and the Electron client does NOT crash.
- After step 5, the new ping circle appears at the random normalized coords on the NEW display geometry, with no offset or stretching artifacts.

**Fail signals:**
- The Electron client exits with `[dev-peer] electron exited code=...` followed by orchestrator teardown — that's a crash, not a recreation.
- The overlay disappears entirely after the resolution change and pings stop showing (recreation failed silently).
- The new ping appears at the wrong scale or offset (coordinate translation is broken against the new display bounds).

**Note:** "Display change" here means resolution / scaling changes on the existing primary display. Hot-plugging a monitor is a related but stricter case and is covered separately in the multi-device checklist under "Failure modes → Display config change mid-match."

## v1.5 manual smoke tests

Three additional gates covering the v1.5 surface area (chevron marker, avatar transport, settings UI, sender-side local echo). Run after the v1 smoke tests pass; they take ~5 minutes total on top.

### 4. Settings UI

**What this checks:** the settings BrowserWindow opens at the correct size, the React avatar picker normalizes an arbitrary PNG/JPG to 64×64, the result persists across restarts via `electron-store`, and `clearAvatar` restores the default state. See `docs/SETTINGS.md` for storage details.

**Procedure:**
1. `npm run settings`
2. Wait for a 480×640 dark BrowserWindow to appear. Verify dimensions roughly match (window chrome is OS-dependent).
3. Click the picker and choose any local PNG or JPG up to 1 MB (the input cap is `MAX_INPUT_BYTES = 1 * 1024 * 1024` in `client/src/main/avatarNormalize.ts`). A square image works best; non-square inputs get center-cropped.
4. Verify the preview shows the 64×64 cropped result inside the window.
5. Close the settings window.
6. Re-run `npm run settings`.
7. Verify the previously-picked avatar still shows in the preview (persistence).
8. Click "Clear" (or the equivalent control). Verify the preview returns to the empty/default state.
9. Close, re-open. Verify the empty state persists.

**Pass criteria:**
- Window dimensions are 480×640 (allowing for OS-level chrome).
- A 256×256 sample PNG round-trips to a visible 64×64 preview.
- Persistence works across the open→close→re-open cycle.
- Clear restores the empty state, and that empty state also persists.

**Fail signals:**
- Window opens at the wrong size or chrome-less / wrong theme.
- Picking an oversize file (> 1 MB) crashes the renderer instead of surfacing a user-visible error.
- Preview shows a stretched, non-cropped, or non-64×64 image.
- Avatar disappears after close+re-open (electron-store path mismatch).
- Clear leaves stale bytes in the store.

### 5. Sender-echo visual gate

**What this checks:** when the Electron client's main process sends a `ping:drop` to the relay, it ALSO echoes the ping locally to its own overlay renderer via `IPC_CHANNELS.OVERLAY_SHOW_PING` with the same `messageId`. This makes the sender see their own ping immediately — no wire round-trip — and is the architecture's answer to the Apex/Valorant "I see my own ping" pattern.

**Honest manual-gate limitation:** v1.5 has **no end-user hotkey on the Electron client** that drops a ping. There's no input path that exercises the local-echo code in a way a developer can verify by hand without code-side instrumentation. There are two acceptable ways to verify the gate:

- **Preferred — via the integration test (#36):** the harness pairs the Electron client with a mock peer, drives a `ping:drop` from a test-injected `pingSender.sendPingDrop()` call inside the Electron main process, and asserts that both the wire envelope AND the local IPC echo carry the same `messageId`. Run `npm run test:integration` once #36 is green. If the test passes, this gate is verified.
- **Fallback — manual REPL injection:** stop the Electron client mid-session, attach a Node debugger to the main process, and call `pingSender.sendPingDrop(client, overlay, selfSessionId, groupId, coords, color, ttl)`. Confirm a marker appears on the sender's overlay within ~50 ms. This is operationally heavy and only worth doing if the integration test is unavailable.

**Pass criteria (via #36):**
- `npm run test:integration` passes including the assertion that the same `messageId` appears in both the wire envelope and the local-echo IPC payload.

**Fail signals (via #36):**
- The test sees the wire envelope and the local echo with different `messageId`s — the dedup invariant in the renderer's `active.has(messageId)` guard is broken.
- The local echo never fires — sender doesn't see their own ping.
- The local echo fires twice (server also broadcasts the echo back to sender, double-render).

**Why we accept this gap:** v1.5 ships the local-echo plumbing as an architectural foundation for future input wiring (hotkey, click-and-drop). Visual user-facing verification arrives whenever an input source lands; until then, the integration test is the load-bearing gate.

### 6. Avatar visual gate (via dev:peer)

**What this checks:** the mock peer publishes a baked test avatar via `peer:avatar` immediately after `pair:established`, the server caches + broadcasts it, the Electron client's main process stores it in its in-memory avatar map keyed by `senderSessionId`, and the overlay renderer renders it in the 64×64 avatar slot above the chevron.

**The baked test avatar:** `scripts/mock-peer.ts` ships a 32×32 solid `#7c3aed` (pyng accent purple) PNG, encoded as base64 in the source. 32×32 is deliberate — not 64×64 — to exercise the renderer's scale-to-slot path so any "renderer assumes 64×64" regression shows up here.

**Procedure:**
1. `npm run dev:peer`
2. Wait for the `[dev-peer] READY` line. The mock peer should also log `published peer:avatar (32×32 purple test image)` or similar within 100 ms of pair:established.
3. Press `p` in the mock-peer terminal.

**Pass criteria:**
- A ping marker appears on the primary display within 200 ms.
- The marker has the 64×64 avatar slot filled with a solid purple square (`#7c3aed`), centered horizontally above the chevron tip with a 4 px gap.
- The chevron tip lands exactly on the ping coords (visually plausible — coords are randomized, so the marker should appear roughly where the mock-peer log line `dropped ping x=… y=…` reports).
- If the ping coords are near the top of the screen (small `y`), the marker flips: chevron on top, avatar below. The chevron tip still touches the reported coords.
- Pressing `p` repeatedly produces markers with the same purple avatar, only the chevron color rotates from `PING_COLORS`.

**Fail signals:**
- Avatar slot is empty (chevron-only marker) when the mock peer logged `published peer:avatar` — IPC or main-process cache is broken.
- Avatar appears stretched, distorted, or wrong color — image decode or slot sizing is wrong.
- Avatar appears but at the wrong size (e.g., 32×32 with empty bezel instead of scaled to fill 64×64).
- Marker doesn't flip near the top edge — overlay's `flipped = tipY - WRAPPER_H < 0` gate is broken.
- The avatar persists across `c` (clear pings) — `clearAll` is leaving the IMG node in place.

## v2 manual smoke tests

### 7. Solo demo (`npm run dev:solo`)

```
npm run dev:solo
```

Opens just the transparent overlay + a global hotkey. No relay server, no
mock-peer, no pairing.

**Interaction:** press `Z` (or whatever's in `settings.hotkey.accelerator`).
A purple chevron drops at the current cursor position with the user's avatar
above (if one is set in settings via `npm run settings`, otherwise the slot
is empty). The chevron fades over 5 seconds. Press repeatedly to drop more.

If `Z` is already claimed by another running app, solo mode falls back to
`CommandOrControl+Shift+Z` and logs the swap.

Useful for:

- Tweaking marker visuals without standing up the full pipeline
- Verifying hotkey responsiveness on the dev machine
- Recording demo footage of the overlay alone

`Ctrl+C` in the terminal cleanly shuts down. Solo mode uses Electron's
`globalShortcut.register` (not the native uiohook hold+click machinery used
in paired mode), so there's no macOS Accessibility permission prompt.

### 8. Dev mode no-popup check

`npm run dev`, `npm run dev:mock`, `npm run dev:peer`, `npm run dev:solo` must
NOT open the main dashboard window. The overlay window in `dev:peer` and
`dev:solo` is expected (that's the ping overlay, not the dashboard). The
dashboard only opens in default `npx electron .` / packaged-app mode.

Automated coverage: `client/test/integration/no-dashboard-in-legacy.test.ts`
spawns Electron in each dev/legacy mode and asserts the `main window opened`
log line does NOT appear within 5 seconds, plus a positive-control case for
app mode that asserts it DOES appear. The structural invariant being gated:
`runAppMode()` in `client/src/main/index.ts` is the sole caller of
`createMainWindow()`, and `parseConfig()` returns `'app'` mode only when no
LEGACY_CLI / SOLO / SETTINGS flag/env is set.

### 9. Hold-mode end-to-end in fullscreen Roblox (LOAD-BEARING v2 demo)

This is the marquee v2 manual smoke. It's the only test that proves the
overlay's input-capture path works against Roblox's cursor-capture (which
defeats all globalShortcut-based input). Run before every release.

**Procedure (macOS or Windows):**
1. Install pyng from a packaged build (see #51 NSIS installer for Windows;
   macOS uses `npx electron .` in dev or the .dmg if produced). On macOS,
   grant Accessibility permission when prompted (System Settings →
   Privacy & Security → Accessibility → enable "Electron" or "pyng").
2. Launch a Roblox FPS in fullscreen and enter spectator mode.
3. Open pyng's dashboard. Pair with a second device via the Pairing tab.
4. With Roblox focused: **hold `Z`** (or whatever's in
   `settings.hotkey.accelerator`). Your mouse cursor should appear inside
   the overlay's bounds, indicating the overlay has captured input.
5. **Click** anywhere on the screen while still holding `Z`.
6. **Release** `Z`.

**Pass criteria:**
- Cursor appears within ~50ms of pressing `Z`.
- A purple chevron drops at the clicked screen position on the local
  display (sender echo path).
- The paired peer's overlay shows the same chevron at the same normalized
  coords within ~500ms (loopback over Railway).
- Releasing `Z` restores click-through immediately — clicks no longer
  hit the overlay, the underlying Roblox window receives them.
- The Accessibility permission prompt does NOT appear during this flow
  (already granted on first install).

**Fail signals:**
- Cursor never appears → uiohook isn't seeing keydown. Most likely cause:
  Accessibility permission missing or revoked on macOS, or Windows
  Defender quarantined the native binary.
- Cursor appears but click doesn't drop a ping → the renderer's
  `OVERLAY_PING_MODE_CLICK` IPC isn't reaching main. Check Electron's
  devtools for the overlay window.
- Ping drops locally but peer doesn't see it → server-side relay issue;
  check `ping:drop` event logs on the Railway dashboard.
- Hold-release doesn't restore click-through → `setIgnoreMouseEvents(true,
  { forward: true })` isn't firing. Roblox would become unplayable;
  immediate rollback.

**Honest gaps (test automation):**
Real-keyboard-driven automated testing of this path is OUT OF SCOPE for
v2. The required machinery — macOS TCC bypass for synthetic keyboard
events + Windows UI Automation — is too heavy for the scope. The hotkey
module exposes a `triggerForTest('hold-start' | 'hold-end')` API in-
process (`client/src/main/input/hotkey.ts:192`) and the `hotkey.test.ts`
unit test exercises it, but driving it from an EXTERNAL process (where
our integration tests live) would require a test-driver IPC mechanism
that does not exist in v2. Manual is the gate.

### 10. End-to-end against the Cloudflare production relay

The production relay lives at `wss://pyng2.vincent-feng1.workers.dev`.

**Procedure:**
1. From a clean machine, install pyng from the landing page (the v2.0.0
   GitHub release artifact).
2. Confirm the relay is up:
   ```
   curl https://pyng2.vincent-feng1.workers.dev/healthz
   ```
   Expected response: `ok`.
3. Launch pyng. The dashboard should show `relay=wss://pyng2.vincent-feng1.workers.dev`
   in the bottom-right or Settings tab.
4. Generate a pairing code. Have a second machine (or a second user)
   install pyng and redeem the code.
5. Both clients should reach `Paired!` state within 3 seconds.
6. Run scenario 9 (hold-Z-click) against this paired session.

**Pass criteria:** pair completes < 3s wall-clock from "click Generate"
to "Paired" on both ends. Cross-machine ping arrives < 500ms after the
sender's click.

**Fail signals:**
- `curl /healthz` returns 502 or times out → Cloudflare Worker deploy is down.
  Check the Worker deployment and logs in the Cloudflare dashboard.
- `Paired!` never fires on both sides → either the code expired (10min
  TTL, very unlikely in fresh use) or one of the clients can't reach
  Cloudflare (firewall, corporate proxy).
- Cross-machine ping latency > 500ms repeatedly → relay latency problem;
  check Cloudflare Worker logs and client network conditions.

### 11. Production resume latency

Separate verification of #10's "< 3s" gate after the app has been idle.
Cloudflare Workers do not use the Railway container cold-start path, but
long-term pair resume still needs to stay quick.

**Procedure:**
1. Wait at least 30 minutes since the last user activity against
   pyng2.vincent-feng1.workers.dev.
2. From a fresh boot of pyng on one machine, generate a code.
3. Redeem on a second machine.

**Pass criteria:** pair completes in < 3 seconds total wall-clock.

**Fail signals:**
- Pair takes > 5 seconds → cold-start is too slow. Check Railway
  config: container CPU/memory allocation, healthcheck timing, image
  size. Consider increasing `min_machines_running` to 2 if cost-tolerable.

### 12. Network blip survival

v2 doesn't implement `pair:resume` (intentionally deferred), so the
contract is "drop, surface clearly, let user re-pair." This scenario
verifies the UX of that flow.

**Procedure:**
1. Pair two devices via the dashboard.
2. On one device, toggle wifi OFF for ~10 seconds.
3. Observe the dashboard pairing tab.
4. Toggle wifi back ON.

**Pass criteria:**
- Within ~5 seconds of wifi-off, the dashboard transitions to
  `disconnected` state with a visible banner ("Reconnecting…" or
  similar — see #58's renderer work).
- After wifi-on, the client reconnects to the relay (rolling backoff;
  1s, 2s, 4s, 8s caps).
- The pair is BROKEN — re-pairing is required. The renderer should
  surface `pairLostHint=true` with a "Pair again" call-to-action.
- No app crash, no zombie overlay window, no orphan ping markers.

**Fail signals:**
- App freezes during the wifi-off period → state machine has a
  blocking call somewhere.
- Reconnect doesn't happen on wifi-on → `scheduleReconnect`'s exponential
  backoff capped wrong or never re-triggered.
- "Pair again" UI doesn't appear → `pairLostHint` not surfaced or
  state-machine didn't transition pair to `unpaired` on close.

### 13. First-real-user scenario (THE v2 gate)

Per the team-lead's Week 2 brief: the v2 release ships only if a user
unfamiliar with the project can install from the landing page, follow
the on-screen instructions, pair with the dev, and drop a ping in
Phantom Forces. Treat this as the hardest test in the v2 suite — it
exercises everything: landing page, installer, first-run UX,
Accessibility permission grant flow (macOS), pair UI, hotkey
discoverability, ping fire path, peer reception.

**Procedure:**
1. Send a Discord message to a friend who has never used pyng with:
   - Link to the landing page (#52).
   - Your pyng pairing code (you generated it in advance).
2. Tell them: "Install this, run it, type the code in, then hold Z and
   click in Phantom Forces while spectating me."
3. Time them. Watch for stumbles.

**Pass criteria:** friend gets a ping on your screen within 5 minutes
total elapsed (including download + install + Accessibility grant +
pair + hold-Z-click).

**Fail signals (each is a separate v2-blocking bug):**
- Friend can't find the download link on the landing page → #52 issue.
- Installer errors / SmartScreen warning blocks them → #51 code-signing
  needed.
- They install but can't find the pyng app afterward → tray-only install
  with no dock/start-menu hint is too aggressive; reconsider #65.
- They open pyng but don't know to enter a code → pairing UI's "redeem"
  affordance isn't discoverable; #66 issue.
- They pair but don't know how to ping → hotkey discoverability problem;
  the dashboard's "How to ping" hint isn't prominent enough.
- macOS friend gets stuck on Accessibility permission → #68 permission
  prompt UX needs work.

If ANY of these fail, the v2 release is held until the specific issue is
resolved. The integration test suite cannot catch these — they're
fundamentally user-facing.

### 14. Press-mode opt-in smoke

Press-mode is a non-default alternative to hold-mode for users in
non-cursor-capture contexts (windowed Roblox, non-FPS games, accessibility
preferences). v2 ships hold as the default; this scenario verifies the
opt-in still works.

**Procedure:**
1. Open pyng dashboard → Settings tab → Hotkey section.
2. Toggle the mode selector to "press" (was "hold" by default).
3. Save. Confirm `[client] hotkey registered accelerator='Z' mode='press'`
   appears in dev logs.
4. Run Roblox in WINDOWED mode (not fullscreen).
5. Press `Z` (do not hold).

**Pass criteria:**
- A ping fires immediately at the center of the screen (press-mode's
  documented fallback per `input-bridge.ts:120` — center-of-screen is
  the deliberate UX because press-mode users don't have an overlay-
  capture cursor read).
- The paired peer receives the ping at coords `(0.5, 0.5)`.

**Fail signals:**
- Holding `Z` triggers a ping (press should fire on keydown, not on
  hold-release) → hotkey's onHoldStart/onHoldEnd mapping inverted.
- No ping fires → the `mode='press'` branch in `input-bridge.ts:78` is
  dead.
- Settings UI doesn't accept "press" → #50 missed an option.

### v2 integration test inventory (automated coverage map)

| Test file | Verifies | Manual gate it complements |
|---|---|---|
| `ping-roundtrip.test.ts` | v1.5: pair → ping → bridge log; avatar attribution; identity-mismatch rejection; pendingAvatars replay | n/a (full automation) |
| `no-dashboard-in-legacy.test.ts` | #67: dev/legacy modes don't open dashboard | n/a |
| `gui-pair-roundtrip.test.ts` | v2: state-machine pair flow via TEST_AUTO_GENERATE / TEST_AUTO_REDEEM env hooks; `Paired! groupId=` contract preserved; dashboard opens | Scenarios 9, 10 |
| `heartbeat.test.ts` | v2: server terminates non-responding clients via heartbeat reaper (cross-process verification of #45's in-process unit test) | Scenario 12 |

**Coverage gaps (intentional, documented):**
- Hot-key driven ping send: covered by manual Scenarios 9 and 14 only.
  Automation requires a test-driver IPC mechanism that doesn't exist in
  v2; revisit if the manual smoke flake rate becomes a problem.
- Latency tracking readout: the state machine subscribes to
  `LatencyTracker` and broadcasts via IPC, but there's no stdout-
  observable log line. Covered by `client/src/main/latency-tracker.test.ts`
  unit tests. A one-line `log('latency updated latencyMs=...')`
  addition would close this gap; deferred.
- Renderer-side rendering assertions: out of v2 scope (would require
  Playwright/Spectron).

## v3 tests

### Overview

v3 adds the spectator-match loop: OCR detects a username on the dead player's screen, the relay matches it against the alive player's registered `robloxUsername`, and both clients update their status displays. Testing this loop requires either two real devices (full e2e) or `npm run dev:mock` (single-machine synthetic).

### Test path 1: two-device full flow

Requires two machines, both with pyng installed and `robloxUsername` set in Settings.

1. On each machine, open pyng and navigate to Settings → Roblox Username.
2. Enter each user's Roblox username and save.
3. On machine A (Alice), click "Generate Code" in the Pairing tab. Note the 6-character code.
4. On machine B (Bob), enter the code in the Pairing tab and click "Redeem". Both machines should show "Paired" within 3 seconds.
5. On machine A, open Roblox, join a supported FPS (Phantom Forces, Bloxstrike, or Operation Onslaught), and die so you are spectating Bob.
6. Verify within 2 seconds: machine A shows "You are spectating your teammate" in the Pairing tab.
7. Verify within 2 seconds: machine B shows "Your teammate is spectating you — ping mode active" in the Pairing tab.
8. On machine A, hold `Z` and click on the screen to drop a ping.
9. Verify: the ping marker appears on machine B's overlay within 500ms.
10. On machine A, respawn (stop spectating Bob).
11. Verify within 5 seconds: both machines revert to "Waiting for spectator match" (no active spectator status shown).

Pass criteria: all 11 steps complete without error or crash. Latency in step 9 < 500ms.

Fail signals:
- Step 6 never fires: OCR is not running or the game's ROI config is wrong.
- Step 7 never fires: the relay's `username:match` dispatch is broken or the real client's `robloxUsername` is empty.
- Step 9 ping lands at wrong position: cross-resolution coordinate translation is broken.
- Step 11 never reverts: the OCR loop's 5-second lost-debounce is not firing.

### Test path 2: single-device mock (via mock-peer)

Requires one machine with pyng. The mock peer plays the role of the "alive player" whose username is detected.

1. Set `MOCK_PEER_DETECTED_USERNAME` to match the real client's `robloxUsername` in Settings (e.g., `export MOCK_PEER_DETECTED_USERNAME=YourRobloxName`).
2. Run `npm run dev:mock`.
3. Wait for both the real Electron app and the mock peer to connect. The terminal should show `[mock-peer:redeem] paired groupId=...`.
4. Wait 5 seconds. Verify the terminal shows `[mock-peer:redeem] sending username:announce detectedUsername=YourRobloxName`.
5. Verify within 3 seconds: the terminal shows `[mock-peer:redeem] username:match received matched=true`.
6. Verify: the real Electron app's Pairing tab shows the spectator status ("You are spectating your teammate").

Pass criteria: step 5 shows `matched=true`. Step 6 shows the correct status.

Fail signals:
- Step 5 shows `username:match timeout`: the relay's match dispatch is not reaching the mock peer, or the real client's `robloxUsername` does not match `MOCK_PEER_DETECTED_USERNAME`.
- Step 5 shows `matched=false`: usernames are present but the matcher's normalization or comparison logic is wrong.
- Step 4 never logs: the announce timer in `scripts/mock-peer.ts` is broken.

Env var summary for mock-peer username flow:

| Variable | Default | Purpose |
|---|---|---|
| `MOCK_PEER_DETECTED_USERNAME` | `MockSpectatedPlayer` | Username sent in the synthetic `username:announce` |

### Test path 3: OCR golden test

Requires fixture images to exist (task #80 must be complete before this gate is meaningful).

1. Run `npm run test:ocr`.
2. Confirm ≥ 95% of fixture assertions pass.
3. Optionally filter by game: `npm run test:ocr -- --game=phantom-forces`.
4. On failure, run `npm run test:ocr -- --verbose` to see per-fixture pipeline output.

Pass criteria: exit 0, ≥ 95% pass rate across all fixtures, ≥ 95% per game.

Fail signals:
- Exit non-zero with < 95% pass rate: add the failing screenshot as a fixture, tune the ROI config or preprocessing, and re-run until it passes.
- A fixture was recently added but the JSON expected value is wrong: update the `.json` sibling to reflect what the pipeline actually outputs in a correct run.

### v3 regression checklist

Run these before any v3 release. Each item is a pass/fail gate.

**1. OCR does not start when unpaired**

1. Open pyng without going through the pairing flow (close or skip the Pairing tab).
2. Wait 10 seconds.
3. Open the Electron DevTools console for the main process.
4. Verify: no `[ocr]` log lines appear beyond the single initialization message.
5. Verify: no `desktopCapturer.getSources` calls appear in the main process log.

Pass: no OCR activity while unpaired.
Fail: `[ocr]` log lines appear or `desktopCapturer` is called — the OCR loop guard on pair state is broken.

**2. OCR does not start when Screen Recording permission is denied (macOS only)**

1. Open System Settings → Privacy & Security → Screen Recording. Revoke pyng's permission if granted, or ensure it is not listed.
2. Launch pyng and complete pairing.
3. Wait 5 seconds.
4. Verify: the main process log shows `[screenRecording] permission denied` (or equivalent).
5. Verify: no `[ocr]` log lines appear beyond initialization.

Pass: `[screenRecording] permission denied` is logged and OCR does not start.
Fail: OCR attempts to start despite denied permission, or the permission check is not logged. On Windows this check is skipped (Screen Recording is a macOS-only TCC permission).

**3. onLost fires after 5 seconds of username absence**

1. Pair two clients (or use `npm run dev:mock`).
2. Inject a fixture into the OCR loop that returns a username for the first 3 ticks, then returns `null` for subsequent ticks. (Developer-mode approach: temporarily replace the screen capture source with a fixture that has no spectator UI.)
3. Verify: a single `[ocr] username lost` log line appears approximately 5 seconds after the last successful username detection.
4. Verify: only one `[ocr] username lost` line appears (debounce prevents repeats).

Pass: exactly one `[ocr] username lost` after ~5 seconds of null results.
Fail: the line appears immediately (debounce not applied), appears multiple times (debounce resets incorrectly), or never appears (lost-detection is broken).

**4. No `username:announce` sent when peerRobloxUsername is empty**

1. Pair two clients where the alive player (the one whose username would be detected) has `robloxUsername` set to `''` in Settings.
2. On the dead player's machine, start spectating.
3. Observe the relay server logs.
4. Verify: no `username:announce` envelope appears in the server logs.

Pass: no `username:announce` sent.
Fail: `username:announce` is sent with an empty or blank `detectedUsername` — the guard in the OCR loop or announce sender is missing.

**5. Nudge banner visible when paired with no username**

1. Pair two clients where both sides have `robloxUsername === ''` in Settings.
2. On each machine, navigate to the Pairing tab in the dashboard.
3. Verify: a nudge banner is visible reading "Set your Roblox username in Settings so your teammate can be identified." (or similar wording per the UI copy).
4. Navigate to the Settings tab.
5. Verify: a nudge is also visible in the Settings tab prompting the user to enter their Roblox username.

Pass: both nudges are visible when `robloxUsername` is empty after pairing.
Fail: nudges are absent — the `peerRobloxUsernameEmpty` or equivalent flag is not being set, or the renderer is not rendering the banner.

## v4 tests

### Overview

v4 adds real-time ping tracking: when the alive player rotates their camera, pings stay locked to the same world bearing rather than drifting on-screen. A capture loop (15fps by default) feeds frames into an optical-flow motion estimator; the estimator's yaw/pitch deltas update a `PingTracker` that recomputes screen positions; the overlay renderer interpolates between tracker updates at 60fps using a rAF tick. An `EdgeArrow` replaces the ping marker when the bearing is behind the camera.

Testing this feature requires either two devices (full e2e) or `npm run dev:mock` (single-machine synthetic). Camera-rotation tracking specifically requires real Roblox input and cannot be automated in CI.

### 1. Tracking lifecycle

**Start condition:** tracking starts when `spectatorState === 'spectating'` AND the alive teammate's Roblox username has been confirmed via `UsernameMatcher`. Both conditions must hold simultaneously. Tracking stops on any state change away from `spectating` or on unpair.

Verify by reading `client/src/main/index.ts` `runAppMode`: the `TrackingLoop.start()` call is inside the `UsernameMatcher` `onSpectating` callback, and `TrackingLoop.stop()` is called in `onIdle`, `onUnpaired`, and on app quit.

**Automated coverage:** `client/src/main/tracking/tracking-loop.test.ts` (9 tests) verifies `start()`/`stop()` lifecycle, frame-pair → motion → `applyMotion` chain, `null` motion guard, `projectAll` → `emitPositionUpdate`, and frame-budget step-down.

### 2. Calibration smoke (DEFERRED — user must run)

Settings → Tracking Calibration → "Calibrate now".

1. While calibrating, hold right-click in a Roblox FPS and rotate the camera a full 360° horizontally.
2. Release right-click and click "Save calibration".
3. Verify the displayed `pixelsPerDegree` and `mousePixelsPerDegree` values are in the plausible range 5.0–20.0.
4. Confirm "Save" persists (re-open Settings; values still present).

If calibration values are outside the 5–20 range, the player's sensitivity is unusually low or high. The estimator degrades gracefully but tracking accuracy will be reduced.

Calibration data is stored in settings schema v3 under `calibrationData` (see `client/src/main/settings.ts`).

### 3. Edge arrow visual check (DEFERRED — user must run)

1. Pair two devices. Both set Roblox usernames. Both calibrate.
2. In Phantom Forces, die and begin spectating your teammate.
3. Drop a ping at roughly the center of the screen.
4. Rotate the camera 180° horizontally (the ping bearing is now behind the camera).

**Pass criteria:**
- A chevron/arrow appears at the appropriate screen edge (left or right, depending on rotation direction).
- The arrow's rotation angle points toward the out-of-view bearing.
- Rotating the camera back toward the ping: the edge arrow disappears and the ping marker reappears at the correct position.

**Fail signals:**
- Arrow does not appear when ping is off-screen — `isEdgeArrow` path not reached in `ping-tracker.ts`.
- Arrow appears at the wrong edge — bearing math sign error in `ping-tracker.ts:bearingToEdge`.
- Ping marker does not reappear when camera faces back — `trackedPositions` not updated or pruned incorrectly in the renderer.

### 4. Performance gate (DEFERRED — user must run)

1. Boot pyng + Roblox. Open a Phantom Forces match and die so tracking is active.
2. Monitor CPU (Task Manager on Windows / Activity Monitor on macOS) for the `pyng` process.

**Pass criteria:** CPU < 30% on a 2022-era laptop (e.g., M1 MacBook Air, Intel i5 12th gen). During startup calibration, optical tracking runs at 15 fps and steps down to 8 fps if the frame budget is exceeded. After calibration completes or times out, optical capture stops and mouse-only bearing tracking stays active (the `[tracking] optical calibration ...; mouse-only tracking active` log line confirms it fired).

To enable per-frame timing, set `TRACK_PERF=1` in the environment before launching:
```bash
TRACK_PERF=1 npm run dev
```
This logs per-frame timings to the Electron main process console.

### 5. Automated regression checklist

These gates run in CI and must pass before any merge to main.

- [ ] `npm run lint` exits 0 (ESLint + Prettier)
- [ ] `npx tsc --noEmit -p shared/tsconfig.json` exits 0
- [ ] `npx tsc --noEmit -p server/tsconfig.json` exits 0
- [ ] `npx tsc --noEmit -p client/tsconfig.json` exits 0
- [ ] `npm run test:integration` exits 0 (12 integration tests)
- [ ] `npm run test --workspaces --if-present` exits 0 (server: 32 tests, client: 157 pass / 8 skip Electron-only)
- [ ] `npm run test:ocr` exits 0 with ≥ 95% pass rate (BLOCKED on task #80 fixtures + #81 script — not yet runnable)

### 6. Mock-peer smoke for v4 (DEFERRED — user must run)

```bash
MOCK_PEER_DETECTED_USERNAME=<your-roblox-username> npm run dev:mock
```

1. Wait for `[mock-peer:redeem] paired groupId=...`.
2. Wait ~5 seconds for `[mock-peer:redeem] sending username:announce detectedUsername=<username>`.
3. Confirm `[mock-peer:redeem] username:match received matched=true`.
4. Press `p` in the mock-peer terminal to drop a synthetic ping.

**Pass criteria:** the ping marker appears on the Electron overlay at the coordinates the mock peer logged. Note that tracking does NOT activate in this flow because the mock peer does not simulate a spectating spectatorState from a real Roblox session — the `UsernameMatcher` fires but `spectatorState` stays at `idle` until OCR confirms live spectating. The ping still routes through the legacy `OVERLAY_SHOW_PING` path and renders correctly.

**Synthetic motion (future enhancement):** the mock peer does not currently emit synthetic camera-rotation events. If this becomes useful for headless tracking tests, add a `MOCK_ROTATION_DPS=<degrees-per-second>` env var that fires periodic synthetic `applyMotion` calls via a direct IPC pipe to the Electron main process. Not implemented in v4.

### 7. Live two-device tracking smoke (DEFERRED — user must run)

1. Both devices: install pyng, set Roblox usernames in Settings, run calibration.
2. Generate a pair code on device A; redeem on device B.
3. Both join Phantom Forces. Device A user starts playing; device B user is spectating device A's teammate.
4. Wait for device B's status to show "You are spectating your teammate" — OCR has detected the username.
5. Drop a ping on device B (hold Z, click).
6. On device A: observe the ping marker on the overlay.
7. On device A: rotate the camera 45° to the left.

**Pass criteria:**
- The ping marker moves left on device A's overlay to track the camera rotation (bearing is maintained).
- Rotate 180°: edge arrow appears at the screen edge.
- Rotate back: ping marker reappears at correct position.
- End-to-end latency from click to first render on device A < 500ms.

**Fail signals:**
- Ping does not track rotation — tracking loop not started or `applyMotion` not called.
- Ping drifts over time (accumulates error) — RANSAC inlier threshold too loose or confidence decay is too slow.
- CPU spike causes dropped frames and visible jitter — performance gate check needed.

## Multi-device test scenarios

Before any release, the following checklist must pass with two physical PCs:

### Setup
- [ ] PC1 (Alice) and PC2 (Bob) both have latest pyng installed
- [ ] Both PCs are on residential wifi (not LAN) to test realistic latency
- [ ] Both Roblox accounts logged in
- [ ] Discord call running between Alice and Bob (verify no conflicts)

### Pairing
- [ ] Alice generates code, Bob redeems → both see "Paired"
- [ ] Pair survives Alice's pyng restart
- [ ] Pair survives Bob's wifi blip (< 5 min)
- [ ] Pair correctly breaks after 5+ min disconnect

### Same resolution (both 1080p)
- [ ] Alice dies in Phantom Forces, OCR detects spectating Bob within 2s
- [ ] Alice drops 5 pings across the screen; Bob sees all 5 at the correct positions (visual check)
- [ ] Latency reported < 500ms in 9/10 pings
- [ ] Ping accuracy: ping at top-left, center, bottom-right all appear correctly on Bob's screen

### Mixed resolution (Alice 1080p, Bob 1440p)
- [ ] Pings appear at proportionally correct positions on Bob's screen
- [ ] No pings appear in HUD area (test by clicking on Alice's HUD area — should be rejected)
- [ ] Drift < 5% of screen size for pings in viewport center
- [ ] Drift < 10% of screen size for pings near viewport edges

### Mixed resolution (Alice 1080p, Bob 4K)
- [ ] Same checks as 1440p case
- [ ] Pings render at correct visual size on 4K (no tiny dots)

### Per-game
For each supported game (Phantom Forces, Bloxstrike, Operation Onslaught):
- [ ] OCR detects spectated username within 2s of starting to spectate
- [ ] OCR confidence > 0.7 in good conditions (bright map, clear UI)
- [ ] OCR correctly returns null when not spectating
- [ ] Ping mode activates on match, deactivates on respawn

### Stress
- [ ] Drop 20 pings in 30s — no client lag, no dropped messages, server handles rate limiting gracefully
- [ ] Network throttled to 3G speeds — pings still arrive within 1.5s, UI shows latency warning
- [ ] PC1 sleeps mid-match — pair restores when PC1 wakes

### Compatibility
- [ ] Works with Discord overlay enabled
- [ ] Works with OBS Studio recording
- [ ] Works with NVIDIA GeForce Experience overlay
- [ ] Works with Steam overlay enabled
- [ ] Works at refresh rates: 60Hz, 144Hz, 240Hz

### Failure modes
- [ ] Server unreachable: client shows clear error, retries with backoff
- [ ] OCR fails repeatedly: UI shows "OCR failing — try restarting"
- [ ] Roblox not running: app shows "Roblox not detected", no errors thrown
- [ ] Display config change mid-match (monitor plugged in): overlay recreates on new display

## Mock-peer implementation notes

The mock peer is a Node.js process (not Electron) that connects to the relay server and behaves like a paired pyng client.

```typescript
// scripts/mock-peer.ts
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:7788');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', payload: { ... } }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  switch (msg.type) {
    case 'ping:drop':
      console.log(`[MOCK PEER] Received ping at (${msg.payload.coords.x.toFixed(3)}, ${msg.payload.coords.y.toFixed(3)})`);
      // optionally: render on a Node-canvas + show in a separate window
      break;
    // ... other message types
  }
});
```

Latency simulation: introduce `setTimeout(handler, MOCK_LATENCY_MS)` around message handling.

Packet loss: roll a random number, drop if < `MOCK_PACKET_LOSS`.

## OCR test fixture management

Fixtures live in `fixtures/<game>/`. Each PNG has a sibling JSON:

```
fixtures/
  phantom-forces/
    spectating-friend-1080p.png
    spectating-friend-1080p.json
    spectating-friend-1440p.png
    spectating-friend-1440p.json
    just-died.png
    just-died.json
```

JSON format:
```json
{
  "scenario": "Spectating teammate, mid-match, well-lit map",
  "resolution": "1920x1080",
  "expected": {
    "username": "FriendUsername",
    "minConfidence": 0.7
  }
}
```

For negative cases (no spectating UI):
```json
{
  "scenario": "Just respawned, no spectator UI present",
  "resolution": "1920x1080",
  "expected": {
    "username": null
  }
}
```

When adding a new fixture, run the OCR test to verify it produces the expected output, then commit both the PNG and the JSON.

## Reproducing failures from production

When a user reports "OCR didn't detect" or "ping landed in wrong place":

1. Ask for a screenshot of their pyng at the failure moment
2. Ask for their resolution + game config
3. Add their screenshot to `fixtures/<game>/` with the failure case
4. Write a test that demonstrates the failure
5. Tune the config or pipeline until the test passes
6. Verify other fixtures still pass

This is the only way the project gets more robust over time. Capture every bug as a fixture.

## CI

GitHub Actions runs:

1. Lint + TypeScript check
2. Unit tests
3. OCR golden tests
4. Integration tests
5. Build verification (electron-builder dry run)

Multi-device tests are manual only — they can't be automated without dedicated hardware. The release checklist enforces them.

The v1 pair → ping:drop → overlay-bridge integration test (`npm run test:integration`) runs in CI. The v1 click-through smoke (see "v1 manual smoke tests" above) is manual-only on macOS until a Windows runner with UI Automation lands — we deliberately don't claim automated click-through coverage that doesn't exist.

## Metrics to track in production (optional)

If telemetry is added later (opt-in only):

- OCR accuracy rate per game
- End-to-end ping latency p50, p95, p99
- Pair success rate (codes generated vs. successfully redeemed)
- Crash rate
- Reconnect frequency

Use these to drive fixture updates and config tuning.

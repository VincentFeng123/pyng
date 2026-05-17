# pyng v0.2.0 — first public release

Download `pyng-Setup-0.2.0.exe` below (Windows 10/11, ~89 MB).

## What's in this release

- **GUI dashboard** — generate a 6-character pairing code or redeem one. Two tabs: Pairing and Settings.
- **Hotkey hold-mode** — hold `Z` to make the cursor reappear over Roblox, click anywhere to drop a ping on your friend's screen at that exact pixel. Press-mode is opt-in via Settings.
- **Tray icon** — pyng lives in your menu bar / notification area. Close the window, it keeps running.
- **Reconnect awareness** — if the relay drops, you get a yellow "Reconnecting…" indicator. If you were paired, a dismissible banner asks you to re-pair after reconnect.
- **macOS Accessibility prompt** — on first launch, pyng explains why it needs Accessibility permission and deep-links to the right System Settings pane. Restart pyng after granting.

## How it works

1. Install pyng on both your and your friend's PCs.
2. One of you generates a 6-character code in the Pairing tab.
3. The other enters it. You're paired.
4. When you die in-game, hold `Z` and click where you want the ping. Your friend's screen shows the ping immediately.

## Notes

- **Beta software.** Windows SmartScreen will warn "Unknown publisher" — click "More info" → "Run anyway".
- Tested on Phantom Forces, Bloxstrike, and Operation Onslaught.
- The relay server is hosted at `wss://pyng-relay.up.railway.app`. No accounts, no game data ever leaves your machine — only the ping coordinate and your avatar (if set).

See [`CHANGELOG.md`](./CHANGELOG.md) for the full v0.0 → v0.2 history.

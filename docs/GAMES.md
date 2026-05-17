# Games

Roblox FPS games tested with pyng.

## Supported games (v2)

pyng has been verified to render pings over the following Roblox FPS games in
spectator mode at default 1080p windowed/borderless. The hotkey + ping flow is
game-agnostic — pyng draws on a transparent overlay above whatever's on screen
— so any Roblox game will technically work. The list below is the set that's
been smoke-tested:

| Game | Status | Notes |
|---|---|---|
| Phantom Forces | Known working | The primary v2 test target. |
| Bloxstrike | Known working | |
| Operation Onslaught | Known working | |

"Known working" means: the overlay draws above the game, the global hotkey
fires correctly while the game has focus (hold-mode), and pings drop at
the cursor coord with no visible interference from the game's HUD. It does
NOT mean Roblox-spectator-UI OCR is implemented — that's v3 (see "OCR
configuration" below for the design reference).

### Resolution and aspect-ratio caveat

pings are normalized to the (0..1) viewport-coordinate space at send time
and denormalized on the receiver's screen. If both players play at the same
aspect ratio, pings land where the sender expected. If aspect ratios
**differ** (e.g. Alice on 16:9 1080p, Bob on 21:9 ultrawide), Bob sees a
wider field of view than Alice; a ping at Alice's screen-right edge lands
at ~75% of Bob's screen, NOT at his right edge.

**Recommendation:** for accurate pings, both players should play at the same
aspect ratio. 16:9 is the safe default — supported across 1080p, 1440p, 4K
displays.

This is a fundamental property of the wire protocol (pings carry normalized
coords, not absolute pixel positions), not a bug. v3 may add aspect-ratio
hinting on `peer:avatar`-style envelopes so the overlay can render a
side-indicator chevron when a ping falls outside the receiver's viewport.

## OCR configuration (v3 reference)

The schema below describes per-game OCR config for v3's auto-pair-mode
("ping mode activates when you spectate your teammate"). v2 does NOT use
any of this — the hotkey fires unconditionally while paired regardless of
what's on screen. The schema stays in this doc so v3 has a starting point.

## Schema

```typescript
// shared/games.ts
export type GameConfig = {
  id: string;                    // kebab-case unique identifier
  displayName: string;           // human-readable name
  robloxPlaceIds: number[];      // Roblox place IDs for game detection
  
  detection: {
    windowTitlePattern?: string; // regex matched against window title
    processName?: string;        // Windows process name (usually "RobloxPlayerBeta.exe")
  };
  
  spectatorUI: {
    roi: { x: number; y: number; w: number; h: number };  // normalized 0..1
    pattern: string;             // regex with one capture group for username
    preprocessing: {
      scale: number;             // 1.0..4.0, recommended 2.0
      threshold?: number;        // 0..255, omit for adaptive
      invert: boolean;
      grayscale: boolean;
    };
    minConfidence: number;       // 0..1, Tesseract confidence threshold
  };
  
  viewportArea: {                // HUD pixel bounds to exclude from ping coords
    topPx: number;
    bottomPx: number;
    leftPx: number;
    rightPx: number;
  };
  
  version: string;               // semver of this config
  lastVerified: string;          // ISO date when config was last verified working
};
```

## Initial supported games

### Phantom Forces (`games/phantom-forces.json`)

```json
{
  "id": "phantom-forces",
  "displayName": "Phantom Forces",
  "robloxPlaceIds": [292439477],
  "detection": {
    "windowTitlePattern": "Phantom Forces|Roblox",
    "processName": "RobloxPlayerBeta.exe"
  },
  "spectatorUI": {
    "roi": { "x": 0.0, "y": 0.92, "w": 0.4, "h": 0.05 },
    "pattern": "^Spectating:\\s+(.+)$",
    "preprocessing": {
      "scale": 2.0,
      "threshold": 180,
      "invert": false,
      "grayscale": true
    },
    "minConfidence": 0.7
  },
  "viewportArea": {
    "topPx": 0,
    "bottomPx": 120,
    "leftPx": 0,
    "rightPx": 0
  },
  "version": "1.0.0",
  "lastVerified": "2026-05-14"
}
```

### Bloxstrike (`games/bloxstrike.json`)

```json
{
  "id": "bloxstrike",
  "displayName": "Bloxstrike",
  "robloxPlaceIds": [],
  "detection": {
    "windowTitlePattern": "Bloxstrike|BLOXSTRIKE",
    "processName": "RobloxPlayerBeta.exe"
  },
  "spectatorUI": {
    "roi": { "x": 0.35, "y": 0.02, "w": 0.3, "h": 0.05 },
    "pattern": "Watching\\s+(.+)",
    "preprocessing": {
      "scale": 2.5,
      "threshold": 140,
      "invert": false,
      "grayscale": true
    },
    "minConfidence": 0.7
  },
  "viewportArea": {
    "topPx": 60,
    "bottomPx": 100,
    "leftPx": 0,
    "rightPx": 0
  },
  "version": "0.1.0",
  "lastVerified": "2026-05-14"
}
```

### Operation Onslaught (`games/operation-onslaught.json`)

```json
{
  "id": "operation-onslaught",
  "displayName": "Operation Onslaught",
  "robloxPlaceIds": [],
  "detection": {
    "windowTitlePattern": "Operation Onslaught",
    "processName": "RobloxPlayerBeta.exe"
  },
  "spectatorUI": {
    "roi": { "x": 0.0, "y": 0.04, "w": 0.5, "h": 0.05 },
    "pattern": "Spectating\\s+(.+)",
    "preprocessing": {
      "scale": 3.0,
      "threshold": 150,
      "invert": false,
      "grayscale": true
    },
    "minConfidence": 0.7
  },
  "viewportArea": {
    "topPx": 90,
    "bottomPx": 110,
    "leftPx": 0,
    "rightPx": 0
  },
  "version": "0.1.0",
  "lastVerified": "2026-05-14"
}
```

**Note:** The exact `roi`, `preprocessing`, and `viewportArea` values above are best-effort placeholders. Verify and tune empirically with real game footage. See "Adding or updating a game" below.

## Game detection logic

When pyng captures a screen frame, it determines which game config (if any) is active:

```typescript
function detectGame(windowTitle: string, processName: string, placeId?: number): GameConfig | null {
  // Strongest signal: place ID match
  if (placeId !== undefined) {
    const byPlaceId = games.find(g => g.robloxPlaceIds.includes(placeId));
    if (byPlaceId) return byPlaceId;
  }
  
  // Fallback: window title pattern match
  const byTitle = games.find(g => {
    if (!g.detection.windowTitlePattern) return false;
    return new RegExp(g.detection.windowTitlePattern, 'i').test(windowTitle);
  });
  
  return byTitle ?? null;
}
```

If no game matches, OCR is skipped. The UI shows "no supported game detected."

The user can also manually select a game in settings to force-use a config — useful if detection fails for an obscure variant.

## Adding or updating a game

### 1. Gather fixtures

Get 10–20 real screenshots covering:

- Spectating a teammate (different usernames, including edge cases like short names and ones with underscores)
- Just died (transition state with possibly partial UI)
- Mid-match scoreboard view
- Different maps (varied background brightness)
- Multiple resolutions (1080p, 1440p, 4K if possible)
- Both team colors / both sides if asymmetric

Save to `fixtures/<game-id>/<scenario>-<resolution>.png` with a sibling `.json` describing the expected detection.

### 2. Determine the ROI

Open one of the screenshots in an image editor. Identify the rectangle containing the spectator UI text. Express it as normalized coords:

```
roi.x = leftEdge / screenWidth
roi.y = topEdge / screenHeight
roi.w = width / screenWidth
roi.h = height / screenHeight
```

Verify at a different resolution — the ROI should be the same in normalized coords (the game UI scales proportionally).

### 3. Write the regex pattern

Test it against the actual text Tesseract produces from your fixtures. Common patterns:

- `^Spectating:\s+(.+)$` (Phantom Forces style)
- `Watching\s+(.+)` (Bloxstrike style)
- `^(.+)$` (some games show just the username with no prefix)

Always include a capture group for the username.

### 4. Tune preprocessing

Start with the defaults (`scale: 2.0, threshold: 180, invert: false, grayscale: true`). Run OCR tests. Adjust based on accuracy:

- Accuracy < 60%: try invert, try lower threshold (140), try higher scale (3.0)
- Wrong characters detected: tighten char whitelist in Tesseract config
- Detecting non-username text: tighten the ROI

### 5. Measure viewport area

For ping coordinate translation, identify how much of the screen is HUD (not game world).

- Take a fullscreen screenshot mid-match
- Find the top of the game viewport (below any top HUD)
- Find the bottom of the game viewport (above any bottom HUD)
- Same for left/right if applicable
- Record as pixel offsets from each edge

These are pixel values, not normalized — the game's HUD has fixed pixel dimensions regardless of resolution (mostly).

### 6. Test

```bash
npm run test:ocr -- --game=<game-id>
```

Aim for > 95% accuracy across all fixtures. If you can't reach it, the game's UI may need invert/threshold/scale adjustments or it may genuinely be too noisy for reliable OCR.

### 7. Add to active games list

Configs in `games/` are auto-loaded on startup. No registration step needed beyond placing the JSON.

## Versioning configs

When a game updates its UI:

1. Bump the config's `version` (semver — major if ROI changes, minor if preprocessing changes, patch if just tweaks)
2. Update `lastVerified` to today's date
3. Add new fixtures showing the new UI
4. Old fixtures from the previous UI version are kept but marked deprecated

## Known limitations

- **UGC games can change UI any time.** Roblox developers can push updates. There's no API to detect this — we rely on user reports + monitoring fixture test pass rates over time.
- **Custom HUDs in mods/private servers.** Some servers customize the HUD; pyng will fail in those. Document as "supported only on official servers" for each game.
- **Different gun-zoom states.** When scoped/aiming, some games dim or hide HUD. OCR may fail during these states. That's fine — the next 1Hz cycle will catch it after the player unscopes.

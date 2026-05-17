# OCR Pipeline

How pyng detects which player you're spectating from the Roblox game's UI.

## Overview

```
[Screen pixels] → [Crop to ROI] → [Preprocess] → [Tesseract] → [Parse] → [Validate] → [Emit]
```

Runs at 1Hz while Roblox is focused. Skipped when Roblox is not the foreground process.

## Step 1: Screen capture

The Electron main process captures the primary display via `desktopCapturer`:

```typescript
const sources = await desktopCapturer.getSources({
  types: ['screen'],
  thumbnailSize: { width: screen.width, height: screen.height },
});
const primary = sources.find(s => s.display_id === primaryDisplay.id);
const buffer = primary.thumbnail.toPNG();
```

`thumbnailSize` matters — set it to the full display resolution. Smaller thumbnails save time but lose text fidelity.

## Step 2: Crop to ROI

Each game config defines an ROI in normalized coords (0..1):

```typescript
// games/phantom-forces.json
{
  "spectatorUI": {
    "roi": { "x": 0.0, "y": 0.92, "w": 0.4, "h": 0.05 }
  }
}
```

Multiply by current resolution to get pixel coords:

```typescript
const px = {
  x: Math.round(roi.x * screenWidth),
  y: Math.round(roi.y * screenHeight),
  w: Math.round(roi.w * screenWidth),
  h: Math.round(roi.h * screenHeight),
};
const cropped = image.extract(px);
```

Use `sharp` for image cropping in Node — it's fast and well-maintained.

## Step 3: Preprocess

Per-game preprocessing config:

```json
{
  "preprocessing": {
    "scale": 2.0,
    "threshold": 180,
    "invert": false,
    "grayscale": true
  }
}
```

Pipeline:

```typescript
let img = sharp(croppedBuffer);
if (cfg.grayscale) img = img.greyscale();
if (cfg.scale !== 1.0) img = img.resize({ 
  width: cropped.width * cfg.scale,
  kernel: 'lanczos3' 
});
if (cfg.threshold) img = img.threshold(cfg.threshold);
if (cfg.invert) img = img.negate();
const processed = await img.toBuffer();
```

**Why scale up?** Tesseract performs significantly better on text larger than ~30px tall. Most Roblox UI text is 20–24px at 1080p. Scaling 2x gives Tesseract enough resolution to work with.

**Why threshold?** Tesseract works best on pure black-on-white. Threshold converts the anti-aliased UI text into hard edges.

**Why invert?** Some games have light text on dark UI. After threshold, you get white text on black background — Tesseract wants the opposite. Invert flips it.

## Step 4: Tesseract recognize

Use a persistent Tesseract.js worker. Initialization is slow (~3 seconds); create once at startup, reuse forever.

```typescript
// At app startup
const worker = await createWorker('eng');
await worker.setParameters({
  tessedit_pageseg_mode: PSM.SINGLE_LINE,
  tessedit_char_whitelist: 
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-:',
});

// Per detection
const result = await worker.recognize(processedBuffer);
// result.data.text === "Spectating: SomeUsername"
// result.data.confidence === 87.5  (0..100)
```

PSM 7 (SINGLE_LINE) tells Tesseract to treat the entire image as one line of text. The spectator UI strip is exactly one line.

The whitelist limits Tesseract to characters that can appear in Roblox usernames + the literal "Spectating:" prefix. Limits hallucinated chars.

## Step 5: Parse

Apply the game's regex to extract just the username:

```typescript
const pattern = new RegExp(cfg.spectatorUI.pattern);
const match = result.data.text.match(pattern);
if (!match) return null;
const detected = match[1].trim();
```

For Phantom Forces: `^Spectating:\s+(.+)$` captures everything after "Spectating: ".

## Step 6: Validate

Tesseract is noisy. Validate aggressively before emitting:

```typescript
function validate(detected: string, confidence: number, cfg: GameConfig): string | null {
  // Confidence threshold (Tesseract returns 0..100)
  if (confidence < cfg.spectatorUI.minConfidence * 100) return null;
  
  // Roblox username format: 3-20 chars, alphanumeric + underscore
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(detected)) return null;
  
  // Common OCR mistakes / UI words to reject
  const denyList = ['Spectating', 'Press', 'Tab', 'Esc', 'Scoreboard'];
  if (denyList.includes(detected)) return null;
  
  return detected;
}
```

## Step 7: Emit

If validation passes, send to the main process which forwards to the relay server:

```typescript
mainProcess.emit('username:detected', {
  game: cfg.id,
  username: validated,
  confidence: confidence / 100,
});
```

If validation fails, emit nothing. Don't guess.

## State machine

The OCR worker maintains a small state machine to avoid spam:

```
IDLE
  ↓ (Roblox focused + game detected)
SCANNING
  ↓ (username detected)
TRACKING(username, lastSeen)
  ↓ (same username detected within 5s) → stay TRACKING
  ↓ (different username) → emit transition, update TRACKING
  ↓ (no username for 5s) → emit lost, back to SCANNING
```

This stops the system from rapidly toggling pings on/off if OCR has occasional misses.

## Performance

Target: full pipeline in under 200ms per cycle.

| Step | Budget |
|---|---|
| Screen capture | 30ms |
| Crop | 5ms |
| Preprocess | 40ms |
| Tesseract | 100ms |
| Parse + validate | 5ms |
| Total | ~180ms |

If exceeded consistently, downscale the screen capture or move OCR to a worker thread.

## Per-game tuning examples

### Phantom Forces
- ROI: bottom-left strip
- White bold text on translucent dark
- threshold: 180, no invert

### Bloxstrike
- ROI: top-center, smaller text
- Lighter font
- threshold: 140, no invert

### Operation Onslaught
- ROI: center-bottom
- Standard Roblox font, smaller
- threshold: 150, no invert, scale 3x (text is smaller)

## Testing

OCR is highly empirical. The only reliable test method is golden fixtures.

```
fixtures/
  phantom-forces/
    spectating-friend-1080p.png
    spectating-friend-1080p.json   { expected: "FriendUsername" }
    spectating-friend-1440p.png
    spectating-friend-1440p.json   { expected: "FriendUsername" }
    just-died.png
    just-died.json                  { expected: null }
    ...
```

Add fixtures whenever you see a real-world miss. Tune until accuracy > 95% across all fixtures.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Detects "Spectating" as username | Pattern regex doesn't anchor properly | Use `^Spectating:\s+(.+)$` not `Spectating:\s*(.+)` |
| Mixes up `0` and `O`, `1` and `l` | Tesseract guessing | Tighten char whitelist; bump scale |
| Random non-username text | ROI too wide | Tighten ROI to just the text region |
| No detection on dark maps | Threshold too high | Lower threshold or enable adaptive thresholding |
| Slow (>500ms per cycle) | Full-screen Tesseract | Verify ROI is being applied before Tesseract call |

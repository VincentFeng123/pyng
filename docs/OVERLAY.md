# Overlay

How the transparent always-on-top overlay window is built and how pings are positioned across mismatched resolutions.

## The window

The overlay is a separate `BrowserWindow` from the main UI. It's transparent, frameless, click-through, and covers the entire primary display.

```typescript
import { BrowserWindow, screen } from 'electron';

function createOverlay(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.bounds;
  
  const overlay = new BrowserWindow({
    x, y, width, height,
    
    // Transparency
    transparent: true,
    frame: false,
    hasShadow: false,
    
    // Behavior
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,         // never steals focus from Roblox
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    
    // Display
    fullscreen: true,
    
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  
  // Critical: clicks pass through to Roblox
  overlay.setIgnoreMouseEvents(true, { forward: true });
  
  // Stay above fullscreen games
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  
  overlay.loadFile('dist/overlay/index.html');
  return overlay;
}
```

### Why each option

- **`transparent: true`** — required for see-through window
- **`frame: false`** — no title bar / borders
- **`hasShadow: false`** — Windows draws a shadow on transparent windows by default; this kills the illusion
- **`focusable: false`** — overlay must never grab keyboard focus from Roblox
- **`setIgnoreMouseEvents(true, { forward: true })`** — clicks pass through to Roblox. The `forward: true` part still forwards mouse move events to the renderer so it can show hover effects on pings if needed.
- **`setAlwaysOnTop(true, 'screen-saver')`** — the highest non-system level. Stays above fullscreen apps. Lower levels get covered by fullscreen Roblox.
- **`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`** — makes the overlay eligible to appear in macOS fullscreen Spaces
- **macOS `app.setActivationPolicy('accessory')` while an overlay exists** — regular Dock apps do not reliably carry transparent always-on-top windows into other apps' fullscreen Spaces. Accessory/menu-bar apps do, and pyng keeps dashboard/quit access through the tray/menu-bar item.

## When to toggle click-through

For the dead player to drop a ping, they need to click and have it captured by pyng (not pass through). Pattern: toggle off when ping mode is active, toggle back on when ping is sent.

```typescript
function startPingMode() {
  overlay.setIgnoreMouseEvents(false);
  overlay.webContents.send('overlay:cursor-show');
}

function endPingMode() {
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.webContents.send('overlay:cursor-hide');
}
```

Bound to a hotkey (default `Ctrl+Shift+P`). Alternative: enable ping mode automatically when OCR detects the user is spectating, disable when they respawn.

## Multi-monitor handling

For v1, the overlay covers ONLY the primary display. Roblox's window has to be on the primary display for pyng to work.

For multi-monitor support (v2): listen to `screen.on('display-metrics-changed')` and recreate the overlay if config changes.

## Coordinate translation

The hardest correctness problem in the project.

### Why naive (x, y) doesn't work

If Alice's screen is 1920×1080 and Bob's is 2560×1440, sending raw pixels means a ping at Alice's (960, 540) lands at Bob's (960, 540) — which is upper-left of Bob's screen, not center.

### The fix: normalize against the viewport

Each game has a **viewport area** = the part of the screen that shows the game world (excluding HUD bars). Defined per game in `games/<game>.json`:

```json
{
  "viewportArea": {
    "topPx": 0,
    "bottomPx": 120,
    "leftPx": 0,
    "rightPx": 0
  }
}
```

The numbers are pixels from each edge to exclude. `bottomPx: 120` means the bottom 120px of the screen is HUD (kill feed, ammo, etc.) — not part of the actual gameplay viewport.

### Encode (sender side)

```typescript
function pixelsToNormalizedViewport(
  pxX: number, pxY: number,
  screenW: number, screenH: number,
  vp: ViewportArea
): { x: number; y: number } {
  // Find the viewport's pixel bounds on this screen
  const vpLeft = vp.leftPx;
  const vpRight = screenW - vp.rightPx;
  const vpTop = vp.topPx;
  const vpBottom = screenH - vp.bottomPx;
  const vpW = vpRight - vpLeft;
  const vpH = vpBottom - vpTop;
  
  // Normalize click position within the viewport
  const x = (pxX - vpLeft) / vpW;
  const y = (pxY - vpTop) / vpH;
  
  return { x, y };  // both in 0..1
}
```

Clamp x and y to [0, 1]. Reject pings outside the viewport (e.g., clicks on HUD).

### Decode (receiver side)

```typescript
function normalizedViewportToPixels(
  x: number, y: number,
  screenW: number, screenH: number,
  vp: ViewportArea
): { pxX: number; pxY: number } {
  const vpLeft = vp.leftPx;
  const vpRight = screenW - vp.rightPx;
  const vpTop = vp.topPx;
  const vpBottom = screenH - vp.bottomPx;
  const vpW = vpRight - vpLeft;
  const vpH = vpBottom - vpTop;
  
  const pxX = vpLeft + x * vpW;
  const pxY = vpTop + y * vpH;
  
  return { pxX, pxY };
}
```

Result: ping at Alice's center-of-viewport lands at Bob's center-of-viewport, regardless of resolution differences.

## Aspect ratio caveat

The normalization above assumes both clients see the same FOV with the same aspect ratio. Most Roblox FPS games render to the user's monitor aspect ratio:

- 16:9 (1920×1080, 2560×1440) — most common
- 16:10 (1920×1200) — some laptops
- 21:9 (3440×1440) — ultrawide

If Alice is 16:9 and Bob is 21:9, Bob sees more of the world horizontally. A normalized x of 0.5 (center for Alice) is still center for Bob, but a normalized x of 0.9 (far-right for Alice) is NOT where Bob's enemy is — Bob has more world to the right that Alice can't see.

For v1, document this limitation: aspect ratio mismatch causes ping drift. Recommend both players use the same aspect ratio for best results.

For v2: detect aspect ratio per client, send hints, render an indicator if the peer's ping is outside your viewport.

## Ping rendering

The v1.5 overlay renderer is plain TypeScript + DOM. No React, no Framer
Motion, no bundler — it's a single `client/src/overlay/overlay.ts` file
loaded via `<script type="module">` in `client/src/overlay/index.html`.
The renderer reacts to two IPC channels (`OVERLAY_SHOW_PING`,
`OVERLAY_CLEAR_PINGS`) and nothing else. v2 may revisit if marker
composition gets complex enough to justify a framework.

### Marker composition

Each ping is a 64×84 wrapper laid out vertically:

```
┌──────────────┐   ─┐
│              │    │
│   avatar     │    │ 64×64 avatar slot (the WHO)
│   64×64      │    │
│              │    │
└──────────────┘   ─┘
       │
       │ 4 px gap
       │
       ▼
      ╱╲              ─┐
     ╱  ╲              │ 24×16 chevron (the WHERE)
    ╱____╲            ─┘
       ▲
       └─── chevron tip lands exactly on the normalized ping coord
```

- Wrapper size: `WRAPPER_W = max(64, 24) = 64`, `WRAPPER_H = 64 + 4 + 16 = 84`.
- Avatar slot: 64×64. Filled via `<img src="data:image/png;base64,…">` when
  `OverlayShowPingPayload.avatarBase64` is non-null; left empty (chevron-only
  marker) when null. Bytes are inlined as a data URL — no network fetch, no
  worker thread.
- Avatar border color matches `payload.color` so the source of the ping is
  unambiguous even when avatars are missing.
- Chevron is a 24×16 SVG polygon, filled with `var(--ping-color)`. The tip is
  at the bottom-center (12, 16) in the default orientation.

### Edge flip

If a ping would render so the avatar slot extends above the viewport
(`tipY - WRAPPER_H < 0`), the marker flips: chevron on top, avatar below,
chevron tip at the top-center (12, 0) of its SVG. The flip keeps the avatar
visible no matter where on screen the ping lands.

There is no horizontal flip — `WRAPPER_W` is 64 and pings near the left/right
edges may visually clip if `tipX - 32 < 0` or `tipX + 32 > screenW`. That's
acceptable for v1.5; horizontal containment is a v2 polish item if it shows
up as a real problem.

### Animation

A single Web Animations API call drives the fade-out:

```typescript
const anim = el.animate([{ opacity: 1 }, { opacity: 0 }], {
  duration: payload.ttl,
  easing: 'ease-out',
  fill: 'forwards',
});
anim.onfinish = () => {
  el.remove();
  active.delete(payload.messageId);
};
```

No spring physics, no scale-in, no staggered child animations. The element is
appended at full opacity and fades to 0 over `ttl` ms (default 5000). On
finish, the element is removed and the dedup map drops the messageId.

### Dedup

The renderer maintains `active: Map<messageId, HTMLElement>`. If a `ping:drop`
arrives with a `messageId` already present, the spawn is a no-op. This guards
against any future server-side wire echo and is the load-bearing assumption
behind the sender's local-echo path: the main process echoes the ping locally
with the same `messageId` the wire envelope carries, so a stray wire echo
from a misconfigured server would still resolve to a single marker.

### Click-through

`pointerEvents: none` is set on the root `#root` element in the overlay's
HTML, not per-marker — the entire overlay accepts no DOM-level clicks. The
window-level `setIgnoreMouseEvents(true, { forward: true })` handles
OS-level click-through; the CSS rule is belt-and-suspenders.

## v5 directional tracking

Active pings can move on-screen and out of FOV when the player rotates the camera. The overlay receives `overlay:update-ping-position` IPC events on tracking-loop ticks carrying `{id, screenX, screenY, confidence, isEdgeArrow, arrowAngle?}`. The renderer's `requestAnimationFrame` tick interpolates between the most recent target and the previously-committed position so motion looks smooth at 60fps even when tracking work steps down under load.

Two visual states per tracked ping:

- **In-FOV** — the existing chevron+avatar marker repositions to the projected screen coordinate. CSS variable `--tracking-confidence` and inline `opacity` are driven by the ping's confidence so an uncertain bearing fades instead of snapping to a wrong location.
- **Off-FOV** — a separate `.edge-arrow` SVG (24×24 chevron) is appended as a sibling of the `.ping` node and rotated to point at the off-screen bearing. The normal marker's opacity is set to 0 while the arrow is visible. When the ping comes back on-screen the arrow's `display` flips to `none` (the node is preserved for reuse, not deleted). Implementation lives in `client/src/overlay/components/edge-arrow.ts` — exported `showEdgeArrow(...)` and `hideEdgeArrow(...)`.

The motion source is `client/src/main/tracking/` — raw mouse deltas for the immediate low-latency path, optical-flow-based camera-rotation estimation for bounded correction, calibration-derived pixels-per-degree, mouse-delta confidence cross-check, keyboard movement-state hints, and per-ping local surface locking. Keyboard movement does not synthesize fake camera deltas; it raises the local visual-lock cadence, limits no-mouse global optical yaw, and biases fusion toward observed local surface/template matches. The default local lock captures an approximately 500×500 screen-pixel context around each ping, masks the overlay marker itself, and verifies candidate corrections with ORB/homography when available plus shape, edge, texture, grayscale template, color-histogram agreement, and a lightweight patch-correlation fallback. Native ScreenCaptureKit tracking targets 540p; Electron fallback is capped at 480p/30fps so input hooks stay responsive if native capture exits. Surface locks are throttled separately from frame delivery, and the expensive KLT fallback is opt-in with `PYNG_ENABLE_SURFACE_KLT=1`. `dev:solo` defaults to hybrid-fast tracking: mouse movement owns responsiveness and visual flow only corrects recent mouse motion gently so it cannot yank the marker. Use `PYNG_SCREEN_ONLY_TRACKING=1` only as a diagnostic mode for mouse-input issues. If a machine struggles with the heavier lock, set `PYNG_DISABLE_SURFACE_LOCK=1` to use the lighter KCF path, `PYNG_DISABLE_VISUAL_PATCH=1` to disable the patch fallback, or `PYNG_FORCE_LEGACY_KCF=1` to force KCF even when surface locking is available.

**OpenCV binder note (2026-05-16)**: pyng currently loads native `@u4/opencv4nodejs` through `client/src/main/tracking/native-opencv.ts`. Tests under `tsx --test` exercise mocked-cv math and real-cv smoke coverage for the native path.

## Performance

The overlay renderer should be idle except when pings are active. Don't run animation loops continuously — only mount marker components when there are active pings.

Target: < 16ms render frame (60fps). With <10 simultaneous pings, this is trivial.

## Common pitfalls

- **Black background showing instead of transparent:** make sure body and html have `background: transparent` in the overlay's CSS
- **Window appears behind fullscreen Roblox:** use `setAlwaysOnTop(true, 'screen-saver')`, not just `alwaysOnTop: true`. On macOS, also ensure the overlay path has switched the app activation policy to `accessory` before creating the overlay window.
- **Clicks are blocked even when not in ping mode:** verify `setIgnoreMouseEvents(true, { forward: true })` was called after window creation
- **Pings drift when peer is at different resolution:** check viewport normalization is being applied; verify the game config's `viewportArea` is accurate
- **Window doesn't cover the full screen:** use `screen.getPrimaryDisplay().bounds`, not `workAreaSize` (which excludes taskbar)

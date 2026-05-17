import type { OverlayShowPingPayload, OverlayUpdatePingPositionPayload } from '@pyng/shared';
import {
  currentInterpolatedPosition,
  interpolate,
  interpolationWindowForCadence,
  interpolationWindowMs,
  type TrackingTarget,
} from './tracking-math.js';
import { showEdgeArrow, hideEdgeArrow } from './components/edge-arrow.js';

type ShowPingPayload = OverlayShowPingPayload;

// --- Tracking state (v4 #100) ---
// Populated by onUpdatePingPosition IPC handler. Consumed by the rAF tick.
// trackedPositions holds the *target* state emitted by the tracking loop
// (~15fps). lastPositions holds the last fully-interpolated state so the rAF
// tick can lerp smoothly between frames.
const trackedPositions = new Map<string, TrackingTarget>();
const lastPositions = new Map<string, { x: number; y: number; confidence: number }>();

const AVATAR_SIZE = 32;
const CHEVRON_W = 14;
const CHEVRON_H = 10;
const GAP = 3;
const WRAPPER_W = Math.max(AVATAR_SIZE, CHEVRON_W);
const WRAPPER_H = AVATAR_SIZE + GAP + CHEVRON_H;

const root = document.getElementById('root');
if (!root) throw new Error('overlay root missing');

// Internal state. Map of messageId -> rendered ping. We keep the original
// payload plus the spawn timestamp so the entire active set can be re-rendered
// as one innerHTML write on every change — necessary to keep the macOS
// transparent fullscreen compositor honoring dynamic content under #root.
type ActivePing = {
  payload: ShowPingPayload;
  spawnedAt: number;
  expiresAt: number;
};

const MAX_ACTIVE_PINGS = 5;
// When a marker has to be evicted early (FIFO overflow or explicit clear),
// shorten its remaining fade to this duration instead of yanking it from the
// DOM. Preserves the "every ping fades" invariant.
const FAST_FADE_MS = 200;

const active = new Map<string, ActivePing>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildChevronSvg(flipped: boolean, color: string): string {
  // Down-pointing pin shape: tip at (W/2, H), concave top edge between
  // (0,0) and (W,0), soft tangent corners where the top edge meets the
  // sides. Built from three bezier segments:
  //   - top:   cubic bezier (0,0) -> (W,0) with control points pulled DOWN
  //            into the shape -> concave top
  //   - right: quadratic from (W,0) to tip (W/2, H), control near (W, H/4)
  //            -> softens the top-right corner
  //   - left:  mirror of right, closes the path
  // The tip pixel is still exactly (W/2, H) (or (W/2, 0) when flipped) so
  // the JS WRAPPER_H math for cursor alignment is unchanged.
  const W = CHEVRON_W;
  const H = CHEVRON_H;
  const mid = W / 2;
  const topY = flipped ? H : 0;
  const tipY = flipped ? 0 : H;
  // Concavity depth: how far the top edge sags inward (toward the tip).
  // Sign flips with `flipped` since the top is below the tip in flipped mode.
  // H/5 keeps the dip gentle — strong enough to read as a pin's neck under
  // the avatar, soft enough not to look like a crescent.
  const concave = flipped ? -H / 5 : H / 5;
  // Corner softening control: pull the side quadratic's control point toward
  // the top corner so the side blends into the top instead of meeting it at
  // a hard angle. Control sits inside the shape near the corner, giving the
  // sides a subtle pin-like bulge near the top before they taper to the tip.
  const sideCtrlY = flipped ? H - H / 3 : H / 3;
  const path = [
    `M 0,${topY}`,
    `C ${W / 4},${topY + concave} ${(3 * W) / 4},${topY + concave} ${W},${topY}`,
    `Q ${W},${sideCtrlY} ${mid},${tipY}`,
    `Q 0,${sideCtrlY} 0,${topY}`,
    'Z',
  ].join(' ');
  return `<svg class="chevron" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="${escapeHtml(color)}" /></svg>`;
}

function buildAvatarSlotHtml(avatarBase64: string | null, color: string): string {
  if (avatarBase64 === null) {
    return '<div class="avatar-slot"></div>';
  }
  const src = `data:image/png;base64,${avatarBase64}`;
  return `<div class="avatar-slot"><img class="avatar-img" alt="" draggable="false" style="border-color:${escapeHtml(color)}" src="${escapeHtml(src)}"></div>`;
}

function buildPingHtml(entry: ActivePing): string {
  const p = entry.payload;
  const tipX = p.coords.x * window.innerWidth;
  const tipY = p.coords.y * window.innerHeight;
  const flipped = tipY - WRAPPER_H < 0;
  const top = flipped ? tipY : tipY - WRAPPER_H;
  const left = tipX - WRAPPER_W / 2;
  const ttl = entry.expiresAt - entry.spawnedAt;
  const avatarSlot = buildAvatarSlotHtml(p.avatarBase64, p.color);
  const chevron = buildChevronSvg(flipped, p.color);
  const inner = flipped ? chevron + avatarSlot : avatarSlot + chevron;
  // CSS animation `pyng-fade-out` defined in index.html drives the opacity
  // fade across the ttl. We don't redraw mid-life — innerHTML rewrites
  // mid-animation reset the compositor layer and the marker goes invisible
  // on macOS transparent fullscreen overlays.
  //
  // Each ping is wrapped in a .ping-container so the rAF tick can append
  // a .edge-arrow sibling without touching the .ping node itself.
  return `<div class="ping-container" data-message-id="${escapeHtml(p.messageId)}"><div class="ping" data-message-id="${escapeHtml(p.messageId)}" data-sender-session-id="${escapeHtml(p.senderSessionId)}" style="--ping-color:${escapeHtml(p.color)};--avatar-size:${AVATAR_SIZE}px;--gap-size:${GAP}px;width:${WRAPPER_W}px;left:${left}px;top:${top}px;animation:pyng-fade-out ${ttl}ms cubic-bezier(0.4,0,1,1) forwards">${inner}</div></div>`;
}

function rerender(): void {
  const html = Array.from(active.values()).map(buildPingHtml).join('');
  root!.innerHTML = html;
}

function scheduleCleanup(messageId: string, ms: number): void {
  const existing = cleanupTimers.get(messageId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    active.delete(messageId);
    cleanupTimers.delete(messageId);
    rerender();
  }, ms);
  cleanupTimers.set(messageId, timer);
}

// Restart the fade-out animation on an existing marker's DOM node with a
// shorter duration. Used for FIFO eviction and explicit clears so the
// "every ping fades" invariant holds — no instant DOM yanks. We mutate the
// node's inline `animation` style rather than re-rendering via innerHTML;
// re-render mid-life resets the compositor layer on macOS transparent
// fullscreen overlays (the same constraint that drives the
// rerender-only-on-spawn-and-expire pattern below).
function accelerateFadeFor(messageId: string, durationMs: number): void {
  const entry = active.get(messageId);
  if (!entry) return;
  entry.expiresAt = Date.now() + durationMs;
  const node = root!.querySelector<HTMLElement>(
    `.ping[data-message-id="${CSS.escape(messageId)}"]`,
  );
  if (node) {
    // Restart the CSS animation: null it out, force a reflow, then assign a
    // fresh one with the new duration. Without the reflow step the browser
    // would coalesce the two assignments and the animation would not restart.
    node.style.animation = 'none';
    void node.offsetWidth;
    node.style.animation = `pyng-fade-out ${durationMs}ms cubic-bezier(0.4,0,1,1) forwards`;
  }
  scheduleCleanup(messageId, durationMs);
}

function spawnPing(p: ShowPingPayload): void {
  if (active.has(p.messageId)) return;
  const spawnedAt = Date.now();
  const entry: ActivePing = {
    payload: p,
    spawnedAt,
    expiresAt: spawnedAt + p.ttl,
  };
  active.set(p.messageId, entry);

  // Schedule removal at full ttl. innerHTML is committed exactly once on
  // spawn and once on expire — no continuous redraw loop, because rapid
  // innerHTML writes prevent the macOS transparent fullscreen compositor
  // from ever committing a layer. Opacity fade is handled via CSS animation
  // on the .ping element (see index.html) so the marker fades to transparent
  // without us having to keep rewriting the DOM.
  scheduleCleanup(p.messageId, p.ttl);
  rerender();

  // FIFO cap: when the user spams the hotkey, accelerate the fade on any
  // entries beyond MAX_ACTIVE_PINGS instead of yanking them. Map iteration
  // order is insertion order, so the prefix is the oldest. Walk forward from
  // oldest and accelerate-fade each one whose current remaining lifetime
  // exceeds FAST_FADE_MS. The cleanup timer reschedules to FAST_FADE_MS.
  if (active.size > MAX_ACTIVE_PINGS) {
    const overflow = active.size - MAX_ACTIVE_PINGS;
    const ids = Array.from(active.keys()).slice(0, overflow);
    const now = Date.now();
    for (const id of ids) {
      const ent = active.get(id);
      if (!ent) continue;
      if (ent.expiresAt - now > FAST_FADE_MS) {
        accelerateFadeFor(id, FAST_FADE_MS);
      }
    }
  }
}

function clearAll(): void {
  // Same "no jarring pops" rule applies on explicit clear: accelerate every
  // active marker's fade-out rather than yanking the DOM in one innerHTML
  // wipe. The cleanup timers reschedule to FAST_FADE_MS and the next render
  // happens naturally when each marker's timer fires.
  for (const id of Array.from(active.keys())) {
    const ent = active.get(id);
    if (!ent) continue;
    if (ent.expiresAt - Date.now() > FAST_FADE_MS) {
      accelerateFadeFor(id, FAST_FADE_MS);
    }
  }
}

window.pyng.onShowPing(spawnPing);
window.pyng.onClearPings(clearAll);

// --- v4 #100: position update handler + rAF interpolation ---
//
// CRITICAL: we use TARGETED DOM MUTATIONS here, never innerHTML re-render.
// The rerender() path (full innerHTML replace) is safe on spawn/expire, but
// calling it at 15-60Hz would reset every CSS animation in flight and
// re-trigger the macOS transparent fullscreen compositor quirk that caused
// invisible markers in #41. The two paths coexist:
//   • spawnPing → rerender() once on arrival
//   • onUpdatePingPosition → targeted style.left / style.top / CSS-var mutations per tick
window.pyng.onUpdatePingPosition((payload: OverlayUpdatePingPositionPayload) => {
  const now = performance.now();
  const previousTarget = trackedPositions.get(payload.id);
  const interpWindowMs = interpolationWindowForCadence(
    previousTarget?.receivedAt ?? null,
    now,
    payload.predictionLeadMs ?? 0,
    payload.trackingMode,
    payload.trackingMethod,
  );
  if (previousTarget) {
    const previousLast = lastPositions.get(payload.id) ?? {
      x: previousTarget.targetX,
      y: previousTarget.targetY,
      confidence: previousTarget.targetConfidence,
    };
    lastPositions.set(payload.id, currentInterpolatedPosition(previousLast, previousTarget, now));
  } else {
    lastPositions.set(payload.id, {
      x: payload.screenX,
      y: payload.screenY,
      confidence: payload.confidence,
    });
  }

  trackedPositions.set(payload.id, {
    targetX: payload.screenX,
    targetY: payload.screenY,
    targetConfidence: payload.confidence,
    isEdgeArrow: payload.isEdgeArrow,
    arrowAngle: payload.arrowAngle,
    trackingState: payload.trackingState,
    uncertaintyPx: payload.uncertaintyPx,
    localConfidence: payload.localConfidence,
    globalConfidence: payload.globalConfidence,
    trackingMethod: payload.trackingMethod,
    surfaceConfidence: payload.surfaceConfidence,
    surfaceLockKind: payload.surfaceLockKind,
    receivedAt: now,
    interpWindowMs,
    sourceTimeNs: payload.sourceTimeNs,
    predictedAtNs: payload.predictedAtNs,
    predictionLeadMs: payload.predictionLeadMs,
    trackingMode: payload.trackingMode,
  });
});

// Remove stale tracking entries when a ping expires so the Maps don't grow.
// We piggyback on the cleanup timer by wrapping scheduleCleanup — but that
// function already exists, so instead we hook into the active.delete path
// indirectly: the rAF tick silently skips entries whose DOM node is gone,
// and we prune trackedPositions/lastPositions when the node is absent for
// two consecutive ticks. Simple approach: prune on each tick for any id not
// in active.
function pruneStaleTracking(): void {
  for (const id of trackedPositions.keys()) {
    if (!active.has(id)) {
      trackedPositions.delete(id);
      lastPositions.delete(id);
    }
  }
}

function trackingOpacityFor(id: string, confidence: number): number {
  const entry = active.get(id);
  if (!entry) return 0;
  const ttl = Math.max(1, entry.expiresAt - entry.spawnedAt);
  const remaining = Math.max(0, entry.expiresAt - Date.now());
  return Math.max(0, Math.min(1, confidence)) * Math.min(1, remaining / ttl);
}

// The rAF tick runs continuously while the overlay is open. It reads
// trackedPositions and mutates only the style of the relevant .ping node —
// never touching innerHTML. Missing nodes are silently skipped (race
// protection: update arrives before spawn completes).
function tick(): void {
  const now = performance.now();
  pruneStaleTracking();

  for (const [id, target] of trackedPositions.entries()) {
    const node = root!.querySelector<HTMLElement>(`.ping[data-message-id="${CSS.escape(id)}"]`);
    if (!node) continue; // ping not spawned yet or already expired — skip

    const last = lastPositions.get(id) ?? {
      x: target.targetX,
      y: target.targetY,
      confidence: target.targetConfidence,
    };
    const elapsed = now - target.receivedAt;
    const interpolated = interpolate(last, target, elapsed);
    const opacity = trackingOpacityFor(id, interpolated.confidence);

    if (target.isEdgeArrow) {
      const color = node.style.getPropertyValue('--ping-color') || '#ff3344';
      showEdgeArrow(node, interpolated.x, interpolated.y, target.arrowAngle ?? 0, opacity, color);
    } else {
      // interpolated.x/y is the CHEVRON TIP coordinate (matches what addPing
      // was called with). The .ping element's top-left must be offset so the
      // tip lands on the cursor — same math as buildPingHtml's spawn-time
      // positioning, otherwise tracking-update snaps the marker downward by
      // WRAPPER_H and rightward by WRAPPER_W/2 on the first 15fps tick.
      const flipped = interpolated.y - WRAPPER_H < 0;
      const left = interpolated.x - WRAPPER_W / 2;
      const top = flipped ? interpolated.y : interpolated.y - WRAPPER_H;
      node.style.visibility = 'visible';
      node.style.left = '0px';
      node.style.top = '0px';
      node.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      // Inline opacity wins over the CSS fade animation once tracking starts,
      // so carry the lifetime fade in JS while the marker is being repositioned.
      node.style.setProperty('--tracking-confidence', String(interpolated.confidence));
      node.style.setProperty('--uncertainty-px', `${target.uncertaintyPx ?? 0}px`);
      node.dataset.trackingState = target.trackingState ?? 'exact';
      node.dataset.flipped = String(flipped);

      // Hide edge arrow if it exists (ping moved back on-screen).
      hideEdgeArrow(node);
      node.style.opacity = String(opacity);
    }

    if (elapsed >= interpolationWindowMs(target)) {
      lastPositions.set(id, {
        x: target.targetX,
        y: target.targetY,
        confidence: target.targetConfidence,
      });
    }
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Ping-mode visual state: when hold-mode is active, body gains a class that
// switches the cursor to crosshair and adds a subtle accent tint so the user
// has feedback that pyng has captured input. Click handler emits the click
// coords back to main; main does the normalization + ping dispatch + exits
// ping-mode via OVERLAY_EXIT_PING_MODE.
const PING_MODE_CLASS = 'pyng-ping-mode';

function onOverlayClick(event: MouseEvent): void {
  if (!document.body.classList.contains(PING_MODE_CLASS)) return;
  event.preventDefault();
  event.stopPropagation();
  window.pyng.sendPingModeClick({
    pxX: event.clientX,
    pxY: event.clientY,
    screenW: window.innerWidth,
    screenH: window.innerHeight,
  });
}

window.addEventListener('click', onOverlayClick, true);

window.pyng.onEnterPingMode(() => {
  document.body.classList.add(PING_MODE_CLASS);
});
window.pyng.onExitPingMode(() => {
  document.body.classList.remove(PING_MODE_CLASS);
});

export {};

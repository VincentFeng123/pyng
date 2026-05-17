import {
  UiohookKey,
  uIOhook,
  type UiohookKeyboardEvent,
  type UiohookMouseEvent,
} from 'uiohook-napi';
import { MacRawMouseDeltaSource } from './macos-raw-mouse.js';

// Electron Accelerator → uiohook keycode mapping for the keys we actually care
// about. uiohook's `UiohookKey` enum has many entries; we map a curated subset
// that covers v2 defaults + likely user rebinds. Unknown tokens fall through
// to lookup-by-uppercase in the `UiohookKey` map.
const TOKEN_TO_KEYCODE: Readonly<Record<string, number>> = {
  Z: UiohookKey.Z,
  A: UiohookKey.A,
  B: UiohookKey.B,
  C: UiohookKey.C,
  D: UiohookKey.D,
  E: UiohookKey.E,
  F: UiohookKey.F,
  G: UiohookKey.G,
  H: UiohookKey.H,
  I: UiohookKey.I,
  J: UiohookKey.J,
  K: UiohookKey.K,
  L: UiohookKey.L,
  M: UiohookKey.M,
  N: UiohookKey.N,
  O: UiohookKey.O,
  P: UiohookKey.P,
  Q: UiohookKey.Q,
  R: UiohookKey.R,
  S: UiohookKey.S,
  T: UiohookKey.T,
  U: UiohookKey.U,
  V: UiohookKey.V,
  W: UiohookKey.W,
  X: UiohookKey.X,
  Y: UiohookKey.Y,
  SPACE: UiohookKey.Space,
};

export type HotkeyHandlers = {
  onHoldStart(): void;
  onHoldEnd(): void;
};

export type ParsedAccelerator = {
  keycode: number;
  requireCtrl: boolean;
  requireAlt: boolean;
  requireShift: boolean;
  requireMeta: boolean;
};

export type KeyboardMovementKey =
  | 'forward'
  | 'backward'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'sprint';

export type KeyboardMovementState = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  horizontalAxis: number;
  verticalAxis: number;
  activeKeyCount: number;
  active: boolean;
  eventTimeNs: number;
};

export class HotkeyParseError extends Error {
  constructor(accelerator: string, reason: string) {
    super(`cannot parse accelerator '${accelerator}': ${reason}`);
    this.name = 'HotkeyParseError';
  }
}

export function parseAccelerator(accelerator: string): ParsedAccelerator {
  const tokens = accelerator
    .trim()
    .split('+')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new HotkeyParseError(accelerator, 'empty');
  }
  let requireCtrl = false;
  let requireAlt = false;
  let requireShift = false;
  let requireMeta = false;
  let keyToken: string | null = null;
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') {
      requireCtrl = true;
    } else if (lower === 'alt' || lower === 'option') {
      requireAlt = true;
    } else if (lower === 'shift') {
      requireShift = true;
    } else if (lower === 'cmd' || lower === 'command' || lower === 'meta' || lower === 'super') {
      requireMeta = true;
    } else {
      if (keyToken !== null) {
        throw new HotkeyParseError(accelerator, `multiple key tokens (${keyToken}, ${tok})`);
      }
      keyToken = tok;
    }
  }
  if (keyToken === null) {
    throw new HotkeyParseError(accelerator, 'no key token');
  }
  const upper = keyToken.toUpperCase();
  const keycode = TOKEN_TO_KEYCODE[upper] ?? lookupUiohookKey(upper);
  if (keycode === null) {
    throw new HotkeyParseError(accelerator, `unknown key token '${keyToken}'`);
  }
  return { keycode, requireCtrl, requireAlt, requireShift, requireMeta };
}

function lookupUiohookKey(upper: string): number | null {
  // UiohookKey is `as const` so we have to widen for dynamic access.
  const table = UiohookKey as unknown as Record<string, number | undefined>;
  return table[upper] ?? null;
}

let started = false;
let activeRegistrations = 0;

function ensureStarted(): void {
  if (started) return;
  uIOhook.start();
  started = true;
}

function maybeStop(): void {
  if (activeRegistrations === 0 && started) {
    uIOhook.stop();
    started = false;
  }
}

export function registerHotkey(accelerator: string, handlers: HotkeyHandlers): () => void {
  const parsed = parseAccelerator(accelerator);
  let holdActive = false;

  const matches = (e: UiohookKeyboardEvent): boolean =>
    e.keycode === parsed.keycode &&
    e.ctrlKey === parsed.requireCtrl &&
    e.altKey === parsed.requireAlt &&
    e.shiftKey === parsed.requireShift &&
    e.metaKey === parsed.requireMeta;

  const onKeydown = (e: UiohookKeyboardEvent): void => {
    if (!matches(e)) return;
    if (holdActive) return; // debounce key-repeat
    holdActive = true;
    try {
      handlers.onHoldStart();
    } catch (err) {
      process.stderr.write(`[hotkey] onHoldStart threw: ${String(err)}\n`);
    }
  };
  const onKeyup = (e: UiohookKeyboardEvent): void => {
    if (!matches(e)) return;
    if (!holdActive) return;
    holdActive = false;
    try {
      handlers.onHoldEnd();
    } catch (err) {
      process.stderr.write(`[hotkey] onHoldEnd threw: ${String(err)}\n`);
    }
  };
  uIOhook.on('keydown', onKeydown);
  uIOhook.on('keyup', onKeyup);
  activeRegistrations++;
  ensureStarted();

  return () => {
    uIOhook.off('keydown', onKeydown);
    uIOhook.off('keyup', onKeyup);
    activeRegistrations = Math.max(0, activeRegistrations - 1);
    // If a hold is in progress at unregister, synthesize a hold-end so the
    // caller can leave ping-mode cleanly.
    if (holdActive) {
      holdActive = false;
      try {
        handlers.onHoldEnd();
      } catch {
        // ignore
      }
    }
    maybeStop();
  };
}

// Absolute cursor deltas fail in locked fullscreen games because the game can
// confine/recenter the cursor. On macOS, prefer a CGEventTap raw delta helper
// and keep uiohook's absolute mousemove path as fallback.
let lastMouseX: number | null = null;
let lastMouseY: number | null = null;
let lastRawMouseDeltaAt = 0;
let rawMouseSource: MacRawMouseDeltaSource | null = null;

const mouseDeltaListeners: Array<(dx: number, dy: number, eventTimeNs: number) => void> = [];
const RAW_MOUSE_SUPPRESSES_ABSOLUTE_MS = 250;

const MOVEMENT_KEYCODE_TO_KEY = new Map<number, KeyboardMovementKey>([
  [UiohookKey.W, 'forward'],
  [UiohookKey.ArrowUp, 'forward'],
  [UiohookKey.S, 'backward'],
  [UiohookKey.ArrowDown, 'backward'],
  [UiohookKey.A, 'left'],
  [UiohookKey.ArrowLeft, 'left'],
  [UiohookKey.D, 'right'],
  [UiohookKey.ArrowRight, 'right'],
  [UiohookKey.Space, 'jump'],
  [UiohookKey.C, 'crouch'],
  [UiohookKey.Ctrl, 'crouch'],
  [UiohookKey.CtrlRight, 'crouch'],
  [UiohookKey.Shift, 'sprint'],
  [UiohookKey.ShiftRight, 'sprint'],
]);

const keyboardMovementListeners: Array<(state: KeyboardMovementState) => void> = [];
const activeMovementKeycodes = new Set<number>();

function dispatchMouseDelta(dx: number, dy: number, eventTimeNs = monotonicNowNs()): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (dx === 0 && dy === 0) return;

  for (const cb of mouseDeltaListeners) {
    cb(dx, dy, eventTimeNs);
  }
}

function onRawMouseDelta(dx: number, dy: number, eventTimeNs: number): void {
  lastRawMouseDeltaAt = Date.now();
  dispatchMouseDelta(dx, dy, eventTimeNs);
}

function onAbsoluteMouseMove(e: UiohookMouseEvent): void {
  if (Date.now() - lastRawMouseDeltaAt <= RAW_MOUSE_SUPPRESSES_ABSOLUTE_MS) return;
  if (lastMouseX !== null && lastMouseY !== null) {
    const dx = e.x - lastMouseX;
    const dy = e.y - lastMouseY;
    dispatchMouseDelta(dx, dy);
  }
  lastMouseX = e.x;
  lastMouseY = e.y;
}

function movementStateFromKeycodes(
  activeKeycodes: ReadonlySet<number>,
  eventTimeNs = monotonicNowNs(),
): KeyboardMovementState {
  const activeKeys = new Set<KeyboardMovementKey>();
  for (const keycode of activeKeycodes) {
    const key = MOVEMENT_KEYCODE_TO_KEY.get(keycode);
    if (key !== undefined) activeKeys.add(key);
  }

  const forward = activeKeys.has('forward');
  const backward = activeKeys.has('backward');
  const left = activeKeys.has('left');
  const right = activeKeys.has('right');
  const jump = activeKeys.has('jump');
  const crouch = activeKeys.has('crouch');
  const sprint = activeKeys.has('sprint');
  const activeKeyCount = activeKeys.size;

  return {
    forward,
    backward,
    left,
    right,
    jump,
    crouch,
    sprint,
    horizontalAxis: (right ? 1 : 0) - (left ? 1 : 0),
    verticalAxis: (forward ? 1 : 0) - (backward ? 1 : 0),
    activeKeyCount,
    active: activeKeyCount > 0,
    eventTimeNs,
  };
}

function dispatchKeyboardMovement(eventTimeNs = monotonicNowNs()): void {
  if (keyboardMovementListeners.length === 0) return;
  const state = movementStateFromKeycodes(activeMovementKeycodes, eventTimeNs);
  for (const cb of keyboardMovementListeners) {
    cb(state);
  }
}

function onMovementKeydown(e: UiohookKeyboardEvent): void {
  if (!MOVEMENT_KEYCODE_TO_KEY.has(e.keycode)) return;
  if (activeMovementKeycodes.has(e.keycode)) return;
  activeMovementKeycodes.add(e.keycode);
  dispatchKeyboardMovement(monotonicNowNs());
}

function onMovementKeyup(e: UiohookKeyboardEvent): void {
  if (!MOVEMENT_KEYCODE_TO_KEY.has(e.keycode)) return;
  if (!activeMovementKeycodes.delete(e.keycode)) return;
  dispatchKeyboardMovement(monotonicNowNs());
}

function startRawMouseSourceIfAvailable(): void {
  if (process.platform !== 'darwin') return;
  if (process.env.PYNG_DISABLE_RAW_MOUSE === '1') return;
  rawMouseSource ??= new MacRawMouseDeltaSource();
  rawMouseSource.start(onRawMouseDelta, (reason) => {
    process.stderr.write(
      `[mouse] macOS raw mouse delta unavailable (${reason}); using absolute fallback\n`,
    );
  });
}

/**
 * Registers a callback that receives mouse movement deltas (dx, dy) from the
 * shared uIOhook instance. Returns an unregister function.
 *
 * Uses the existing uIOhook instance — no second instance is created.
 */
export function registerMouseDeltaListener(
  cb: (dx: number, dy: number, eventTimeNs: number) => void,
): () => void {
  if (mouseDeltaListeners.length === 0) {
    startRawMouseSourceIfAvailable();
    uIOhook.on('mousemove', onAbsoluteMouseMove);
    activeRegistrations++;
    ensureStarted();
  }
  mouseDeltaListeners.push(cb);

  return () => {
    const idx = mouseDeltaListeners.indexOf(cb);
    if (idx >= 0) mouseDeltaListeners.splice(idx, 1);
    if (mouseDeltaListeners.length === 0) {
      uIOhook.off('mousemove', onAbsoluteMouseMove);
      activeRegistrations = Math.max(0, activeRegistrations - 1);
      lastMouseX = null;
      lastMouseY = null;
      lastRawMouseDeltaAt = 0;
      rawMouseSource?.stop();
      maybeStop();
    }
  };
}

/**
 * Registers a callback for FPS movement-key state (WASD/arrow keys plus
 * jump/crouch/sprint). The callback receives a full current-state snapshot on
 * every movement-key transition.
 */
export function registerKeyboardMovementListener(
  cb: (state: KeyboardMovementState) => void,
): () => void {
  if (keyboardMovementListeners.length === 0) {
    uIOhook.on('keydown', onMovementKeydown);
    uIOhook.on('keyup', onMovementKeyup);
    activeRegistrations++;
    ensureStarted();
  }
  keyboardMovementListeners.push(cb);

  return () => {
    const idx = keyboardMovementListeners.indexOf(cb);
    if (idx >= 0) keyboardMovementListeners.splice(idx, 1);
    if (keyboardMovementListeners.length === 0) {
      uIOhook.off('keydown', onMovementKeydown);
      uIOhook.off('keyup', onMovementKeyup);
      activeMovementKeycodes.clear();
      activeRegistrations = Math.max(0, activeRegistrations - 1);
      maybeStop();
    }
  };
}

function monotonicNowNs(): number {
  return Number(process.hrtime.bigint());
}

// Test-only trigger path. Lets integration tests drive hold-start / hold-end
// without booting uiohook. Gated on NODE_ENV=test so production code cannot
// accidentally short-circuit the real hook.
type TestHandler = { handlers: HotkeyHandlers; holdActive: boolean };
const testHandlers: TestHandler[] = [];

export function _registerHotkeyForTest(handlers: HotkeyHandlers): () => void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_registerHotkeyForTest only callable when NODE_ENV=test');
  }
  const entry: TestHandler = { handlers, holdActive: false };
  testHandlers.push(entry);
  return () => {
    const idx = testHandlers.indexOf(entry);
    if (idx >= 0) testHandlers.splice(idx, 1);
  };
}

export function triggerForTest(kind: 'hold-start' | 'hold-end'): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('triggerForTest only callable when NODE_ENV=test');
  }
  for (const entry of [...testHandlers]) {
    if (kind === 'hold-start') {
      if (entry.holdActive) continue;
      entry.holdActive = true;
      entry.handlers.onHoldStart();
    } else {
      if (!entry.holdActive) continue;
      entry.holdActive = false;
      entry.handlers.onHoldEnd();
    }
  }
}

export function _movementStateForTest(
  activeKeycodes: number[],
  eventTimeNs = 0,
): KeyboardMovementState {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_movementStateForTest only callable when NODE_ENV=test');
  }
  return movementStateFromKeycodes(new Set(activeKeycodes), eventTimeNs);
}

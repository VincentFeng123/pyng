import ElectronStore from 'electron-store';
import type { ManualTrackingProfile, TrackingFps } from '@pyng/shared';

export type HotkeyAccelerator = string;
export type HotkeyMode = 'press' | 'hold';

export type HotkeyConfig = {
  accelerator: HotkeyAccelerator;
  mode: HotkeyMode;
};

export type SettingsSchema = {
  version: 6;
  avatar: {
    imageBase64: string;
    setAt: number;
  } | null;
  hotkey: HotkeyConfig;
  firstRunHintShown: boolean;
  robloxUsername: string;
  pingColor: string;
  calibrationData?: {
    pixelsPerDegree: number;
    mousePixelsPerDegree: number;
    calibratedAt: number;
  };
  tracking?: {
    fps: TrackingFps;
  };
  manualTrackingProfile?: ManualTrackingProfile;
};

// rough defaults; calibration recommended for accuracy
export const DEFAULT_PIXELS_PER_DEGREE = 8.0;
export const DEFAULT_MOUSE_PIXELS_PER_DEGREE = 8.0;
export const DEFAULT_MANUAL_PROFILE_DPI = 800;
export const DEFAULT_PING_COLOR = '#7c3aed';

export const MAX_AVATAR_BASE64_LENGTH = 64 * 1024;

const DEFAULT_HOTKEY: HotkeyConfig = {
  accelerator: 'P',
  mode: 'hold',
};

const SETTINGS_VERSION = 6;

const DEFAULTS: SettingsSchema = {
  version: SETTINGS_VERSION,
  avatar: null,
  hotkey: DEFAULT_HOTKEY,
  firstRunHintShown: false,
  robloxUsername: '',
  pingColor: DEFAULT_PING_COLOR,
  calibrationData: undefined,
  tracking: { fps: 'auto' },
  manualTrackingProfile: undefined,
};

export type SettingsStoreOptions = {
  cwd?: string;
  name?: string;
};

// Runs any pending schema migrations immediately after the store is created.
// conf's built-in migrations system interacts badly with user-defined `version`
// keys (its post-migrate write can overwrite migration work), so we do this
// manually: check the stored version and apply patches in sequence.
function applyMigrations(store: ElectronStore<SettingsSchema>): void {
  const storedVersion = store.get('version') as number;
  if (storedVersion < 2) {
    // 1 → 2: ensure robloxUsername exists
    if (typeof store.get('robloxUsername') !== 'string') {
      store.set('robloxUsername', '');
    }
    store.set('version', 2);
  }
  if ((store.get('version') as number) < 3) {
    // 2 → 3: calibrationData absent is fine (leave undefined); tracking defaults to auto
    if (!store.get('tracking')) {
      store.set('tracking', { fps: 'auto' });
    }
    store.set('version', 3);
  }
  if ((store.get('version') as number) < 4) {
    store.set('version', 4);
  }
  if ((store.get('version') as number) < 5) {
    migrateLegacyZHotkey(store);
    store.set('version', 5);
  }
  if ((store.get('version') as number) < 6) {
    store.set('pingColor', DEFAULT_PING_COLOR);
    store.set('version', SETTINGS_VERSION);
  }
}

function migrateLegacyZHotkey(store: ElectronStore<SettingsSchema>): void {
  const hotkey = store.get('hotkey');
  if (hotkey?.accelerator.toUpperCase() === 'Z') {
    store.set('hotkey', { ...hotkey, accelerator: DEFAULT_HOTKEY.accelerator });
  }
}

export function createSettingsStore(opts: SettingsStoreOptions = {}) {
  const store = new ElectronStore<SettingsSchema>({
    name: opts.name ?? 'pyng-settings',
    cwd: opts.cwd,
    defaults: DEFAULTS,
  });
  applyMigrations(store);
  return store;
}

let defaultStore: ElectronStore<SettingsSchema> | null = null;

function getDefaultStore(): ElectronStore<SettingsSchema> {
  if (!defaultStore) defaultStore = createSettingsStore();
  return defaultStore;
}

export function _resetDefaultStoreForTests(): void {
  defaultStore = null;
}

export function loadSettings(
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): SettingsSchema {
  return {
    version: store.get('version'),
    avatar: store.get('avatar'),
    hotkey: store.get('hotkey'),
    firstRunHintShown: store.get('firstRunHintShown'),
    robloxUsername: store.get('robloxUsername'),
    pingColor: getPingColor(store),
    calibrationData: store.get('calibrationData'),
    tracking: store.get('tracking'),
    manualTrackingProfile: store.get('manualTrackingProfile'),
  };
}

export function saveAvatar(
  imageBase64: string,
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): void {
  if (imageBase64.length >= MAX_AVATAR_BASE64_LENGTH) {
    throw new Error(
      `avatar base64 exceeds maximum length (${imageBase64.length} >= ${MAX_AVATAR_BASE64_LENGTH})`,
    );
  }
  store.set('avatar', { imageBase64, setAt: Date.now() });
}

export function clearAvatar(store: ElectronStore<SettingsSchema> = getDefaultStore()): void {
  store.set('avatar', null);
}

// Electron Accelerator format is a `+`-joined list of modifier + key tokens.
// We validate "non-empty, trimmed, no whitespace inside tokens"; the real
// check (whether globalShortcut accepts this combo) lives in the hotkey
// registration code. Persisting must not throw on a valid-format string that
// happens to conflict at register time — the rebind UI handles that error.
const ACCELERATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+]*$/;

export function saveHotkey(
  accelerator: HotkeyAccelerator,
  mode: HotkeyMode,
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): void {
  const trimmed = accelerator.trim();
  if (trimmed.length === 0) {
    throw new Error('hotkey accelerator must be non-empty');
  }
  if (!ACCELERATOR_PATTERN.test(trimmed)) {
    throw new Error(`hotkey accelerator format invalid: "${accelerator}"`);
  }
  if (mode !== 'press' && mode !== 'hold') {
    throw new Error(`hotkey mode must be 'press' or 'hold' (got '${mode}')`);
  }
  store.set('hotkey', { accelerator: trimmed, mode });
}

export function getHotkey(store: ElectronStore<SettingsSchema> = getDefaultStore()): HotkeyConfig {
  return store.get('hotkey');
}

export function setFirstRunHintShown(
  value: boolean,
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): void {
  store.set('firstRunHintShown', value);
}

export function getFirstRunHintShown(
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): boolean {
  return store.get('firstRunHintShown');
}

export function onSettingsChange(
  cb: (next: SettingsSchema) => void,
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): () => void {
  return store.onDidAnyChange(() => cb(loadSettings(store)));
}

const ROBLOX_USERNAME_PATTERN = /^[A-Za-z0-9_]{0,20}$/;

export function saveRobloxUsername(
  name: string,
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): void {
  if (!ROBLOX_USERNAME_PATTERN.test(name)) {
    throw new Error('Invalid Roblox username — use 0–20 chars of A–Z, 0–9, underscore.');
  }
  store.set('robloxUsername', name);
}

export function getRobloxUsername(
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): string {
  return store.get('robloxUsername');
}

export function savePingColor(
  color: string,
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): void {
  store.set('pingColor', normalizePingColor(color));
}

export function getPingColor(store: ElectronStore<SettingsSchema> = getDefaultStore()): string {
  const stored = store.get('pingColor');
  if (typeof stored === 'string') {
    try {
      return normalizePingColor(stored);
    } catch {
      return DEFAULT_PING_COLOR;
    }
  }
  return DEFAULT_PING_COLOR;
}

export function saveCalibrationData(
  data: { pixelsPerDegree: number; mousePixelsPerDegree: number; calibratedAt: number },
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): void {
  store.set('calibrationData', data);
}

export function getCalibrationData(
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): SettingsSchema['calibrationData'] | null {
  return store.get('calibrationData') ?? null;
}

export function saveTrackingFps(
  fps: TrackingFps,
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): void {
  if (!isTrackingFps(fps)) {
    throw new Error(`invalid tracking fps value: ${String(fps)}`);
  }
  store.set('tracking', { fps });
}

export function saveManualTrackingProfile(
  profile: {
    enabled: boolean;
    fovH: number | null;
    mouseDpi: number | null;
    inGameSensitivity: number | null;
  },
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): void {
  const next: ManualTrackingProfile = {
    enabled: Boolean(profile.enabled),
    fovH: normalizeNullableNumber(profile.fovH, 30, 140, 'manual tracking fov'),
    mouseDpi: normalizeNullableNumber(profile.mouseDpi, 100, 32_000, 'manual tracking dpi'),
    inGameSensitivity: normalizeNullableNumber(
      profile.inGameSensitivity,
      0.01,
      20,
      'manual tracking sensitivity',
    ),
    updatedAt: Date.now(),
  };
  store.set('manualTrackingProfile', next);
}

export function getManualTrackingProfile(
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): ManualTrackingProfile | null {
  return store.get('manualTrackingProfile') ?? null;
}

export function getManualHorizontalFov(
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): number | null {
  const profile = getManualTrackingProfile(store);
  if (!profile?.enabled) return null;
  return profile.fovH;
}

export function estimateManualMousePixelsPerDegree(
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): number | null {
  const profile = getManualTrackingProfile(store);
  if (!profile?.enabled) return null;
  if (profile.mouseDpi === null || profile.inGameSensitivity === null) return null;
  const effectiveDpi = profile.mouseDpi * profile.inGameSensitivity;
  if (!Number.isFinite(effectiveDpi) || effectiveDpi <= 0) return null;

  return clamp(
    (DEFAULT_MOUSE_PIXELS_PER_DEGREE * DEFAULT_MANUAL_PROFILE_DPI) / effectiveDpi,
    0.25,
    200,
  );
}

export function getTrackingFps(
  store: ElectronStore<SettingsSchema> = getDefaultStore(),
): TrackingFps {
  const fps = store.get('tracking')?.fps ?? 'auto';
  return isTrackingFps(fps) ? fps : 'auto';
}

function isTrackingFps(value: unknown): value is TrackingFps {
  return value === 'auto' || value === 10 || value === 15 || value === 30 || value === 60;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalizePingColor(value: string): string {
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    throw new Error('ping color must be a #RRGGBB hex value');
  }
  return trimmed.toLowerCase();
}

function normalizeNullableNumber(
  value: number | null,
  min: number,
  max: number,
  label: string,
): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export {
  COMMON_WORD_BLOCKLIST,
  type SoftValidationResult,
  validateRobloxUsernameSoft,
} from '@pyng/shared';

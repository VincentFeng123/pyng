export const IPC_CHANNELS = {
  OVERLAY_SHOW_PING: 'overlay:show-ping',
  OVERLAY_CLEAR_PINGS: 'overlay:clear-pings',
  SETTINGS_GET: 'settings:get',
  SETTINGS_PICK_AVATAR_FILE: 'settings:pick-avatar-file',
  SETTINGS_SAVE_AVATAR_FROM_FILE: 'settings:save-avatar-from-file',
  SETTINGS_CLEAR_AVATAR: 'settings:clear-avatar',
  SETTINGS_SAVE_HOTKEY: 'settings:save-hotkey',
  SETTINGS_SET_FIRST_RUN_HINT_SHOWN: 'settings:set-first-run-hint-shown',
  SETTINGS_CHANGED: 'settings:changed',
  CONFIG_GET: 'config:get',
  PAIR_REQUEST_GENERATE: 'pair:request-generate',
  PAIR_REQUEST_REDEEM: 'pair:request-redeem',
  PAIR_REQUEST_UNPAIR: 'pair:request-unpair',
  PAIR_DISMISS_LOST_HINT: 'pair:dismiss-lost-hint',
  PAIR_GET_STATE: 'pair:get-state',
  PAIR_STATE_CHANGED: 'pair:state-changed',
  INPUT_REBIND_HOTKEY: 'input:rebind-hotkey',
  INPUT_HOTKEY_REGISTRATION_ERROR: 'input:hotkey-registration-error',
  INPUT_CHECK_CONFLICT: 'input:check-conflict',
  OVERLAY_ENTER_PING_MODE: 'overlay:enter-ping-mode',
  OVERLAY_EXIT_PING_MODE: 'overlay:exit-ping-mode',
  OVERLAY_PING_MODE_CLICK: 'overlay:ping-mode-click',
  SETTINGS_SAVE_ROBLOX_USERNAME: 'settings:save-roblox-username',
  OVERLAY_UPDATE_PING_POSITION: 'overlay:update-ping-position',
  CALIBRATION_START: 'calibration:start',
  CALIBRATION_STOP: 'calibration:stop',
  CALIBRATION_RESULT: 'calibration:result',
  SETTINGS_SAVE_CALIBRATION_DATA: 'settings:save-calibration-data',
  SETTINGS_SAVE_TRACKING_FPS: 'settings:save-tracking-fps',
  SETTINGS_SAVE_MANUAL_TRACKING_PROFILE: 'settings:save-manual-tracking-profile',
  SETTINGS_SAVE_PING_COLOR: 'settings:save-ping-color',
  WINDOW_CLOSE: 'window:close',
  WINDOW_MINIMIZE: 'window:minimize',
} as const;

export type OverlayShowPingPayload = {
  coords: { x: number; y: number };
  color: string;
  ttl: number;
  messageId: string;
  receivedAt: number;
  senderSessionId: string;
  // Base64-encoded 64x64 PNG of the sender's avatar, or null if the sender
  // hasn't published one (or it arrived after this ping). The renderer is
  // responsible for showing an empty 64x64 slot when null.
  avatarBase64: string | null;
};

export type OverlayClearPingsPayload = Record<string, never>;

export type OverlayUpdatePingPositionPayload = {
  id: string;
  screenX: number;
  screenY: number;
  confidence: number;
  isEdgeArrow: boolean;
  arrowAngle?: number;
  trackingState?: 'exact' | 'uncertain' | 'directional' | 'lost';
  uncertaintyPx?: number;
  localConfidence?: number;
  globalConfidence?: number;
  trackingMethod?: 'homography' | 'shape' | 'template' | 'klt' | 'kcf' | 'prediction';
  surfaceConfidence?: number;
  surfaceLockKind?: 'circle' | 'plane' | 'template' | 'unknown';
  sourceTimeNs?: number;
  predictedAtNs?: number;
  predictionLeadMs?: number;
  trackingMode?: 'mouse' | 'keyboard' | 'optical' | 'frame';
};

export type IpcMainToOverlay = {
  [IPC_CHANNELS.OVERLAY_SHOW_PING]: OverlayShowPingPayload;
  [IPC_CHANNELS.OVERLAY_CLEAR_PINGS]: OverlayClearPingsPayload;
  [IPC_CHANNELS.OVERLAY_UPDATE_PING_POSITION]: OverlayUpdatePingPositionPayload;
};

export type SettingsAvatar = {
  imageBase64: string;
  setAt: number;
} | null;

export type SettingsHotkeyMode = 'press' | 'hold';

export type SettingsHotkey = {
  accelerator: string;
  mode: SettingsHotkeyMode;
};

export type TrackingFps = 'auto' | 10 | 15 | 30 | 60;

export type SettingsSnapshot = {
  version: 7;
  avatar: SettingsAvatar;
  hotkey: SettingsHotkey;
  firstRunHintShown: boolean;
  robloxUsername: string;
  pingColor: string;
  persistentPair?: {
    groupId: string;
    pairedAt: number;
  };
  calibrationData: {
    pixelsPerDegree: number;
    mousePixelsPerDegree: number;
    calibratedAt: number;
  } | null;
  tracking: { fps: TrackingFps };
  manualTrackingProfile: ManualTrackingProfile | null;
};

export type SettingsPickAvatarFileResult = {
  filePath: string;
} | null;

export type SettingsSaveAvatarFromFileResult = {
  imageBase64: string;
  byteLength: number;
};

export type SettingsClearAvatarResult = Record<string, never>;

export type SettingsSaveHotkeyPayload = {
  accelerator: string;
  mode: SettingsHotkeyMode;
};

export type SettingsSetFirstRunHintShownPayload = {
  value: boolean;
};

export type SettingsSaveRobloxUsernamePayload = { robloxUsername: string };

export type CalibrationResultPayload = {
  pixelsPerDegree: number;
  mousePixelsPerDegree: number;
  durationMs: number;
};

export type SettingsSaveCalibrationDataPayload = {
  pixelsPerDegree: number;
  mousePixelsPerDegree: number;
  calibratedAt: number;
};

export type SettingsSaveTrackingFpsPayload = {
  fps: TrackingFps;
};

export type SettingsSavePingColorPayload = {
  color: string;
};

export type ManualTrackingProfile = {
  enabled: boolean;
  fovH: number | null;
  mouseDpi: number | null;
  inGameSensitivity: number | null;
  updatedAt: number;
};

export type SettingsSaveManualTrackingProfilePayload = {
  enabled: boolean;
  fovH: number | null;
  mouseDpi: number | null;
  inGameSensitivity: number | null;
};

export type SettingsChangedPayload = SettingsSnapshot;

export type ClientConfigSnapshot = {
  relayUrl: string;
  isDev: boolean;
};

export type PairConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type PairStateUnpaired = { kind: 'unpaired'; error?: string };
export type PairStateGenerating = {
  kind: 'generating';
  code?: string;
  expiresAt?: number;
  sessionId?: string;
};
export type PairStateRedeeming = {
  kind: 'redeeming';
  code: string;
  sessionId?: string;
};
export type PairStatePaired = { kind: 'paired'; groupId: string; sessionId: string };

export type PairStateKind = 'unpaired' | 'generating' | 'redeeming' | 'paired';

export type PairStatePayload = {
  connection: PairConnectionState;
  pair: PairStateUnpaired | PairStateGenerating | PairStateRedeeming | PairStatePaired;
  // True when the user was previously paired and the connection dropped,
  // dropping them back to unpaired without an explicit unpair action. The
  // renderer surfaces a dismissible "pair lost — please re-pair" banner; the
  // hint clears when the user takes any pair action (generate/redeem) or
  // dismisses the banner.
  pairLostHint?: boolean;
  // Rolling-average WebSocket round-trip latency in ms. Computed client-side
  // from `ping:ack` envelopes the server sends back on each `ping:drop`.
  // null when not paired OR when paired but no ack has arrived yet (or all
  // tracked sends have aged out of the 30s window). The renderer hides the
  // display when null.
  latencyMs: number | null;
  spectatorState: 'idle' | 'spectating' | 'spectated' | null;
  peerRobloxUsername: string | null;
};

export type PairRequestRedeemPayload = {
  code: string;
};

export type InputRebindHotkeyPayload = {
  accelerator: string;
  mode: SettingsHotkeyMode;
};

export type InputHotkeyRegistrationErrorPayload = {
  accelerator: string;
  message: string;
};

export type InputCheckConflictPayload = {
  accelerator: string;
};

export type InputCheckConflictResult = {
  reserved: boolean;
  reason?: string;
};

export type OverlayEnterPingModePayload = Record<string, never>;
export type OverlayExitPingModePayload = Record<string, never>;

export type OverlayPingModeClickPayload = {
  // Click coords in overlay-window pixel space (event.clientX / clientY).
  pxX: number;
  pxY: number;
  // The overlay's reported inner dimensions at click time (window.innerWidth /
  // innerHeight). The main process normalizes to (x, y) ∈ [0, 1].
  screenW: number;
  screenH: number;
};

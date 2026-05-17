import type {
  CalibrationResultPayload,
  ClientConfigSnapshot,
  InputCheckConflictResult,
  OverlayClearPingsPayload,
  OverlayEnterPingModePayload,
  OverlayExitPingModePayload,
  OverlayPingModeClickPayload,
  OverlayShowPingPayload,
  OverlayUpdatePingPositionPayload,
  PairStatePayload,
  SettingsChangedPayload,
  SettingsHotkeyMode,
  SettingsPickAvatarFileResult,
  SettingsSaveAvatarFromFileResult,
  SettingsSaveCalibrationDataPayload,
  SettingsSnapshot,
  SettingsSaveManualTrackingProfilePayload,
  TrackingFps,
} from '@pyng/shared';

export type PyngSettingsApi = {
  getSettings: () => Promise<SettingsSnapshot>;
  pickAvatarFile: () => Promise<SettingsPickAvatarFileResult>;
  saveAvatarFromFile: (filePath: string) => Promise<SettingsSaveAvatarFromFileResult>;
  clearAvatar: () => Promise<void>;
  saveHotkey: (accelerator: string, mode: SettingsHotkeyMode) => Promise<void>;
  setFirstRunHintShown: (value: boolean) => Promise<void>;
  saveRobloxUsername: (name: string) => Promise<void>;
  savePingColor: (color: string) => Promise<void>;
  saveCalibrationData: (data: SettingsSaveCalibrationDataPayload) => Promise<void>;
  saveTrackingFps: (fps: TrackingFps) => Promise<void>;
  saveManualTrackingProfile: (profile: SettingsSaveManualTrackingProfilePayload) => Promise<void>;
  onSettingsChange: (cb: (s: SettingsChangedPayload) => void) => () => void;
};

export type PyngCalibrationApi = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onResult: (cb: (payload: CalibrationResultPayload) => void) => () => void;
};

export type PyngOverlayApi = {
  onShowPing: (cb: (payload: OverlayShowPingPayload) => void) => () => void;
  onClearPings: (cb: (payload: OverlayClearPingsPayload) => void) => () => void;
  onEnterPingMode: (cb: (payload: OverlayEnterPingModePayload) => void) => () => void;
  onExitPingMode: (cb: (payload: OverlayExitPingModePayload) => void) => () => void;
  sendPingModeClick: (payload: OverlayPingModeClickPayload) => void;
  onUpdatePingPosition: (cb: (payload: OverlayUpdatePingPositionPayload) => void) => () => void;
};

export type PyngPairApi = {
  getState: () => Promise<PairStatePayload>;
  requestGenerate: () => Promise<void>;
  requestRedeem: (code: string) => Promise<void>;
  requestUnpair: () => Promise<void>;
  dismissPairLostHint: () => Promise<void>;
  onStateChange: (cb: (state: PairStatePayload) => void) => () => void;
};

export type PyngConfigApi = {
  getConfig: () => Promise<ClientConfigSnapshot>;
};

export type PyngInputApi = {
  checkConflict: (accelerator: string) => Promise<InputCheckConflictResult>;
};

export type PyngWindowApi = {
  close: () => void;
  minimize: () => void;
};

declare global {
  interface Window {
    pyng: PyngOverlayApi & {
      pair: PyngPairApi;
      settings: PyngSettingsApi;
      calibration: PyngCalibrationApi;
      config: PyngConfigApi;
      input: PyngInputApi;
      window: PyngWindowApi;
    };
  }
}

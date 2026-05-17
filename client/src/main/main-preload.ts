import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type CalibrationResultPayload,
  type ClientConfigSnapshot,
  type InputCheckConflictPayload,
  type InputCheckConflictResult,
  type PairRequestRedeemPayload,
  type PairStatePayload,
  type SettingsChangedPayload,
  type SettingsHotkeyMode,
  type SettingsPickAvatarFileResult,
  type SettingsSaveAvatarFromFileResult,
  type SettingsSaveCalibrationDataPayload,
  type SettingsSaveHotkeyPayload,
  type SettingsSaveManualTrackingProfilePayload,
  type SettingsSavePingColorPayload,
  type SettingsSaveRobloxUsernamePayload,
  type SettingsSaveTrackingFpsPayload,
  type SettingsSetFirstRunHintShownPayload,
  type SettingsSnapshot,
} from '@pyng/shared';

type Unsubscribe = () => void;

const pairApi = {
  getState(): Promise<PairStatePayload> {
    return ipcRenderer.invoke(IPC_CHANNELS.PAIR_GET_STATE);
  },
  requestGenerate(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.PAIR_REQUEST_GENERATE).then(() => undefined);
  },
  requestRedeem(code: string): Promise<void> {
    const payload: PairRequestRedeemPayload = { code };
    return ipcRenderer.invoke(IPC_CHANNELS.PAIR_REQUEST_REDEEM, payload).then(() => undefined);
  },
  requestUnpair(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.PAIR_REQUEST_UNPAIR).then(() => undefined);
  },
  dismissPairLostHint(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.PAIR_DISMISS_LOST_HINT).then(() => undefined);
  },
  onStateChange(cb: (state: PairStatePayload) => void): Unsubscribe {
    const listener = (_event: IpcRendererEvent, payload: PairStatePayload): void => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.PAIR_STATE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PAIR_STATE_CHANGED, listener);
  },
};

const settingsApi = {
  getSettings(): Promise<SettingsSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET);
  },
  pickAvatarFile(): Promise<SettingsPickAvatarFileResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_PICK_AVATAR_FILE);
  },
  saveAvatarFromFile(filePath: string): Promise<SettingsSaveAvatarFromFileResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE_AVATAR_FROM_FILE, filePath);
  },
  clearAvatar(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_CLEAR_AVATAR).then(() => undefined);
  },
  saveHotkey(accelerator: string, mode: SettingsHotkeyMode): Promise<void> {
    const payload: SettingsSaveHotkeyPayload = { accelerator, mode };
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE_HOTKEY, payload).then(() => undefined);
  },
  setFirstRunHintShown(value: boolean): Promise<void> {
    const payload: SettingsSetFirstRunHintShownPayload = { value };
    return ipcRenderer
      .invoke(IPC_CHANNELS.SETTINGS_SET_FIRST_RUN_HINT_SHOWN, payload)
      .then(() => undefined);
  },
  saveRobloxUsername(name: string): Promise<void> {
    const payload: SettingsSaveRobloxUsernamePayload = { robloxUsername: name };
    return ipcRenderer
      .invoke(IPC_CHANNELS.SETTINGS_SAVE_ROBLOX_USERNAME, payload)
      .then(() => undefined);
  },
  savePingColor(color: string): Promise<void> {
    const payload: SettingsSavePingColorPayload = { color };
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE_PING_COLOR, payload).then(() => undefined);
  },
  saveCalibrationData(data: SettingsSaveCalibrationDataPayload): Promise<void> {
    return ipcRenderer
      .invoke(IPC_CHANNELS.SETTINGS_SAVE_CALIBRATION_DATA, data)
      .then(() => undefined);
  },
  saveTrackingFps(fps: SettingsSaveTrackingFpsPayload['fps']): Promise<void> {
    const payload: SettingsSaveTrackingFpsPayload = { fps };
    return ipcRenderer
      .invoke(IPC_CHANNELS.SETTINGS_SAVE_TRACKING_FPS, payload)
      .then(() => undefined);
  },
  saveManualTrackingProfile(profile: SettingsSaveManualTrackingProfilePayload): Promise<void> {
    return ipcRenderer
      .invoke(IPC_CHANNELS.SETTINGS_SAVE_MANUAL_TRACKING_PROFILE, profile)
      .then(() => undefined);
  },
  onSettingsChange(cb: (s: SettingsChangedPayload) => void): Unsubscribe {
    const listener = (_event: IpcRendererEvent, payload: SettingsChangedPayload): void =>
      cb(payload);
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, listener);
  },
};

const calibrationApi = {
  start(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.CALIBRATION_START).then(() => undefined);
  },
  stop(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.CALIBRATION_STOP).then(() => undefined);
  },
  onResult(cb: (payload: CalibrationResultPayload) => void): Unsubscribe {
    const sub = (_: IpcRendererEvent, p: CalibrationResultPayload): void => cb(p);
    ipcRenderer.on(IPC_CHANNELS.CALIBRATION_RESULT, sub);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CALIBRATION_RESULT, sub);
  },
};

const configApi = {
  getConfig(): Promise<ClientConfigSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET);
  },
};

const inputApi = {
  checkConflict(accelerator: string): Promise<InputCheckConflictResult> {
    const payload: InputCheckConflictPayload = { accelerator };
    return ipcRenderer.invoke(IPC_CHANNELS.INPUT_CHECK_CONFLICT, payload);
  },
};

const windowApi = {
  close(): void {
    ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE);
  },
  minimize(): void {
    ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE);
  },
};

contextBridge.exposeInMainWorld('pyng', {
  pair: pairApi,
  settings: settingsApi,
  calibration: calibrationApi,
  config: configApi,
  input: inputApi,
  window: windowApi,
});

export type PyngPairApi = typeof pairApi;
export type PyngSettingsApi = typeof settingsApi;
export type PyngCalibrationApi = typeof calibrationApi;
export type PyngConfigApi = typeof configApi;
export type PyngInputApi = typeof inputApi;
export type PyngWindowApi = typeof windowApi;

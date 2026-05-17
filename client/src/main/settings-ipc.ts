import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  type ClientConfigSnapshot,
  type InputCheckConflictPayload,
  type InputCheckConflictResult,
  type SettingsChangedPayload,
  type SettingsClearAvatarResult,
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
import { normalizeAvatarFromFile } from './avatarNormalize.js';
import { loadConfig } from './config.js';
import { isReservedAccelerator } from './input/conflict-check.js';
import {
  clearAvatar,
  loadSettings,
  onSettingsChange,
  saveAvatar,
  saveCalibrationData,
  saveHotkey,
  saveManualTrackingProfile,
  savePingColor,
  saveRobloxUsername,
  saveTrackingFps,
  setFirstRunHintShown,
} from './settings.js';

const IMAGE_FILE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }];

export function registerSettingsIpc(): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (): SettingsSnapshot => {
    const s = loadSettings();
    return {
      ...s,
      calibrationData: s.calibrationData ?? null,
      tracking: s.tracking ?? { fps: 'auto' },
      manualTrackingProfile: s.manualTrackingProfile ?? null,
    };
  });
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_GET));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_PICK_AVATAR_FILE,
    async (event): Promise<SettingsPickAvatarFileResult> => {
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = parent
        ? await dialog.showOpenDialog(parent, {
            title: 'Pick an avatar image',
            properties: ['openFile'],
            filters: IMAGE_FILE_FILTERS,
          })
        : await dialog.showOpenDialog({
            title: 'Pick an avatar image',
            properties: ['openFile'],
            filters: IMAGE_FILE_FILTERS,
          });
      if (result.canceled || result.filePaths.length === 0) return null;
      const filePath = result.filePaths[0];
      if (!filePath) return null;
      return { filePath };
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_PICK_AVATAR_FILE));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_AVATAR_FROM_FILE,
    async (_event, filePath: string): Promise<SettingsSaveAvatarFromFileResult> => {
      const normalized = await normalizeAvatarFromFile(filePath);
      saveAvatar(normalized.imageBase64);
      return { imageBase64: normalized.imageBase64, byteLength: normalized.byteLength };
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_SAVE_AVATAR_FROM_FILE));

  ipcMain.handle(IPC_CHANNELS.SETTINGS_CLEAR_AVATAR, (): SettingsClearAvatarResult => {
    clearAvatar();
    return {};
  });
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_CLEAR_AVATAR));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_HOTKEY,
    (_event, payload: SettingsSaveHotkeyPayload): void => {
      saveHotkey(payload.accelerator, payload.mode);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_SAVE_HOTKEY));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_ROBLOX_USERNAME,
    (_event, payload: SettingsSaveRobloxUsernamePayload): void => {
      saveRobloxUsername(payload.robloxUsername);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_SAVE_ROBLOX_USERNAME));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_PING_COLOR,
    (_event, payload: SettingsSavePingColorPayload): void => {
      savePingColor(payload.color);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_SAVE_PING_COLOR));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SET_FIRST_RUN_HINT_SHOWN,
    (_event, payload: SettingsSetFirstRunHintShownPayload): void => {
      setFirstRunHintShown(payload.value);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_SET_FIRST_RUN_HINT_SHOWN));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_CALIBRATION_DATA,
    (_event, p: SettingsSaveCalibrationDataPayload): void => {
      saveCalibrationData(p);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_SAVE_CALIBRATION_DATA));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_TRACKING_FPS,
    (_event, p: SettingsSaveTrackingFpsPayload): void => {
      saveTrackingFps(p.fps);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_SAVE_TRACKING_FPS));

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_MANUAL_TRACKING_PROFILE,
    (_event, p: SettingsSaveManualTrackingProfilePayload): void => {
      saveManualTrackingProfile(p);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.SETTINGS_SAVE_MANUAL_TRACKING_PROFILE));

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, (): ClientConfigSnapshot => loadConfig());
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET));

  ipcMain.handle(
    IPC_CHANNELS.INPUT_CHECK_CONFLICT,
    (_event, payload: InputCheckConflictPayload): InputCheckConflictResult => {
      return isReservedAccelerator(payload.accelerator);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.INPUT_CHECK_CONFLICT));

  const unsubChange = onSettingsChange((next) => {
    const payload: SettingsChangedPayload = {
      ...next,
      calibrationData: next.calibrationData ?? null,
      tracking: next.tracking ?? { fps: 'auto' },
      manualTrackingProfile: next.manualTrackingProfile ?? null,
    };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, payload);
    }
  });
  handlers.push(unsubChange);

  return () => {
    for (const h of handlers) h();
  };
}

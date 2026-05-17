import { dialog, shell, systemPreferences, type BrowserWindow } from 'electron';

const SCREEN_RECORDING_DEEP_LINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export type ScreenRecordingStatus = {
  granted: boolean;
};

// Passive check — does NOT prompt the user. macOS fires the system prompt
// automatically when desktopCapturer.getSources() is first called; we avoid
// triggering it here so we can show our own explanation dialog first. Returns
// granted=true on non-darwin so the rest of the code path stays uniform.
export function checkScreenRecordingPermission(): ScreenRecordingStatus {
  if (process.platform !== 'darwin') {
    return { granted: true };
  }
  const result = systemPreferences.getMediaAccessStatus('screen');
  return { granted: result === 'granted' };
}

export type PromptResult = 'open-settings' | 'dismiss';

// Shows a modal-ish dialog explaining why pyng needs Screen Recording permission
// and offering a deep-link to the right macOS settings pane. Caller decides
// whether to quit the app, keep running in degraded mode, etc.
export async function showScreenRecordingPrompt(
  parent?: BrowserWindow | null,
): Promise<PromptResult> {
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'pyng needs Screen Recording permission',
    message: "pyng needs Screen Recording permission to detect when you're spectating a teammate.",
    detail:
      'Open System Settings → Privacy & Security → Screen Recording, enable pyng (or your terminal app if running in dev), then restart pyng.',
    buttons: ['Open System Settings', 'Dismiss'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);
  if (result.response === 0) {
    void shell.openExternal(SCREEN_RECORDING_DEEP_LINK);
    return 'open-settings';
  }
  return 'dismiss';
}

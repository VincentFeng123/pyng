import { dialog, shell, systemPreferences, type BrowserWindow } from 'electron';

const ACCESSIBILITY_DEEP_LINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

export type AccessibilityStatus = {
  // True on non-darwin OR when macOS reports Accessibility is granted.
  // Hotkey registration via uiohook-napi will silently swallow events on
  // macOS if this is false, so callers should gate hotkey setup on it.
  granted: boolean;
};

// Passive check — does NOT prompt the user. macOS shows the system prompt
// when `isTrustedAccessibilityClient(true)` is called; we explicitly avoid
// that here so we can render our own explanation dialog first. Returns
// granted=true on non-darwin so the rest of the code path stays uniform.
export function checkAccessibilityPermission(): AccessibilityStatus {
  if (process.platform !== 'darwin') {
    return { granted: true };
  }
  const granted = systemPreferences.isTrustedAccessibilityClient(false);
  return { granted };
}

export type PromptResult = 'open-settings' | 'dismiss';

// Shows a modal-ish dialog explaining why pyng needs Accessibility permission
// and offering a deep-link to the right macOS settings pane. Caller decides
// whether to quit the app, keep running with a disabled hotkey, etc.
export async function showAccessibilityPrompt(
  parent?: BrowserWindow | null,
): Promise<PromptResult> {
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'pyng needs Accessibility permission',
    message: 'pyng needs Accessibility permission to register the global hotkey.',
    detail:
      'Open System Settings → Privacy & Security → Accessibility, enable pyng (or your terminal in dev), then restart pyng for the hotkey to work.',
    buttons: ['Open System Settings', 'Dismiss'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);
  if (result.response === 0) {
    void shell.openExternal(ACCESSIBILITY_DEEP_LINK);
    return 'open-settings';
  }
  return 'dismiss';
}

import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Asset lives in client/build/ (not client/src/) because it's a bundled
// resource, not source. The `Template` suffix tells Electron's NSStatusItem
// integration on macOS to invert the image to match light/dark menu bar
// automatically. On Windows the suffix is harmless; future v3 polish would
// ship a hand-tuned .ico at 16/32/48 multi-resolution for sharper rendering.
const TRAY_ICON_PATH = path.resolve(HERE, '..', '..', 'build', 'tray-iconTemplate.png');

export type TrayHandle = {
  tray: Tray;
  destroy: () => void;
};

export type TrayOptions = {
  tooltip?: string;
  beforeOpenDashboard?: () => void;
};

export function createTray(
  getDashboard: () => BrowserWindow | null,
  options: TrayOptions = {},
): TrayHandle {
  const image = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }

  const tray = new Tray(image);
  tray.setToolTip(options.tooltip ?? 'pyng');

  const openDashboard = (): void => {
    options.beforeOpenDashboard?.();
    const win = getDashboard();
    if (!win || win.isDestroyed()) {
      process.stdout.write('[tray] open requested but dashboard window is not available\n');
      return;
    }
    if (!win.isVisible()) win.show();
    win.focus();
  };

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Dashboard', click: openDashboard },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);

  // Left-click (macOS) / single-click (Windows) opens the dashboard.
  // Electron's `click` event fires on both platforms with this semantics.
  tray.on('click', openDashboard);

  return {
    tray,
    destroy: () => {
      tray.removeAllListeners('click');
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}

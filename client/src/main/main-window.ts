import { app, BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '@pyng/shared';
import { MAIN_HTML_PATH, MAIN_PRELOAD_PATH } from './overlay.js';

const MAIN_WIDTH = 560;
const MAIN_HEIGHT = 720;

let current: BrowserWindow | null = null;
let quitting = false;

app.on('before-quit', () => {
  quitting = true;
});

ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

export function createMainWindow(): BrowserWindow {
  if (current && !current.isDestroyed()) {
    current.show();
    current.focus();
    return current;
  }

  const win = new BrowserWindow({
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
    resizable: false,
    frame: false,
    transparent: true,
    ...(process.platform === 'darwin'
      ? {
          vibrancy: 'hud' as const,
          visualEffectState: 'active' as const,
        }
      : {}),
    hasShadow: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: true,
    title: 'pyng',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: MAIN_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.platform === 'darwin') {
    win.setVibrancy('hud');
  }

  win.setMenuBarVisibility(false);

  win.on('close', (event) => {
    if (quitting) return;
    if (current === win && !win.isDestroyed()) {
      event.preventDefault();
      win.hide();
    }
  });

  win
    .loadFile(MAIN_HTML_PATH)
    .then(() => {
      if (!win.isDestroyed()) win.show();
    })
    .catch((err: Error) => {
      if (win.isDestroyed()) return;
      process.stderr.write(`[main-window] loadFile failed: ${err.message}\n`);
    });

  current = win;
  return win;
}

export function showMainWindow(): void {
  if (!current || current.isDestroyed()) return;
  current.show();
  current.focus();
}

export function getMainWindow(): BrowserWindow | null {
  if (!current || current.isDestroyed()) return null;
  return current;
}

export function destroyMainWindow(): void {
  if (current && !current.isDestroyed()) {
    current.removeAllListeners('close');
    current.destroy();
  }
  current = null;
}

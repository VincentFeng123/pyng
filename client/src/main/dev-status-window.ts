import { app, BrowserWindow } from 'electron';

export type DevStatusDetails = {
  groupId: string;
  sessionId: string;
  serverUrl: string;
};

export function createDevStatusWindow(details: DevStatusDetails): BrowserWindow {
  if (process.platform === 'darwin') {
    app.dock?.show();
  }

  const win = new BrowserWindow({
    width: 380,
    height: 260,
    minWidth: 340,
    minHeight: 220,
    title: 'pyng dev peer',
    backgroundColor: '#101014',
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  win
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderHtml(details))}`)
    .then(() => {
      if (!win.isDestroyed()) win.show();
    })
    .catch((err: Error) => {
      if (win.isDestroyed()) return;
      process.stderr.write(`[dev-status] loadURL failed: ${err.message}\n`);
    });

  return win;
}

function renderHtml(details: DevStatusDetails): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'"
    />
    <title>pyng dev peer</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #101014;
        --panel: #18181d;
        --text: #f0f0f3;
        --muted: #9a9aa4;
        --line: #2b2b33;
        --ok: #2ca36c;
        --accent: #7c3aed;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        user-select: none;
      }
      main {
        display: grid;
        gap: 14px;
        padding: 22px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      h1 {
        margin: 0;
        font-size: 18px;
        line-height: 1.2;
      }
      .badge {
        border: 1px solid rgba(44, 163, 108, 0.45);
        border-radius: 999px;
        color: var(--ok);
        padding: 4px 9px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .panel {
        display: grid;
        gap: 9px;
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }
      .row {
        display: grid;
        grid-template-columns: 74px 1fr;
        gap: 10px;
        align-items: center;
        min-width: 0;
      }
      .label {
        color: var(--muted);
        font-size: 12px;
      }
      code {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        white-space: nowrap;
      }
      p {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      strong { color: var(--text); font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>pyng dev peer</h1>
        <span class="badge">overlay live</span>
      </header>
      <section class="panel">
        <div class="row">
          <span class="label">Relay</span>
          <code>${escapeHtml(details.serverUrl)}</code>
        </div>
        <div class="row">
          <span class="label">Group</span>
          <code>${escapeHtml(details.groupId)}</code>
        </div>
        <div class="row">
          <span class="label">Session</span>
          <code>${escapeHtml(details.sessionId)}</code>
        </div>
      </section>
      <p>Put your mouse where you want the marker, then focus the terminal and press <strong>p</strong>. Press <strong>c</strong> to clear or <strong>q</strong> to quit.</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

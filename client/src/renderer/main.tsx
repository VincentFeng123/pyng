import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faChevronDown,
  faMinus,
  faMoon,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type {
  ClientConfigSnapshot,
  ManualTrackingProfile,
  PairStatePayload,
  SettingsAvatar,
  SettingsHotkey,
  SettingsHotkeyMode,
  SettingsSaveManualTrackingProfilePayload,
  SettingsSnapshot,
  TrackingFps,
} from '@pyng/shared';
import { validateRobloxUsernameSoft } from '../../../shared/src/usernameValidation.js';
import { AvatarPicker } from './components/AvatarPicker.js';
import { Button } from './components/Button.js';
import { CalibrationModal } from './CalibrationModal.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { HotkeyRebind } from './components/HotkeyRebind.js';

const DEFAULT_HOTKEY: SettingsHotkey = { accelerator: 'P', mode: 'hold' };
const DEFAULT_PING_COLOR = '#7c3aed';
const TRACKING_SETTINGS_VISIBLE = false;
const PING_COLOR_SWATCHES = [
  '#7c3aed',
  '#2563eb',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#f43f5e',
  '#ffffff',
] as const;

type ActionState = 'idle' | 'generating' | 'redeeming' | 'unpairing';
type ActiveTab = 'pairing' | 'settings';
type DashboardTheme = 'light' | 'dark';
type ManualTrackingDraft = {
  enabled: boolean;
  fovH: string;
  mouseDpi: string;
  inGameSensitivity: string;
};
type HslColor = {
  hue: number;
  saturation: number;
  lightness: number;
};

const EMPTY_STATE: PairStatePayload = {
  connection: 'disconnected',
  pair: { kind: 'unpaired' },
  latencyMs: null,
  spectatorState: null,
  peerRobloxUsername: null,
};

function Dashboard(): JSX.Element {
  const [activeTab, setActiveTab] = useState<ActiveTab>('pairing');
  const [slideDirection, setSlideDirection] = useState<'left' | 'right'>('left');
  const [systemTheme, setSystemTheme] = useState<DashboardTheme>(getSystemTheme);
  const [themeOverride, setThemeOverride] = useState<DashboardTheme | null>(null);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return undefined;

    const handleChange = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange);
      return () => media.removeEventListener('change', handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      window.pyng.window.close();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const theme = themeOverride ?? systemTheme;
  const nextTheme = theme === 'light' ? 'dark' : 'light';
  const selectTab = useCallback(
    (nextTab: ActiveTab) => {
      if (nextTab === activeTab) return;
      setSlideDirection(nextTab === 'settings' ? 'left' : 'right');
      setActiveTab(nextTab);
    },
    [activeTab],
  );

  return (
    <div className="app dashboard" data-theme={theme}>
      <header className="window-chrome">
        <div className="brand-lockup" aria-label="pyng dashboard">
          <span className="brand-name">pyng</span>
        </div>
        <nav
          className="tabs"
          role="tablist"
          aria-label="Dashboard sections"
          data-active={activeTab}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'pairing'}
            className={`tab ${activeTab === 'pairing' ? 'active' : ''}`}
            onClick={() => selectTab('pairing')}
          >
            Pairing
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'settings'}
            className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => selectTab('settings')}
          >
            Settings
          </button>
        </nav>
        <div className="window-controls">
          <button
            type="button"
            className="window-control theme-toggle"
            onClick={() => setThemeOverride(nextTheme)}
            aria-label={`Switch to ${nextTheme} mode`}
            title={`Switch to ${nextTheme} mode`}
          >
            {nextTheme === 'dark' ? (
              <FontAwesomeIcon icon={faMoon} className="theme-toggle-icon dark-icon" />
            ) : (
              <SunDotsIcon />
            )}
          </button>
          <button
            type="button"
            className="window-control minimize"
            onClick={() => window.pyng.window.minimize()}
            aria-label="Minimize"
            title="Minimize"
          >
            <FontAwesomeIcon icon={faMinus} />
          </button>
          <button
            type="button"
            className="window-control close"
            onClick={() => window.pyng.window.close()}
            aria-label="Close"
            title="Close"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </header>
      <div className={`tab-content slide-${slideDirection}`}>
        <div key={activeTab} className="tab-panel">
          {activeTab === 'pairing' ? <PairingTab /> : <SettingsTab />}
        </div>
      </div>
    </div>
  );
}

function getSystemTheme(): DashboardTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function SunDotsIcon(): JSX.Element {
  return (
    <span className="theme-sun-dots" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} />
      ))}
    </span>
  );
}

function PairingTab(): JSX.Element {
  const [state, setState] = useState<PairStatePayload>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState('');
  const [action, setAction] = useState<ActionState>('idle');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.pyng.pair
      .getState()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLocalError(errorMessage(err));
        setLoaded(true);
      });

    const unsub = window.pyng.pair.onStateChange((next) => {
      setState(next);
      if (next.pair.kind !== 'unpaired' || !next.pair.error) {
        setLocalError(null);
      }
      if (next.pair.kind === 'paired' || next.pair.kind === 'unpaired') {
        setAction('idle');
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const pairCode = state.pair.kind === 'generating' ? state.pair.code : undefined;
  const expiresAt = state.pair.kind === 'generating' ? state.pair.expiresAt : undefined;
  const canPair = state.connection === 'connected' && state.pair.kind === 'unpaired';
  const normalizedCode = useMemo(() => normalizeCode(code), [code]);
  const error = localError ?? (state.pair.kind === 'unpaired' ? state.pair.error : undefined);

  const handleGenerate = useCallback(() => {
    if (!canPair || action !== 'idle') return;
    setAction('generating');
    setLocalError(null);
    window.pyng.pair.requestGenerate().catch((err: unknown) => {
      setAction('idle');
      setLocalError(errorMessage(err));
    });
  }, [action, canPair]);

  const handleRedeem = useCallback(() => {
    if (!canPair || action !== 'idle' || normalizedCode.length !== 6) return;
    setAction('redeeming');
    setLocalError(null);
    window.pyng.pair.requestRedeem(normalizedCode).catch((err: unknown) => {
      setAction('idle');
      setLocalError(errorMessage(err));
    });
  }, [action, canPair, normalizedCode]);

  const handleUnpair = useCallback(() => {
    if (action !== 'idle') return;
    setAction('unpairing');
    setLocalError(null);
    window.pyng.pair.requestUnpair().catch((err: unknown) => {
      setAction('idle');
      setLocalError(errorMessage(err));
    });
  }, [action]);

  const handleDismissPairLost = useCallback(() => {
    window.pyng.pair.dismissPairLostHint().catch(() => {
      // Best-effort — the banner is purely cosmetic. If the IPC fails (which
      // would only happen if main is mid-shutdown), the next state broadcast
      // will overwrite our local state anyway.
    });
  }, []);

  return (
    <div className="main-app">
      <header className="main-header">
        <div>
          <h1>pyng</h1>
          <p className="subtitle">Pair with a teammate and route pings through the relay.</p>
        </div>
        <ConnectionBadge connection={state.connection} loaded={loaded} />
      </header>

      {state.pairLostHint && state.pair.kind === 'unpaired' && (
        <div className="banner pair-lost-banner" role="status">
          <span>Connection dropped — please re-pair.</span>
          <button
            type="button"
            className="banner-dismiss"
            onClick={handleDismissPairLost}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <section className="section status-panel">
        <div className="status-line">
          <span className={`status-dot ${state.pair.kind}`} />
          <div>
            <h2 className="section-title">{statusTitle(state)}</h2>
            <p className="section-help">{statusDetail(state, expiresAt)}</p>
          </div>
        </div>

        {state.pair.kind === 'paired' && (
          <div className="pair-details">
            <span>Group</span>
            <code>{shortId(state.pair.groupId)}</code>
            <span>Session</span>
            <code>{shortId(state.pair.sessionId)}</code>
            {state.latencyMs !== null && (
              <>
                <span>Latency</span>
                <code
                  className={`latency latency-${latencyTier(state.latencyMs)}`}
                  aria-label={`round-trip latency ${state.latencyMs} milliseconds`}
                >
                  {formatLatency(state.latencyMs)}
                </code>
              </>
            )}
          </div>
        )}

        {error && <div className="status error">{error}</div>}
      </section>

      {state.pair.kind === 'generating' ? (
        <section className="section code-panel">
          <h2 className="section-title">Share This Code</h2>
          <div className="pair-code" aria-label="pairing code">
            {formatPairCode(pairCode)}
          </div>
          <div className="button-row">
            <Button variant="danger" onClick={handleUnpair} disabled={action === 'unpairing'}>
              Cancel
            </Button>
          </div>
        </section>
      ) : state.pair.kind === 'paired' ? (
        <section className="section">
          <h2 className="section-title">Overlay Ready</h2>
          <p className="section-help">
            Incoming peer pings will appear on the transparent overlay window.
          </p>
          <div className={`spectator-status ${state.spectatorState ?? 'idle'}`} role="status">
            {renderSpectatorStatusText(state.spectatorState)}
          </div>
          {state.peerRobloxUsername === null && (
            <div className="banner nudge-banner">
              Set your Roblox username in Settings to enable ping-mode detection.
            </div>
          )}
          <div className="button-row">
            <Button variant="danger" onClick={handleUnpair} disabled={action === 'unpairing'}>
              Unpair
            </Button>
          </div>
        </section>
      ) : (
        <section className="section pair-actions">
          <div className="pair-action">
            <h2 className="section-title">Generate</h2>
            <p className="section-help">Create a one-time pairing code for your teammate.</p>
            <Button
              variant="primary"
              onClick={handleGenerate}
              disabled={!canPair || action !== 'idle'}
            >
              Generate code
            </Button>
          </div>

          <div className="pair-action">
            <h2 className="section-title">Redeem</h2>
            <p className="section-help">Enter the code from your teammate.</p>
            <input
              className="code-input"
              value={code}
              onChange={(event) => setCode(normalizeCode(event.currentTarget.value))}
              placeholder="K7M2P9"
              maxLength={6}
              inputMode="text"
              autoCapitalize="characters"
              disabled={!canPair || action !== 'idle'}
              aria-label="Pairing code"
            />
            <Button
              variant="primary"
              onClick={handleRedeem}
              disabled={!canPair || action !== 'idle' || normalizedCode.length !== 6}
            >
              Pair
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

type SettingsStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string };

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; clearAfter: number }
  | { kind: 'error'; message: string };

function SettingsTab(): JSX.Element {
  const [avatar, setAvatar] = useState<SettingsAvatar>(null);
  const [hotkey, setHotkey] = useState<SettingsHotkey | null>(null);
  const [config, setConfig] = useState<ClientConfigSnapshot | null>(null);
  const [pairedNow, setPairedNow] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<SettingsStatus>({ kind: 'idle' });

  const [savedRobloxUsername, setSavedRobloxUsername] = useState('');
  const [localRobloxUsername, setLocalRobloxUsername] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [pingColor, setPingColor] = useState(DEFAULT_PING_COLOR);
  const [pingColorStatus, setPingColorStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [colorEditorOpen, setColorEditorOpen] = useState(false);
  const [customColor, setCustomColor] = useState<HslColor>(() => hexToHsl(DEFAULT_PING_COLOR));
  const [customColorHex, setCustomColorHex] = useState(DEFAULT_PING_COLOR.toUpperCase());
  const [customColorError, setCustomColorError] = useState<string | null>(null);

  const [calibrationData, setCalibrationData] = useState<SettingsSnapshot['calibrationData']>(null);
  const [trackingFps, setTrackingFps] = useState<TrackingFps>('auto');
  const [manualTrackingDraft, setManualTrackingDraft] = useState<ManualTrackingDraft>(
    manualProfileToDraft(null),
  );
  const [trackingSelectOpen, setTrackingSelectOpen] = useState(false);
  const [manualTrackingSavedAt, setManualTrackingSavedAt] = useState<number | null>(null);
  const [manualTrackingStatus, setManualTrackingStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [calibrationModalOpen, setCalibrationModalOpen] = useState(false);
  const [calibrationSavedSnack, setCalibrationSavedSnack] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.pyng.settings.getSettings(),
      window.pyng.config.getConfig(),
      window.pyng.pair.getState(),
    ])
      .then(([s, c, p]) => {
        if (cancelled) return;
        setAvatar(s.avatar);
        setHotkey(s.hotkey);
        setSavedRobloxUsername(s.robloxUsername);
        setLocalRobloxUsername(s.robloxUsername);
        setPingColor(s.pingColor);
        setCalibrationData(s.calibrationData);
        setTrackingFps(s.tracking.fps);
        setManualTrackingDraft(manualProfileToDraft(s.manualTrackingProfile));
        setManualTrackingSavedAt(s.manualTrackingProfile?.updatedAt ?? null);
        setConfig(c);
        setPairedNow(p.pair.kind === 'paired');
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus({ kind: 'error', message: errorMessage(err) });
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsub = window.pyng.settings.onSettingsChange((next) => {
      setAvatar(next.avatar);
      setHotkey(next.hotkey);
      setSavedRobloxUsername(next.robloxUsername);
      setPingColor(next.pingColor);
      setCalibrationData(next.calibrationData);
      setTrackingFps(next.tracking.fps);
      setManualTrackingDraft(manualProfileToDraft(next.manualTrackingProfile));
      setManualTrackingSavedAt(next.manualTrackingProfile?.updatedAt ?? null);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.pyng.pair.onStateChange((next) => {
      setPairedNow(next.pair.kind === 'paired');
    });
    return unsub;
  }, []);

  const handleSaveRobloxUsername = useCallback(() => {
    setSaveStatus({ kind: 'saving' });
    window.pyng.settings
      .saveRobloxUsername(localRobloxUsername)
      .then(() => {
        setSavedRobloxUsername(localRobloxUsername);
        setSaveStatus({ kind: 'saved', clearAfter: Date.now() + 2000 });
      })
      .catch((err: unknown) => {
        setSaveStatus({ kind: 'error', message: errorMessage(err) });
      });
  }, [localRobloxUsername]);

  useEffect(() => {
    if (saveStatus.kind !== 'saved') return;
    const remaining = saveStatus.clearAfter - Date.now();
    const id = setTimeout(() => setSaveStatus({ kind: 'idle' }), Math.max(0, remaining));
    return () => clearTimeout(id);
  }, [saveStatus]);

  const handlePingColorChange = useCallback((color: string) => {
    setPingColor(color);
    setPingColorStatus({ kind: 'saving' });
    window.pyng.settings
      .savePingColor(color)
      .then(() => {
        setPingColorStatus({ kind: 'saved', clearAfter: Date.now() + 1400 });
      })
      .catch((err: unknown) => {
        setPingColorStatus({ kind: 'error', message: errorMessage(err) });
      });
  }, []);

  useEffect(() => {
    if (colorEditorOpen) return;
    setCustomColor(hexToHsl(pingColor));
    setCustomColorHex(pingColor.toUpperCase());
    setCustomColorError(null);
  }, [colorEditorOpen, pingColor]);

  const customColorPreview = useMemo(
    () => hslToHex(customColor.hue, customColor.saturation, customColor.lightness),
    [customColor],
  );

  const toggleCustomColorEditor = useCallback(() => {
    setColorEditorOpen((open) => {
      if (!open) {
        const next = hexToHsl(pingColor);
        setCustomColor(next);
        setCustomColorHex(pingColor.toUpperCase());
        setCustomColorError(null);
      }
      return !open;
    });
  }, [pingColor]);

  const updateCustomColor = useCallback((patch: Partial<HslColor>) => {
    setCustomColor((current) => {
      const next = {
        hue: clampNumber(patch.hue ?? current.hue, 0, 360),
        saturation: clampNumber(patch.saturation ?? current.saturation, 0, 100),
        lightness: clampNumber(patch.lightness ?? current.lightness, 0, 100),
      };
      setCustomColorHex(hslToHex(next.hue, next.saturation, next.lightness).toUpperCase());
      setCustomColorError(null);
      return next;
    });
  }, []);

  const handleCustomHexChange = useCallback((value: string) => {
    const upper = value.trim().toUpperCase();
    setCustomColorHex(upper);
    const normalized = normalizeHexColorInput(upper);
    if (normalized) {
      setCustomColor(hexToHsl(normalized));
      setCustomColorHex(normalized.toUpperCase());
      setCustomColorError(null);
      return;
    }
    setCustomColorError(upper.length >= 6 ? 'Use #RRGGBB' : null);
  }, []);

  const applyCustomColor = useCallback(() => {
    const normalized = normalizeHexColorInput(customColorHex);
    if (!normalized) {
      setCustomColorError('Use #RRGGBB');
      return;
    }
    handlePingColorChange(normalized);
    setColorEditorOpen(false);
  }, [customColorHex, handlePingColorChange]);

  useEffect(() => {
    if (pingColorStatus.kind !== 'saved') return;
    const remaining = pingColorStatus.clearAfter - Date.now();
    const id = setTimeout(() => setPingColorStatus({ kind: 'idle' }), Math.max(0, remaining));
    return () => clearTimeout(id);
  }, [pingColorStatus]);

  const handlePick = useCallback(async () => {
    setStatus({ kind: 'busy', message: 'Opening file picker…' });
    try {
      const picked = await window.pyng.settings.pickAvatarFile();
      if (!picked) {
        setStatus({ kind: 'idle' });
        return;
      }
      setStatus({ kind: 'busy', message: 'Normalizing…' });
      const result = await window.pyng.settings.saveAvatarFromFile(picked.filePath);
      setAvatar({ imageBase64: result.imageBase64, setAt: Date.now() });
      setStatus({ kind: 'idle' });
    } catch (err) {
      setStatus({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  const handleClear = useCallback(async () => {
    setStatus({ kind: 'busy', message: 'Clearing…' });
    try {
      await window.pyng.settings.clearAvatar();
      setAvatar(null);
      setStatus({ kind: 'idle' });
    } catch (err) {
      setStatus({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  const handleRebind = useCallback(
    async (accelerator: string, mode: SettingsHotkeyMode): Promise<void> => {
      await window.pyng.settings.saveHotkey(accelerator, mode);
    },
    [],
  );

  const handleResetHotkey = useCallback(async (): Promise<void> => {
    await window.pyng.settings.saveHotkey(DEFAULT_HOTKEY.accelerator, DEFAULT_HOTKEY.mode);
  }, []);

  useEffect(() => {
    if (!calibrationSavedSnack) return;
    const id = setTimeout(() => setCalibrationSavedSnack(false), 2000);
    return () => clearTimeout(id);
  }, [calibrationSavedSnack]);

  const handleTrackingFpsChange = useCallback((fps: TrackingFps) => {
    setTrackingFps(fps);
    window.pyng.settings.saveTrackingFps(fps).catch(() => {});
  }, []);

  const handleManualTrackingSave = useCallback(() => {
    let payload: SettingsSaveManualTrackingProfilePayload;
    try {
      payload = manualDraftToPayload(manualTrackingDraft);
    } catch (err) {
      setManualTrackingStatus({ kind: 'error', message: errorMessage(err) });
      return;
    }

    setManualTrackingStatus({ kind: 'saving' });
    window.pyng.settings
      .saveManualTrackingProfile(payload)
      .then(() => {
        setManualTrackingStatus({ kind: 'saved', clearAfter: Date.now() + 2000 });
      })
      .catch((err: unknown) => {
        setManualTrackingStatus({ kind: 'error', message: errorMessage(err) });
      });
  }, [manualTrackingDraft]);

  useEffect(() => {
    if (manualTrackingStatus.kind !== 'saved') return;
    const remaining = manualTrackingStatus.clearAfter - Date.now();
    const id = setTimeout(() => setManualTrackingStatus({ kind: 'idle' }), Math.max(0, remaining));
    return () => clearTimeout(id);
  }, [manualTrackingStatus]);

  const updateManualTrackingDraft = useCallback((patch: Partial<ManualTrackingDraft>) => {
    setManualTrackingDraft((current) => ({ ...current, ...patch }));
  }, []);

  return (
    <div className="main-app">
      <header className="main-header">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Avatar shown above your pings, hotkey, and relay endpoint.</p>
        </div>
      </header>

      <section className="section avatar-section">
        <h2 className="section-title">Avatar</h2>
        <p className="section-help">
          Cropped and resized to 64×64. PNG, JPG, JPEG, or BMP up to 1 MB.
        </p>
        <AvatarPicker
          avatar={avatar}
          loaded={loaded}
          busy={status.kind === 'busy'}
          onPick={handlePick}
          onClear={handleClear}
        />
        <div className={`status${status.kind === 'error' ? ' error' : ''}`}>
          {status.kind === 'busy' && status.message}
          {status.kind === 'error' && `Error: ${status.message}`}
        </div>
      </section>

      <section className="section username-section">
        <div className="section-header">
          <h2 className="section-title">Roblox Username</h2>
          <Button
            variant="primary"
            className="section-action"
            onClick={handleSaveRobloxUsername}
            disabled={localRobloxUsername === savedRobloxUsername || saveStatus.kind === 'saving'}
          >
            Add
          </Button>
        </div>
        <input
          type="text"
          className="username-input pill-input"
          value={localRobloxUsername}
          onChange={(e) => setLocalRobloxUsername(e.currentTarget.value)}
          placeholder="YourRobloxName"
          maxLength={20}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {saveStatus.kind === 'saving' && <p className="status">Saving…</p>}
        {saveStatus.kind === 'saved' && <p className="status">Saved</p>}
        {saveStatus.kind === 'error' && <p className="status error">Error: {saveStatus.message}</p>}
        {(() => {
          const v =
            localRobloxUsername.length > 0
              ? validateRobloxUsernameSoft(localRobloxUsername)
              : { ok: true as const };
          return v.ok === false ? (
            <p className="warning-text">
              {'⚠'} {v.warning}
            </p>
          ) : null;
        })()}
        <p className="section-help">
          When you set this, your peer&rsquo;s app will detect your username on their screen and
          activate ping mode.
        </p>
        {localRobloxUsername === '' && pairedNow && (
          <div className="banner nudge-banner">
            Set your Roblox username to enable ping-mode detection.
          </div>
        )}
      </section>

      <section className="section ping-color-section">
        <div className="section-header">
          <h2 className="section-title">Ping Color</h2>
          <code className="ping-color-value">{pingColor.toUpperCase()}</code>
        </div>
        <div className="ping-color-picker">
          <div
            className="ping-color-preview"
            style={{ backgroundColor: pingColor }}
            aria-hidden="true"
          />
          <div className="ping-color-swatches" role="radiogroup" aria-label="Ping color">
            {PING_COLOR_SWATCHES.map((color) => {
              const selected = color.toLowerCase() === pingColor.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  className={`ping-color-swatch${selected ? ' selected' : ''}${
                    color === '#ffffff' ? ' light' : ''
                  }`}
                  style={{ backgroundColor: color }}
                  role="radio"
                  aria-checked={selected}
                  aria-label={`Use ${color.toUpperCase()}`}
                  onClick={() => handlePingColorChange(color)}
                >
                  {selected && <FontAwesomeIcon icon={faCheck} />}
                </button>
              );
            })}
            <button
              type="button"
              className="ping-color-custom-button"
              aria-expanded={colorEditorOpen}
              onClick={toggleCustomColorEditor}
            >
              <span
                className="ping-color-custom-chip"
                style={{ backgroundColor: customColorPreview }}
                aria-hidden="true"
              />
              <span>Custom</span>
            </button>
          </div>
        </div>
        {colorEditorOpen && (
          <div className="ping-color-tuner">
            <div
              className="ping-color-tuner-preview"
              style={{ backgroundColor: customColorPreview }}
              aria-hidden="true"
            >
              <span>{customColorHex}</span>
            </div>
            <div className="ping-color-controls">
              <label className="color-range-row">
                <span>Hue</span>
                <input
                  className="color-range hue-range"
                  type="range"
                  min="0"
                  max="360"
                  value={customColor.hue}
                  onChange={(event) =>
                    updateCustomColor({ hue: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label className="color-range-row">
                <span>Sat</span>
                <input
                  className="color-range"
                  type="range"
                  min="0"
                  max="100"
                  value={customColor.saturation}
                  style={{
                    background: `linear-gradient(to right, hsl(${customColor.hue} 0% ${customColor.lightness}%), hsl(${customColor.hue} 100% ${customColor.lightness}%))`,
                  }}
                  onChange={(event) =>
                    updateCustomColor({ saturation: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label className="color-range-row">
                <span>Light</span>
                <input
                  className="color-range"
                  type="range"
                  min="12"
                  max="92"
                  value={customColor.lightness}
                  style={{
                    background: `linear-gradient(to right, #050505, hsl(${customColor.hue} ${customColor.saturation}% 50%), #ffffff)`,
                  }}
                  onChange={(event) =>
                    updateCustomColor({ lightness: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <div className="ping-color-hex-row">
                <label>
                  <span>Hex</span>
                  <input
                    className="ping-color-hex-input"
                    type="text"
                    value={customColorHex}
                    maxLength={7}
                    spellCheck={false}
                    onChange={(event) => handleCustomHexChange(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') applyCustomColor();
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="ping-color-apply"
                  onClick={applyCustomColor}
                  disabled={!normalizeHexColorInput(customColorHex)}
                >
                  Apply
                </button>
              </div>
              {customColorError && <p className="status error">{customColorError}</p>}
            </div>
          </div>
        )}
        {pingColorStatus.kind === 'saving' && <p className="status">Saving…</p>}
        {pingColorStatus.kind === 'saved' && <p className="status">Saved</p>}
        {pingColorStatus.kind === 'error' && (
          <p className="status error">Error: {pingColorStatus.message}</p>
        )}
      </section>

      {TRACKING_SETTINGS_VISIBLE && (
        <section className="section tracking-section">
          <h2 className="section-title">Tracking Calibration</h2>
          {calibrationData ? (
            <p className="section-help">
              Calibrated {timeAgo(calibrationData.calibratedAt)}. pixels/deg:{' '}
              {calibrationData.pixelsPerDegree.toFixed(1)} mouse-px/deg:{' '}
              {calibrationData.mousePixelsPerDegree.toFixed(1)}
            </p>
          ) : (
            <p className="section-help">Not calibrated. Using defaults (8.0).</p>
          )}
          {calibrationSavedSnack && <p className="status">Calibration saved</p>}
          <div className="button-row">
            <Button variant="primary" onClick={() => setCalibrationModalOpen(true)}>
              {calibrationData ? 'Re-calibrate' : 'Calibrate now'}
            </Button>
          </div>
          <div
            className="tracking-quality-control"
            onBlur={(event) => {
              const nextFocus = event.relatedTarget;
              if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
                setTrackingSelectOpen(false);
              }
            }}
          >
            <span className="section-help">Tracking quality</span>
            <button
              type="button"
              className="custom-select-button"
              aria-haspopup="listbox"
              aria-expanded={trackingSelectOpen}
              onClick={() => setTrackingSelectOpen((open) => !open)}
            >
              <span>{trackingFpsLabel(trackingFps)}</span>
              <FontAwesomeIcon icon={faChevronDown} />
            </button>
            {trackingSelectOpen && (
              <div className="custom-select-menu" role="listbox" aria-label="Tracking quality">
                {(['auto', 10, 15, 30, 60] as const).map((fps) => (
                  <button
                    key={fps}
                    type="button"
                    className={`custom-select-option${trackingFps === fps ? ' selected' : ''}`}
                    role="option"
                    aria-selected={trackingFps === fps}
                    onClick={() => {
                      handleTrackingFpsChange(fps);
                      setTrackingSelectOpen(false);
                    }}
                  >
                    {trackingFpsLabel(fps)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="manual-tracking-profile">
            <label className="manual-tracking-toggle">
              <input
                className="manual-tracking-checkbox-input"
                type="checkbox"
                checked={manualTrackingDraft.enabled}
                onChange={(event) =>
                  updateManualTrackingDraft({ enabled: event.currentTarget.checked })
                }
              />
              <span className="manual-tracking-checkbox" aria-hidden="true">
                {manualTrackingDraft.enabled && <FontAwesomeIcon icon={faCheck} />}
              </span>
              <span>Use manual game values</span>
            </label>
            <div className="tracking-profile-grid">
              <label className="tracking-profile-field">
                <span>FOV</span>
                <input
                  type="number"
                  min="30"
                  max="140"
                  step="1"
                  value={manualTrackingDraft.fovH}
                  onChange={(event) =>
                    updateManualTrackingDraft({ fovH: event.currentTarget.value })
                  }
                  placeholder="90"
                />
              </label>
              <label className="tracking-profile-field">
                <span>DPI</span>
                <input
                  type="number"
                  min="100"
                  max="32000"
                  step="50"
                  value={manualTrackingDraft.mouseDpi}
                  onChange={(event) =>
                    updateManualTrackingDraft({ mouseDpi: event.currentTarget.value })
                  }
                  placeholder="800"
                />
              </label>
              <label className="tracking-profile-field">
                <span>In-game sens</span>
                <input
                  type="number"
                  min="0.01"
                  max="20"
                  step="0.01"
                  value={manualTrackingDraft.inGameSensitivity}
                  onChange={(event) =>
                    updateManualTrackingDraft({ inGameSensitivity: event.currentTarget.value })
                  }
                  placeholder="1.00"
                />
              </label>
            </div>
            <div className="button-row">
              <Button
                variant="secondary"
                onClick={handleManualTrackingSave}
                disabled={manualTrackingStatus.kind === 'saving'}
              >
                Save game values
              </Button>
            </div>
            {manualTrackingSavedAt !== null && (
              <p className="section-help">Game values saved {timeAgo(manualTrackingSavedAt)}.</p>
            )}
            {manualTrackingStatus.kind === 'saving' && <p className="status">Saving…</p>}
            {manualTrackingStatus.kind === 'saved' && <p className="status">Saved</p>}
            {manualTrackingStatus.kind === 'error' && (
              <p className="status error">Error: {manualTrackingStatus.message}</p>
            )}
          </div>
        </section>
      )}

      <section className="section">
        <h2 className="section-title">Hotkey</h2>
        {hotkey ? (
          <HotkeyRebind
            currentAccelerator={hotkey.accelerator}
            currentMode={hotkey.mode}
            pairedNow={pairedNow}
            busy={!loaded}
            onRebind={handleRebind}
            onResetDefault={handleResetHotkey}
          />
        ) : (
          <p className="section-help">Loading…</p>
        )}
      </section>

      <section className="section">
        <h2 className="section-title">Connection</h2>
        <p className="section-help">Relay endpoint the client connects to.</p>
        {config ? (
          <ConnectionStatus relayUrl={config.relayUrl} isDev={config.isDev} />
        ) : (
          <p className="section-help">Loading…</p>
        )}
      </section>

      {TRACKING_SETTINGS_VISIBLE && (
        <CalibrationModal
          isOpen={calibrationModalOpen}
          onClose={() => setCalibrationModalOpen(false)}
          onSaved={() => setCalibrationSavedSnack(true)}
        />
      )}
    </div>
  );
}

function ConnectionBadge({
  connection,
  loaded,
}: {
  connection: PairStatePayload['connection'];
  loaded: boolean;
}): JSX.Element {
  const label = loaded ? connection : 'loading';
  return <div className={`connection-badge ${label}`}>{label}</div>;
}

function renderSpectatorStatusText(spectatorState: PairStatePayload['spectatorState']): string {
  if (spectatorState === 'spectated') return 'Your teammate is spectating you — ping mode active';
  if (spectatorState === 'spectating') return 'You are spectating your teammate';
  return 'Waiting for spectator match';
}

function statusTitle(state: PairStatePayload): string {
  if (state.connection === 'connecting') return 'Connecting';
  if (state.connection === 'reconnecting') return 'Reconnecting…';
  if (state.connection === 'disconnected') return 'Relay Unavailable';
  if (state.pair.kind === 'generating') return 'Waiting For Teammate';
  if (state.pair.kind === 'redeeming') return 'Pairing';
  if (state.pair.kind === 'paired') return 'Paired';
  return 'Ready To Pair';
}

function statusDetail(state: PairStatePayload, expiresAt?: number): string {
  if (state.connection === 'connecting') return 'Opening a WebSocket connection to the relay.';
  if (state.connection === 'reconnecting') {
    return 'Lost the relay connection. Retrying with backoff.';
  }
  if (state.connection === 'disconnected') return 'The app will keep retrying in the background.';
  if (state.pair.kind === 'generating') {
    return expiresAt ? `Code expires ${formatTime(expiresAt)}.` : 'Generating a code.';
  }
  if (state.pair.kind === 'redeeming') return `Redeeming ${state.pair.code}.`;
  if (state.pair.kind === 'paired') {
    if (state.peerRobloxUsername !== null) return `Spectating for ${state.peerRobloxUsername}.`;
    return 'The overlay opens automatically while paired.';
  }
  return 'Generate a code or redeem one from your teammate.';
}

type LatencyTier = 'good' | 'ok' | 'poor';

function latencyTier(latencyMs: number): LatencyTier {
  if (latencyMs < 100) return 'good';
  if (latencyMs < 300) return 'ok';
  return 'poor';
}

function formatLatency(latencyMs: number): string {
  if (latencyMs < 1000) return `${latencyMs}ms`;
  return `${(latencyMs / 1000).toFixed(1)}s`;
}

function trackingFpsLabel(fps: TrackingFps): string {
  return fps === 'auto' ? 'Auto' : `${fps} fps`;
}

function normalizeCode(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 6);
}

function formatPairCode(value?: string): string {
  if (!value) return '------';
  return value.length === 6 ? `${value.slice(0, 3)} ${value.slice(3)}` : value;
}

function shortId(value: string): string {
  return value.length > 13 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/;

function normalizeHexColorInput(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return HEX_COLOR_PATTERN.test(withHash) ? withHash.toLowerCase() : null;
}

function hexToHsl(hex: string): HslColor {
  const normalized = normalizeHexColorInput(hex) ?? DEFAULT_PING_COLOR;
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) {
    return { hue: 0, saturation: 0, lightness: Math.round(lightness * 100) };
  }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  return {
    hue: Math.round(hue),
    saturation: Math.round(saturation * 100),
    lightness: Math.round(lightness * 100),
  };
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = clampNumber(saturation, 0, 100) / 100;
  const l = clampNumber(lightness, 0, 100) / 100;

  if (s === 0) {
    const channel = Math.round(l * 255);
    return rgbToHex(channel, channel, channel);
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToRgb(p, q, h + 1 / 3);
  const g = hueToRgb(p, q, h);
  const b = hueToRgb(p, q, h - 1 / 3);
  return rgbToHex(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

function hueToRgb(p: number, q: number, t: number): number {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((channel) => clampNumber(Math.round(channel), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function manualProfileToDraft(profile: ManualTrackingProfile | null): ManualTrackingDraft {
  return {
    enabled: profile?.enabled ?? false,
    fovH: profile?.fovH != null ? String(profile.fovH) : '',
    mouseDpi: profile?.mouseDpi != null ? String(profile.mouseDpi) : '',
    inGameSensitivity: profile?.inGameSensitivity != null ? String(profile.inGameSensitivity) : '',
  };
}

function manualDraftToPayload(
  draft: ManualTrackingDraft,
): SettingsSaveManualTrackingProfilePayload {
  return {
    enabled: draft.enabled,
    fovH: parseOptionalNumber(draft.fovH, 30, 140, 'FOV'),
    mouseDpi: parseOptionalNumber(draft.mouseDpi, 100, 32_000, 'DPI'),
    inGameSensitivity: parseOptionalNumber(draft.inGameSensitivity, 0.01, 20, 'Sensitivity'),
  };
}

function parseOptionalNumber(
  value: string,
  min: number,
  max: number,
  label: string,
): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const container = document.getElementById('root');
if (!container) throw new Error('main root element missing');

createRoot(container).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);

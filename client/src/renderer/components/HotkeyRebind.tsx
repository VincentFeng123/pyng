import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsHotkeyMode } from '@pyng/shared';
import { Button } from './Button.js';

type Props = {
  currentAccelerator: string;
  currentMode: SettingsHotkeyMode;
  pairedNow: boolean;
  busy: boolean;
  onRebind: (accelerator: string, mode: SettingsHotkeyMode) => Promise<void>;
  onResetDefault: () => Promise<void>;
};

type CaptureError = { message: string };

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS']);

export function HotkeyRebind({
  currentAccelerator,
  currentMode,
  pairedNow,
  busy,
  onRebind,
  onResetDefault,
}: Props): JSX.Element {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<CaptureError | null>(null);
  const [pendingMode, setPendingMode] = useState<SettingsHotkeyMode>(currentMode);

  useEffect(() => {
    setPendingMode(currentMode);
  }, [currentMode]);

  const isWindowsLikeMeta = useMemo(() => isWindowsPlatform(), []);

  const persist = useCallback(
    async (accelerator: string, mode: SettingsHotkeyMode): Promise<void> => {
      const conflict = await window.pyng.input.checkConflict(accelerator);
      if (conflict.reserved) {
        setError({ message: conflict.reason ?? `${accelerator} is reserved` });
        return;
      }
      try {
        await onRebind(accelerator, mode);
        setError(null);
      } catch (err) {
        setError({ message: errorMessage(err) });
      }
    },
    [onRebind],
  );

  useEffect(() => {
    if (!capturing) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setCapturing(false);
        return;
      }
      if (MODIFIER_KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const accelerator = buildAccelerator(event, isWindowsLikeMeta);
      if (!accelerator) {
        setError({ message: 'Unsupported key' });
        setCapturing(false);
        return;
      }
      setCapturing(false);
      void persist(accelerator, pendingMode);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [capturing, isWindowsLikeMeta, pendingMode, persist]);

  const handleStartCapture = useCallback(() => {
    if (pairedNow || busy) return;
    setError(null);
    setCapturing(true);
  }, [busy, pairedNow]);

  const handleCancelCapture = useCallback(() => {
    setCapturing(false);
  }, []);

  const handleModeChange = useCallback(
    async (next: SettingsHotkeyMode) => {
      if (pairedNow || busy || next === currentMode) {
        setPendingMode(next);
        return;
      }
      setPendingMode(next);
      try {
        await onRebind(currentAccelerator, next);
        setError(null);
      } catch (err) {
        setError({ message: errorMessage(err) });
        setPendingMode(currentMode);
      }
    },
    [busy, currentAccelerator, currentMode, onRebind, pairedNow],
  );

  const handleReset = useCallback(async () => {
    if (pairedNow || busy) return;
    setError(null);
    try {
      await onResetDefault();
    } catch (err) {
      setError({ message: errorMessage(err) });
    }
  }, [busy, onResetDefault, pairedNow]);

  const promptText =
    currentMode === 'hold'
      ? `Hold ${currentAccelerator}, then click to drop a ping`
      : `Press ${currentAccelerator} to drop a ping`;

  return (
    <div className="hotkey-rebind">
      <div className="hotkey-prompt">
        <div className="hotkey-key">{currentAccelerator}</div>
        <p className="hotkey-prompt-text">{promptText}</p>
      </div>

      <fieldset className="hotkey-mode" disabled={busy || pairedNow}>
        <legend className="visually-hidden">Hotkey mode</legend>
        <label className={`hotkey-mode-option${pendingMode === 'hold' ? ' selected' : ''}`}>
          <input
            type="radio"
            name="hotkey-mode"
            value="hold"
            checked={pendingMode === 'hold'}
            onChange={() => void handleModeChange('hold')}
          />
          <div>
            <span className="hotkey-mode-label">Hold (recommended)</span>
            <span className="hotkey-mode-help">
              Hold the key, then click anywhere to drop a ping. Required for fullscreen Roblox where
              the cursor is captured.
            </span>
          </div>
        </label>
        <label className={`hotkey-mode-option${pendingMode === 'press' ? ' selected' : ''}`}>
          <input
            type="radio"
            name="hotkey-mode"
            value="press"
            checked={pendingMode === 'press'}
            onChange={() => void handleModeChange('press')}
          />
          <div>
            <span className="hotkey-mode-label">Press</span>
            <span className="hotkey-mode-help">
              Press the key to drop a ping at the current cursor position. Works in windowed mode or
              with a custom cursor unlock.
            </span>
          </div>
        </label>
      </fieldset>

      {capturing ? (
        <div className="hotkey-capture">
          <span className="hotkey-capture-dot" aria-hidden />
          <span className="hotkey-capture-text">Press any key combination… (Esc to cancel)</span>
          <Button variant="secondary" onClick={handleCancelCapture}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="button-row">
          <Button variant="primary" onClick={handleStartCapture} disabled={pairedNow || busy}>
            Rebind
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleReset()}
            disabled={pairedNow || busy}
          >
            Reset to default
          </Button>
        </div>
      )}

      {pairedNow && <p className="hotkey-locked-hint">Unpair first to rebind the hotkey.</p>}
      {error && <p className="status error">{error.message}</p>}
    </div>
  );
}

function buildAccelerator(event: KeyboardEvent, isWindowsLikeMeta: boolean): string | null {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push(isWindowsLikeMeta ? 'Win' : 'Cmd');
  const key = normalizeEventKey(event);
  if (!key) return null;
  return [...modifiers, key].join('+');
}

function normalizeEventKey(event: KeyboardEvent): string | null {
  const code = event.code;
  // Letters: KeyA..KeyZ → A..Z
  if (code.startsWith('Key') && code.length === 4) {
    return code.slice(3);
  }
  // Top-row digits: Digit0..Digit9 → 0..9
  if (code.startsWith('Digit') && code.length === 6) {
    return code.slice(5);
  }
  // Numpad digits: Numpad0..Numpad9 → num0..num9 (Electron Accelerator)
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    if (rest.length === 1 && /[0-9]/.test(rest)) return `num${rest}`;
  }
  // Function keys
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code;
  }
  // Named keys — only allow keys the underlying accelerator pattern accepts.
  // settings.ts validates with /^[A-Za-z0-9][A-Za-z0-9+]*$/, so reject
  // punctuation, navigation, etc. — they'd fail persistence anyway.
  const namedMap: Record<string, string> = {
    Space: 'Space',
    Tab: 'Tab',
  };
  if (namedMap[code]) return namedMap[code];
  return null;
}

function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  return /win/i.test(platform);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

import type { SettingsAvatar } from '@pyng/shared';
import { Button } from './Button.js';

type Props = {
  avatar: SettingsAvatar;
  loaded: boolean;
  busy: boolean;
  onPick: () => void;
  onClear: () => void;
};

export function AvatarPicker({ avatar, loaded, busy, onPick, onClear }: Props): JSX.Element {
  const hasAvatar = avatar !== null;
  return (
    <div className="avatar-row">
      <div className="avatar-preview" aria-label="avatar preview">
        {hasAvatar ? (
          <img
            src={`data:image/png;base64,${avatar.imageBase64}`}
            alt="current avatar"
            width={64}
            height={64}
          />
        ) : (
          <span className="avatar-empty">{loaded ? 'No avatar' : '…'}</span>
        )}
      </div>
      <div className="avatar-meta">
        <span className="meta-label">Size</span>
        <span className="meta-value">{hasAvatar ? formatKb(avatar.imageBase64) : '—'}</span>
        <div className="button-row">
          <Button variant="primary" onClick={onPick} disabled={busy}>
            {hasAvatar ? 'Replace' : 'Choose image'}
          </Button>
          {hasAvatar && (
            <Button variant="danger" onClick={onClear} disabled={busy}>
              Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatKb(base64: string): string {
  // base64 → byte length: roughly 3/4 of string length.
  const bytes = Math.floor((base64.length * 3) / 4);
  const kb = bytes / 1024;
  return `${kb.toFixed(1)} KB`;
}

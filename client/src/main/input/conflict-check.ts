// OS-reserved accelerator combos that pyng must NOT register. Used by the
// rebind UI (#50) to reject obviously dangerous combos before persisting.
//
// This is NOT a comprehensive list — uiohook will still successfully bind
// most of these, the OS just gets to the event first and pyng never sees
// it. The list is mostly UX safety: prevent users from picking a combo
// they think will work but won't, and prevent picking a combo that would
// be hostile (e.g., disabling Cmd+Q on macOS).

const RESERVED: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^Ctrl\+Alt\+Delete$/i, reason: 'reserved by the OS (Secure Attention Sequence)' },
  { pattern: /^Alt\+F4$/i, reason: 'reserved by the OS (close window)' },
  { pattern: /^Ctrl\+Alt\+Tab$/i, reason: 'reserved by the OS (window switcher)' },
  { pattern: /^Alt\+Tab$/i, reason: 'reserved by the OS (window switcher)' },
  { pattern: /^Win(\+|$)/i, reason: 'reserved by the OS (Windows key combos)' },
  { pattern: /^Super(\+|$)/i, reason: 'reserved by the OS (Super key combos)' },
  { pattern: /^Cmd\+Q$/i, reason: 'reserved by macOS (quit application)' },
  { pattern: /^Cmd\+W$/i, reason: 'reserved by macOS (close window)' },
  { pattern: /^Cmd\+Tab$/i, reason: 'reserved by macOS (app switcher)' },
  { pattern: /^Cmd\+Space$/i, reason: 'reserved by macOS (Spotlight)' },
  { pattern: /^Win\+L$/i, reason: 'reserved by Windows (lock workstation)' },
];

export type ConflictCheckResult = { reserved: boolean; reason?: string };

export function isReservedAccelerator(accelerator: string): ConflictCheckResult {
  const trimmed = accelerator.trim();
  if (trimmed.length === 0) {
    return { reserved: true, reason: 'accelerator must be non-empty' };
  }
  for (const { pattern, reason } of RESERVED) {
    if (pattern.test(trimmed)) {
      return { reserved: true, reason };
    }
  }
  return { reserved: false };
}

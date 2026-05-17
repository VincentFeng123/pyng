# Settings

Per-install user preferences, stored locally. No sync, no cloud.

## Storage

Settings live in a JSON file managed by `electron-store`. The store name is
`pyng-settings` and the file location is the standard `electron-store` default
(Electron's `app.getPath('userData')`):

- **Windows:** `%APPDATA%\pyng\pyng-settings.json`
- **macOS:** `~/Library/Application Support/pyng/pyng-settings.json`
- **Linux:** `~/.config/pyng/pyng-settings.json`

The store is a singleton at module scope. Tests can construct an isolated
store via `createSettingsStore({ cwd, name })`.

## Schema

Defined in `/Users/vincentfeng/Documents/pyng/client/src/main/settings.ts`.
v2 adds hotkey config and a first-run-hint flag; these are additive (no
version bump, see Migration policy below):

```typescript
type SettingsSchema = {
  version: 1;
  avatar: {
    imageBase64: string;  // PNG, normalized to 64×64, no data URL prefix
    setAt: number;        // unix ms when the avatar was saved
  } | null;
  hotkey: {
    accelerator: string;  // Electron Accelerator format, e.g. "Z", "Ctrl+Shift+P"
    mode: 'press' | 'hold';
  };
  firstRunHintShown: boolean;
};
```

`version` is a literal `1`. Defaults on a fresh install:

- `avatar: null`
- `hotkey: { accelerator: 'Z', mode: 'hold' }`
- `firstRunHintShown: false`

The `'hold'` mode is the v2 primary because Roblox captures the cursor
during fullscreen gameplay — pressing the key once gives no usable cursor
position. Holding the key takes the overlay out of click-through mode (and
shows a cursor) for as long as the user holds; releasing fires the ping at
the current cursor coord. The `'press'` mode is retained for users who
prefer single-keystroke pings in non-cursor-capture contexts; see
`client/src/main/input/hotkey.ts` (added in #48).

## Constraints

- `imageBase64.length` must be `< MAX_AVATAR_BASE64_LENGTH` (`64 * 1024`).
  `saveAvatar` throws on oversize input. The same cap is enforced again by the
  protocol layer (`isMessage` in `shared/src/protocol.ts`) and the relay
  server's `setGroupAvatar` — defense in depth.
- PNG normalization happens before `saveAvatar` is called (see
  `client/src/main/avatarNormalize.ts`). The settings module itself does not
  decode or validate the image; it just stores bytes.

## API surface

All exports from `client/src/main/settings.ts`:

| Function | Purpose |
|---|---|
| `loadSettings(store?)` | Read the full schema. |
| `saveAvatar(imageBase64, store?)` | Set the avatar; throws if oversize. Stamps `setAt`. |
| `clearAvatar(store?)` | Set `avatar` to `null`. |
| `saveHotkey(accelerator, mode, store?)` | Persist hotkey config; throws on empty/malformed accelerator or unknown mode. Format check only — the OS-level register check lives in the hotkey module. |
| `getHotkey(store?)` | Read the current hotkey config. |
| `setFirstRunHintShown(value, store?)` | Mark the first-run hint as shown (or reset to unshown). |
| `getFirstRunHintShown(store?)` | Read the first-run-hint flag. |
| `onSettingsChange(cb, store?)` | Subscribe to any change; returns an unsubscribe fn. |
| `createSettingsStore({ cwd?, name? })` | Construct an isolated store (tests only). |

Every function accepts an optional `store` argument so tests can pass a
sandboxed instance. Production code uses the default singleton.

## Hotkey rebind UX

The Settings tab of the dashboard renders a `HotkeyRebind` component that lets
the user change the global hotkey at runtime. Flow:

1. The component displays the current accelerator (e.g. `Z`, `Ctrl+Shift+P`)
   and a mode toggle (`hold` / `press`).
2. Clicking "Rebind" puts the component into capture mode: it listens for the
   next keydown via a focused hidden input and renders the captured token
   (with modifier keys) as an Electron `Accelerator` string.
3. Before saving, the component sends `INPUT_CHECK_CONFLICT` IPC to main with
   the proposed accelerator. The main process consults
   `client/src/main/input/hotkey.ts`'s blocklist (Ctrl+Alt+Delete, Alt+F4,
   Alt+Tab, Win+anything, Cmd+Q / Cmd+W / Cmd+Tab / Cmd+Space, etc.) and
   replies with `{ reserved: boolean, reason?: string }`. A reserved
   accelerator is shown inline with the reason; the user picks a different
   one.
4. On accept, the component sends `SETTINGS_SAVE_HOTKEY` with
   `{ accelerator, mode }`. `saveHotkey` validates format and persists.
5. The main-process input bridge subscribes to settings changes and, while
   paired, re-registers the global hotkey to the new accelerator. If
   `globalShortcut.register` fails (another app holds the key OS-wide), main
   broadcasts `INPUT_HOTKEY_REGISTRATION_ERROR` to the renderer with the
   `accelerator` and a human-readable `message`; the settings UI shows it
   next to the rebind row.

The "Reset to default" button writes back `{ accelerator: 'Z', mode: 'hold' }`.

Mode semantics (also documented above):
- **`hold`**: while the hotkey is held, the overlay leaves click-through and
  shows the cursor; releasing fires a ping at the cursor coord. Required for
  Roblox fullscreen where cursor capture would otherwise eat the ping. This
  is the default.
- **`press`**: a tap fires a ping at the current cursor coord. Only useful
  outside cursor-captured contexts (e.g. solo mode for demos). Documented as
  best-effort opt-in.

## Adding a new settings field

1. Extend `SettingsSchema` with the new field. Choose a sensible default.
2. Add the default to the `DEFAULTS` constant.
3. Add a typed getter/setter pair if the field has invariants (size cap,
   enum, etc.) — mirror the `saveAvatar` / `clearAvatar` shape. For trivial
   fields, callers can use `store.set('field', value)` directly.
4. Update `MAX_*` constants and validate against them in both the
   client setter and any wire-protocol guard if the field crosses the network.
5. If the change is breaking (renamed field, narrower type, etc.) follow the
   migration policy below.

## Migration policy

The `version` field exists so future breaking schema changes can be detected
and migrated forward. v1.5 shipped at `version: 1`. v2 stayed at `version: 1`
because adding `hotkey` and `firstRunHintShown` is purely additive — electron-store's
`defaults` option fills missing fields on read, so a pre-v2 settings file
opens as a valid v2 schema without any migration code. When a breaking
change is introduced:

1. Bump the version literal in `SettingsSchema` and `DEFAULTS`.
2. Add a migration function that takes the old shape and returns the new one.
3. Call the migration in `loadSettings` before returning, if `store.get('version')`
   is lower than the current value.
4. Non-breaking additions (new optional fields) do NOT bump the version.

Reset-by-deletion is acceptable for early-stage breaking changes — `electron-store`
will recreate the file with `DEFAULTS` if it doesn't parse. Use that only when
the field had no user-visible state worth preserving.

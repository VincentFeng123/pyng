import { createEnvelope, type PeerUsernamePayload } from '@pyng/shared';
import type { WsClient } from '../net/wsClient.js';
import { loadSettings, onSettingsChange } from '../settings.js';
import type { PairStateMachine } from '../state-machine.js';

export type PublishLog = (line: string) => void;

/**
 * Publish the local user's Roblox username to the paired group.
 *
 * Mirrors `publishOwnAvatar` in state-machine.ts. When the user hasn't set a
 * Roblox username (empty string default), we log and skip — the server's
 * `setPendingUsername` would reject an empty value anyway.
 */
export function publishOwnUsername(
  client: WsClient,
  groupId: string,
  sessionId: string,
  robloxUsername: string,
  log?: PublishLog,
): void {
  if (robloxUsername === '') {
    log?.('peer:username skipped (no roblox username set)');
    return;
  }
  const envelope = createEnvelope<'peer:username'>(
    'peer:username',
    { sessionId, robloxUsername } satisfies PeerUsernamePayload,
    { groupId },
  );
  client.sendEnvelope(envelope);
  log?.(`peer:username published username=${robloxUsername}`);
}

/**
 * In-memory cache of group members' Roblox usernames, keyed by sessionId.
 * Populated from incoming `peer:username` envelopes (server-cached/replayed).
 * Mirrors `PeerAvatarStore`.
 */
export class PeerUsernameStore {
  private readonly usernames = new Map<string, string>();

  set(sessionId: string, robloxUsername: string): void {
    this.usernames.set(sessionId, robloxUsername);
  }

  getForSession(sessionId: string): string | null {
    return this.usernames.get(sessionId) ?? null;
  }

  clear(): void {
    this.usernames.clear();
  }

  /**
   * Convenience helper: in a 2-member group, return the OTHER member's
   * username. Used by the OCR pipeline's username:announce filter to ask
   * "does what I'm seeing match my peer's known username?". Null when the
   * peer hasn't published yet or there's no peer in the store.
   */
  getPeerUsername(ownSessionId: string): string | null {
    for (const [sessionId, robloxUsername] of this.usernames) {
      if (sessionId !== ownSessionId) return robloxUsername;
    }
    return null;
  }
}

/**
 * Pure decision logic for the change handler. Exported for testability —
 * `republishOnUsernameChange` is hard to drive without an electron-store
 * round-trip, so the diff-and-dispatch logic lives here.
 *
 * Returns the new "previous" value (always the latest seen) so the caller
 * can keep its local closure state in sync.
 */
export function handleUsernameChange(
  previous: string,
  next: string,
  machine: Pick<PairStateMachine, 'getState'>,
  client: WsClient,
  store: PeerUsernameStore,
  log?: PublishLog,
): { next: string; published: boolean } {
  if (next === previous) {
    return { next: previous, published: false };
  }
  const state = machine.getState();
  if (state.pair.kind !== 'paired') {
    // Value changed but we're not paired — update our tracked `previous` so
    // the next paired publish doesn't try to re-emit this same value, but
    // skip the wire send.
    return { next, published: false };
  }
  const { groupId, sessionId } = state.pair;
  store.set(sessionId, next);
  publishOwnUsername(client, groupId, sessionId, next, log);
  return { next, published: true };
}

/**
 * Subscribe to settings changes and re-publish `peer:username` whenever the
 * user updates their Roblox username AND they're currently paired. Also seeds
 * the local store with the new value so self-references stay consistent.
 *
 * Seeded with the current SettingsSchema value at subscribe time, so the next
 * onSettingsChange callback only fires a republish if the value actually
 * differs (electron-store fires onDidAnyChange on any write to any field).
 *
 * Returns an unsubscribe function.
 */
export function republishOnUsernameChange(
  client: WsClient,
  machine: PairStateMachine,
  store: PeerUsernameStore,
  log?: PublishLog,
): () => void {
  let previous = loadSettings().robloxUsername;

  return onSettingsChange((nextSettings) => {
    const result = handleUsernameChange(
      previous,
      nextSettings.robloxUsername,
      machine,
      client,
      store,
      log,
    );
    previous = result.next;
  });
}

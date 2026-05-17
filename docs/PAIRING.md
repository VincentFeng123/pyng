# Pairing

Code-based pairing between two pyng clients. No signup, no accounts, no email.

## Goal

Two friends go from "I downloaded pyng" to "we're paired" in under 30 seconds
and zero typed credentials.

## How users actually pair (v2)

In v2 the pairing flow lives entirely in the consolidated dashboard's Pairing
tab. The user clicks one button per side; the wire envelopes below are what
the main process emits in response. There is NO user-facing CLI for pairing.

```
Alice (Dashboard → Pairing tab)              Server                      Bob (Dashboard → Pairing tab)
─────────────────────────────                ──────                      ─────────────────────────────
1. Open pyng (auto-connects to relay)
2. Click "Generate code"
   ──── pair:generate ───────────────────►
                                            3. Generate code "K7M2P9"
                                               Store: code → Alice's session
                                               TTL: 10 minutes
   ◄──── pair:code ──────────────────────
4. Pairing tab shows "K7M2P9"
   in big readable digits
5. (tells Bob the code IRL,
    via Discord, etc.)
                                                                        6. Open pyng (auto-connects)
                                                                        7. Type "K7M2P9" in the
                                                                           6-char input
                                                                        8. Click "Pair"
                                                            ◄────── pair:redeem ──────
                                            9. Look up code
                                               Match Alice's session
                                               Generate groupId
                                               Link: groupId → [Alice, Bob]
                                               Invalidate the code
                                               (Replay any pre-pair avatars)
   ◄── pair:established ─────────────── ─── pair:established ──────►
10. Pairing tab flips to                                                11. Pairing tab flips to
    Paired view; overlay opens                                              Paired view; overlay opens
    behind it. Hotkey registered.                                           behind it. Hotkey registered.
```

After pairing, each client also publishes its own `peer:avatar` envelope so
the peer can render its avatar inside future ping markers. See
`docs/PROTOCOL.md` for the avatar wire shape.

### Legacy CLI flow (dev-only)

The repo's `scripts/dev.ts`, `scripts/dev-peer.ts`, and the mock-peer
integration test harness use a one-shot CLI flow that pre-dates the v2
dashboard. The Electron entrypoint opts into this flow when launched with
`--legacy-cli` (or `LEGACY_CLI=1`) plus `MODE=generate|redeem`. In legacy-CLI
mode no dashboard window opens — the client connects, pairs (via the
pre-supplied `CODE` env or by printing a generated code to stdout), opens
the overlay, and exits on SIGINT.

End users never see this. It exists for two reasons:
- Regression tests (`scripts/mock-peer.ts` drives both sides over raw
  WebSocket; the integration test pairs a real Electron via the CLI flow
  against a scripted mock peer).
- Repro of v0/v1 behavior on demand.

If you're writing new docs that talk about "running pyng," default to the GUI
flow above. The CLI flow is documented separately in `scripts/`.

## Code format

6 characters, alphanumeric, no visually-confusable chars.

```typescript
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no I, L, O, 0, 1
const CODE_LENGTH = 6;

function generateCode(): string {
  let result = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    result += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }
  return result;
}
```

That's `32^6 = ~1 billion` codes. With 10-minute TTL and reasonable user count, collision risk is negligible. If a collision somehow happens at generation time, retry up to 5 times.

## Code expiry

Codes expire 10 minutes after generation. After expiry, redeeming returns `pair:invalid` with reason `expired`.

A code can only be redeemed once. After successful redemption, it's deleted.

If Alice generates a code and Bob doesn't redeem within 10 minutes, Alice's UI shows "code expired" and offers a new one.

## Pair lifecycle (v2)

```
States:    [NONE] ─generate→ [WAITING] ─redeem→ [LIVE] ──disconnect/──→ [NONE]
                                 │                  │     explicit
                                 ▼ (10 min)         ▼ (manual unpair)    unpair
                              [EXPIRED]          [NONE]
```

- **NONE**: no pair, idle. Dashboard shows the Generate / Redeem prompt.
- **WAITING**: Alice has a code, hasn't been redeemed yet. Dashboard shows the
  big code display. Cancelling here clears the code.
- **LIVE**: both clients connected, overlay is open, hotkey is registered.
- (Back to NONE on any of: explicit unpair, peer disconnect, own connection
  drop, ten-minute expiry while WAITING.)

v2 does NOT have a grace period. If a paired client's socket closes for any
reason, the server immediately drops it from the group. The remaining peer
sees no event (server has no `pair:broken` v2 implementation), but its own
connection stays healthy. On the dropped side, the state machine returns to
NONE with a `pairLostHint` flag; the dashboard shows a dismissible
"Connection dropped — please re-pair" banner. A future v3 grace-period
implementation can layer on `pair:resume` without changing the wire shape.

## Reconnection (v2)

The client reconnects to the relay automatically on a stepped backoff (1s,
2s, 4s, 8s, then 8s). The dashboard's connection badge cycles
`connected → disconnected → reconnecting → connected`.

`pair:resume` is defined in the protocol but the v2 server does not handle
it. Reconnecting clients re-pair from scratch (generate or redeem a new
code). This is intentional — the cost of a re-pair is "type 6 characters
into the dashboard"; the cost of supporting resume correctly (race-free
group membership, ephemeral identity preservation) is large enough to defer.

## Server-side state

In-memory only. No database.

```typescript
type CodeRecord = {
  code: string;
  generatorSessionId: string;
  expiresAt: number;
};

type GroupRecord = {
  groupId: string;
  sessionIds: Set<string>;  // N-member ready; group cap of 2 enforced in redeem flow
  avatars: Map<string, string>;  // sessionId → base64 PNG (per peer:avatar publish)
  createdAt: number;
  lastActivityAt: number;
};

const codes = new Map<string, CodeRecord>();
const groups = new Map<string, GroupRecord>();
const sessionToGroup = new Map<string, string>();           // sessionId → groupId
const pendingAvatars = new Map<string, string>();           // sessionId → base64
// pendingAvatars holds avatars that were published before the publisher's
// session joined a group. redeemCode drains matching entries into the new
// group's avatars Map at creation time.
```

Cleanup runs every 60 seconds (v2 cleans codes only; group lifetime is
session-tied via `dropSession`, not a periodic sweep):

```typescript
function cleanup() {
  const now = Date.now();
  for (const [code, rec] of codes) {
    if (rec.expiresAt < now) codes.delete(code);
  }
}
```

On socket close, the dropped session is removed from its group immediately
(`dropSession` clears `sessionToGroup` and removes the sessionId from the
group's `sessionIds` set). A group with one member left is kept around so
the remaining client can continue to send ping envelopes (which the relay
will silently drop since there's no peer to broadcast to). Orphan cleanup
of empty/lone groups is a v3 follow-up.

## Privacy

The server stores:

- A pairing code (random 6 chars) for up to 10 minutes
- A group record (≤2 anonymous session IDs + their published avatars) for the
  lifetime of the WebSocket connection of any member
- No logs of message payload contents — only metadata (envelope type,
  sessionId, groupId, recipient count, rejection reason)

The server does NOT store:

- Usernames (Roblox or otherwise)
- IP addresses (beyond ephemeral TCP connection state)
- Message contents (only routes them in transit)
- Any history once a pair ends

When in doubt: less storage, less liability, less privacy theater. The whole product can be summarized as "two clients with a shared random code can route messages to each other."

## Edge cases to handle

| Case | Behavior (v2) |
|---|---|
| Code generated, Alice closes pyng before Bob redeems | Code stays valid in the server's `codes` map for the full 10 minutes. When Alice closes, her socket closes; `dropSession` removes her session. If Bob redeems after this, the code lookup succeeds but `getGroupForSession(generatorSessionId)` returns null and the server emits `pair:invalid` with `reason: 'not_found'`. Bob types again, Alice re-opens pyng + regenerates, retry. |
| Alice tries to generate two codes back-to-back | Each generate creates a fresh code; older codes remain valid until their 10-min TTL. v2 does not enforce one-active-code-per-session, but the dashboard's state machine prevents the user from triggering a second generate while one is in flight. |
| Both Alice and Bob already in a pair, redeem a new code | Server rejects with `pair:invalid` `reason: 'already_used'`. v2 doesn't auto-break existing pairs; users explicitly unpair first. |
| Network blip during pairing | The state machine cancels the in-flight pair flow and drops back to NONE with an error message. Reconnect happens automatically; user retries. |
| Two people guess the same code simultaneously | First redemption wins (atomic delete-on-success). Second gets `pair:invalid` `reason: 'not_found'`. |
| Bot scraping codes | v2 has NO rate limiting. Protocol envelope `error` `code: 'rate_limited'` is defined but unused. Mitigation: the 32^6 keyspace is large enough (~1B codes, 10-min TTL) that random guessing is statistically impractical. If brute-force becomes a real problem, rate-limiting is straightforward to add server-side. |

## UI (v2 dashboard)

The Pairing tab of the consolidated dashboard owns the entire flow. Three
states are visible:

```
WAITING (after Generate):
┌──────────────────────────────────────────┐
│  pyng                          [paired]  │
│  Pair with a teammate ...                │
│                                          │
│  ●  Waiting For Teammate                 │
│     Code expires 9:43 from now.          │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │            K7 - M2 - P9            │  │
│  └────────────────────────────────────┘  │
│                                          │
│  [Cancel]                                │
└──────────────────────────────────────────┘

REDEEMING (after typing code + Pair):
┌──────────────────────────────────────────┐
│  ●  Pairing                              │
│     Redeeming K7M2P9.                    │
└──────────────────────────────────────────┘

PAIRED:
┌──────────────────────────────────────────┐
│  ●  Paired                               │
│     The overlay opens automatically...   │
│  Group     a3f1...8c                     │
│  Session   b9e0...74                     │
│  Latency   42ms                          │  (color-coded green/yellow/red)
│  [Unpair]                                │
└──────────────────────────────────────────┘
```

When pairing succeeds, the dashboard's Pairing tab flips to the Paired view
and the overlay window opens behind/above the game.

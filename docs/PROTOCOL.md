# Protocol

Full WebSocket message protocol between pyng clients and the relay server.

## Envelope

Every message — client→server or server→client — is wrapped in a typed envelope:

```typescript
// shared/protocol.ts
export type Envelope<T extends MessageType = MessageType> = {
  type: T;
  payload: PayloadFor<T>;
  groupId?: string;          // set after pair is established
  messageId: string;        // uuid v4, for round-trip latency measurement
  timestamp: number;        // unix ms at send
};
```

`type` determines the shape of `payload`. All types defined below.

## Message types

### Pairing

#### `pair:generate` (client → server)
Request a new pairing code. No prior session needed.
```typescript
payload: {}
```

#### `pair:code` (server → client)
Response containing the generated code.
```typescript
payload: {
  code: string;           // 6 chars, no ambiguous (0/O/1/I/l)
  expiresAt: number;      // unix ms, 10 min from now
};
```

#### `pair:redeem` (client → server)
Submit a code to pair with the originator.
```typescript
payload: {
  code: string;
};
```

#### `pair:established` (server → both clients)
Pair is live. Both clients receive this.
```typescript
payload: {
  groupId: string;
  peerUsername?: string;  // optional display name
};
```

#### `pair:invalid` (server → client)
The redeemed code was invalid or expired.
```typescript
payload: {
  reason: 'expired' | 'not_found' | 'already_used';
};
```

#### `pair:broken` (server → client)
The pair ended (peer disconnected > 5 min, or explicit unpair).
```typescript
payload: {
  reason: 'peer_disconnect' | 'timeout' | 'explicit';
};
```

#### `pair:resume` (client → server)
On reconnect, attempt to resume an existing pair.
```typescript
payload: {
  groupId: string;
};
// Response is pair:established (success) or pair:invalid (failed)
```

### Spectator detection

#### `username:announce` (client → server → peer)
Sender's OCR detected this username being spectated. Forwarded to peer so peer can confirm match.
```typescript
payload: {
  detectedUsername: string;
  confidence: number;      // 0..1
  game: string;            // game config id
};
```

#### `username:match` (client → server → peer)
Peer confirms the announced username matches their own. Now ping mode is active.
```typescript
payload: {
  matched: boolean;
};
```

### Pings

#### `ping:drop` (client → server → peer)
A ping was dropped. Routed to peer.
```typescript
payload: {
  coords: {
    x: number;             // normalized viewport coords 0..1
    y: number;
  };
  color: string;           // hex e.g. "#ff3344"
  ttl: number;             // ms before fade-out, default 5000
  senderSessionId: string; // who originated the ping, for avatar attribution
};
```

`senderSessionId` is set by the client and used by receivers to look up the
sender's avatar (see `peer:avatar` below). The server NEVER trusts this field
for routing — routing is keyed off the socket-bound sessionId. The sender's
own main process echoes the ping locally via IPC at send time, so the sender
sees their own ping without waiting for a wire round-trip and without the
server having to broadcast back to them.

#### `ping:clear` (client → server → peer)
Clear all active pings on peer.
```typescript
payload: {};
```

### Avatars

#### `peer:avatar` (client → server → peer)
Publish the sender's avatar so peers can render it in their ping markers. Each
client publishes its own avatar at pair time; the server caches it per-group
and broadcasts to the other group members.

```typescript
payload: {
  sessionId: string;       // MUST equal the sender's own sessionId; server rejects mismatches
  imageBase64: string;     // PNG, normalized to 64×64, base64-encoded (no data URL prefix)
};
```

Constraints:
- `imageBase64.length` must be `> 0` and `< 64 * 1024` (≈ 48 KB decoded). Enforced
  by the shared `isMessage` guard before dispatch, and again server-side as
  defense-in-depth. Oversize payloads are silently dropped.
- The server validates `payload.sessionId === socket.sessionId`. On mismatch it
  responds with an `error` envelope (`code: 'avatar_identity_mismatch'`) and
  does NOT cache or forward. This blocks a client from impersonating its peer.
- Republishing overwrites the cached entry and re-broadcasts. Free; no
  rate limit in v1.5.

Replay-on-join: when `pair:established` fires, the server immediately pushes
every cached avatar for the new group to whichever member doesn't own it. This
handles the race where the generator publishes before the redeemer connects —
publishes from a pre-pair session are pended and drained into the group's
cache at redeem time.

### Diagnostics

#### `ping:ack` (server → sender)
Acknowledges a `ping:drop` envelope by its `messageId`. Used for client-side
round-trip latency measurement.
```typescript
payload: {
  messageId: string;       // the ping:drop being acked
  receivedAt: number;      // server-side Date.now() at ack-emission time
};
```

Flow (v2):
1. Client A sends `ping:drop`.
2. Server receives it. BEFORE broadcasting to the group, server emits a
   `ping:ack` to A with the original `messageId` and a server-side `receivedAt`.
3. Server then broadcasts the `ping:drop` to every group member except A.
4. A's main process matches the ack against its in-flight map (keyed by
   `messageId`), computes `rtt = Date.now() - sentAt`, and feeds the sample
   into a 10-entry rolling mean exposed on the Paired screen.

The server uses its own `Date.now()` for `receivedAt` — never trusts payload
timestamps. The ack is sender-only; peers don't receive it. Sends without an
ack within 30s are evicted from the in-flight map to bound memory.

#### `latency:report` (client → server, optional)
Reserved for future server-side latency telemetry. Not used in v2.
```typescript
payload: {
  rttMs: number;
};
```

### Connection lifecycle

#### `hello` (client → server, first message)
Sent immediately on WebSocket connection.
```typescript
payload: {
  clientVersion: string;     // semver
  platform: 'win32' | 'darwin' | 'linux';
};
```

#### `welcome` (server → client)
Server acknowledges and assigns a session ID.
```typescript
payload: {
  sessionId: string;
  serverVersion: string;
};
```

#### `error` (server → client)
Generic error from server.
```typescript
payload: {
  code: string;              // e.g. 'protocol_error', 'rate_limited'
  message: string;
};
```

## TypeScript discriminated union

The full union lives in `shared/protocol.ts`:

```typescript
export type Message =
  | Envelope<'pair:generate'>
  | Envelope<'pair:code'>
  | Envelope<'pair:redeem'>
  | Envelope<'pair:established'>
  | Envelope<'pair:invalid'>
  | Envelope<'pair:broken'>
  | Envelope<'pair:resume'>
  | Envelope<'username:announce'>
  | Envelope<'username:match'>
  | Envelope<'peer:avatar'>
  | Envelope<'ping:drop'>
  | Envelope<'ping:clear'>
  | Envelope<'ping:ack'>
  | Envelope<'latency:report'>
  | Envelope<'hello'>
  | Envelope<'welcome'>
  | Envelope<'error'>;

export type MessageType = Message['type'];
export type PayloadFor<T extends MessageType> =
  Extract<Message, { type: T }>['payload'];
```

## Routing rules (server)

| Message type | Routing |
|---|---|
| `pair:generate` | Server consumes, responds with `pair:code` |
| `pair:redeem` | Server consumes, responds with `pair:established` or `pair:invalid` |
| `pair:resume` | Server consumes, responds with `pair:established` or `pair:invalid` |
| `username:announce` | Forward to peer |
| `username:match` | Forward to peer |
| `peer:avatar` | Forward to peers + cache in group; identity-validated against socket session |
| `ping:drop` | Server emits `ping:ack` back to sender, THEN forwards `ping:drop` to all other group members |
| `ping:clear` | Forward to peer |
| `ping:ack` | Server-generated only (in response to `ping:drop`); not accepted from clients |
| `hello` | Server consumes, responds with `welcome` |
| `latency:report` | Reserved; not handled in v2 |

## Error handling

- **Invalid message format:** server responds with `error` (`code: 'protocol_error'`) and closes connection
- **Avatar identity mismatch:** server responds with `error` (`code: 'avatar_identity_mismatch'`); the publish is not cached or forwarded. Connection stays open.
- **Rate limiting:** server responds with `error` (`code: 'rate_limited'`) but keeps connection
  - Limits: 1 ping/sec, 1 pair generation/min per client
- **Unknown message type:** server responds with `error` (`code: 'unknown_type'`)
- **Pair broken mid-ping:** server drops the message silently, sends `pair:broken` to sender

## Connection management

### Heartbeat (v2, live)

The server sends a WebSocket-level ping frame to every client every 30s.
Clients are expected to reply with the standard pong frame (the `ws` library
auto-pongs at the protocol layer). On the next 30s tick, any socket that
hasn't responded since the previous ping is terminated and the server emits
`event: 'heartbeat_timeout', sessionId` to its log.

In effect: a missed pong gets ~30s of grace; two consecutive missed pongs
hard-close the socket. This keeps connections alive across hosting-provider
idle-close windows (Railway, Fly, etc., typically 60s) while reaping
genuinely dead sockets within ~60s.

The interval is configurable via `StartOptions.heartbeatIntervalMs` for
tests; production uses the 30s default.

### Reconnection (v2, live)

When the WebSocket closes for any reason (server reaped, network blip,
client kill), the client schedules a reconnect with a stepped backoff:
1s, 2s, 4s, 8s, then 8s on every subsequent attempt (no further escalation).
The retry loop is unbounded — the user keeps the app open and the tray
indicates connection status. The connection state visible to the renderer
is `disconnected → reconnecting → connected` (or `reconnecting → disconnected`
on each failed attempt).

### Pair resume (v2: NOT implemented)

`pair:resume` is defined in the protocol union but the server does not handle
it in v2. Reasoning: the relay's group state is in-memory and ephemeral, with
no grace period. If a client's socket closes, its session is dropped from
the group immediately on `dropSession`. Re-pairing requires a fresh code.

The client-side reconnect flow reflects this: on reconnect-while-paired, the
state machine transitions the user back to `unpaired` with a `pairLostHint`
flag, and the renderer surfaces a "Connection dropped — please re-pair"
banner. The user generates or redeems a new code from there. The
`pair:resume` envelope shape stays defined so a future v3 grace-period
implementation can layer on without a protocol change.

## Versioning

Protocol version is implicit in the client/server version pair. Breaking changes bump the major version and the server rejects clients with mismatched major versions via `error` (`code: 'version_mismatch'`).

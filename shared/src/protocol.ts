import { randomUUID } from 'node:crypto';

export type Platform = 'win32' | 'darwin' | 'linux';

export type PairInvalidReason = 'expired' | 'not_found' | 'already_used';
export type PairBrokenReason = 'peer_disconnect' | 'timeout' | 'explicit';

export type PairGeneratePayload = Record<string, never>;

export type PairCodePayload = {
  code: string;
  expiresAt: number;
};

export type PairRedeemPayload = {
  code: string;
};

export type PairEstablishedPayload = {
  groupId: string;
  peerUsername?: string;
};

export type PairInvalidPayload = {
  reason: PairInvalidReason;
};

export type PairBrokenPayload = {
  reason: PairBrokenReason;
};

export type PairResumePayload = {
  groupId: string;
};

export type UsernameAnnouncePayload = {
  detectedUsername: string;
  confidence: number;
  game: string;
};

export type UsernameMatchPayload = {
  matched: boolean;
};

export type PingDropPayload = {
  coords: {
    x: number;
    y: number;
  };
  color: string;
  ttl: number;
  senderSessionId: string;
};

export type PingClearPayload = Record<string, never>;

export type PingAckPayload = {
  messageId: string;
  receivedAt: number;
};

export type LatencyReportPayload = {
  rttMs: number;
};

export const MAX_AVATAR_BASE64_LEN = 64 * 1024;

export type PeerAvatarPayload = {
  sessionId: string;
  imageBase64: string;
};

export type PeerUsernamePayload = {
  sessionId: string;
  robloxUsername: string;
};

export type HelloPayload = {
  clientVersion: string;
  platform: Platform;
};

export type WelcomePayload = {
  sessionId: string;
  serverVersion: string;
};

export type ErrorPayload = {
  code: string;
  message: string;
};

type EnvelopeBase<TType extends string, TPayload> = {
  type: TType;
  payload: TPayload;
  groupId?: string;
  messageId: string;
  timestamp: number;
};

export type Message =
  | EnvelopeBase<'pair:generate', PairGeneratePayload>
  | EnvelopeBase<'pair:code', PairCodePayload>
  | EnvelopeBase<'pair:redeem', PairRedeemPayload>
  | EnvelopeBase<'pair:established', PairEstablishedPayload>
  | EnvelopeBase<'pair:invalid', PairInvalidPayload>
  | EnvelopeBase<'pair:broken', PairBrokenPayload>
  | EnvelopeBase<'pair:resume', PairResumePayload>
  | EnvelopeBase<'username:announce', UsernameAnnouncePayload>
  | EnvelopeBase<'username:match', UsernameMatchPayload>
  | EnvelopeBase<'peer:avatar', PeerAvatarPayload>
  | EnvelopeBase<'peer:username', PeerUsernamePayload>
  | EnvelopeBase<'ping:drop', PingDropPayload>
  | EnvelopeBase<'ping:clear', PingClearPayload>
  | EnvelopeBase<'ping:ack', PingAckPayload>
  | EnvelopeBase<'latency:report', LatencyReportPayload>
  | EnvelopeBase<'hello', HelloPayload>
  | EnvelopeBase<'welcome', WelcomePayload>
  | EnvelopeBase<'error', ErrorPayload>;

export type MessageType = Message['type'];

export type PayloadFor<T extends MessageType> = Extract<Message, { type: T }>['payload'];

export type Envelope<T extends MessageType = MessageType> = Extract<Message, { type: T }>;

const MESSAGE_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  'pair:generate',
  'pair:code',
  'pair:redeem',
  'pair:established',
  'pair:invalid',
  'pair:broken',
  'pair:resume',
  'username:announce',
  'username:match',
  'peer:avatar',
  'peer:username',
  'ping:drop',
  'ping:clear',
  'ping:ack',
  'latency:report',
  'hello',
  'welcome',
  'error',
]);

export function createEnvelope<T extends MessageType>(
  type: T,
  payload: PayloadFor<T>,
  opts?: { groupId?: string },
): Envelope<T> {
  const envelope = {
    type,
    payload,
    messageId: randomUUID(),
    timestamp: Date.now(),
    ...(opts?.groupId !== undefined ? { groupId: opts.groupId } : {}),
  };
  return envelope as unknown as Envelope<T>;
}

export function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== 'string' || !MESSAGE_TYPES.has(candidate.type as MessageType)) {
    return false;
  }
  if (typeof candidate.messageId !== 'string') {
    return false;
  }
  if (typeof candidate.timestamp !== 'number') {
    return false;
  }
  if (!('payload' in candidate)) {
    return false;
  }
  if (
    'groupId' in candidate &&
    candidate.groupId !== undefined &&
    typeof candidate.groupId !== 'string'
  ) {
    return false;
  }
  if (candidate.type === 'peer:avatar') {
    const payload = candidate.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      return false;
    }
    if (typeof payload.imageBase64 !== 'string') {
      return false;
    }
    if (payload.imageBase64.length === 0 || payload.imageBase64.length > MAX_AVATAR_BASE64_LEN) {
      return false;
    }
  }
  if (candidate.type === 'peer:username') {
    const payload = candidate.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      return false;
    }
    if (typeof payload.robloxUsername !== 'string') {
      return false;
    }
  }
  return true;
}

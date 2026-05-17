import {
  MAX_AVATAR_BASE64_LEN,
  createEnvelope,
  isMessage,
  type Envelope,
  type Message,
  type PeerAvatarPayload,
  type PeerUsernamePayload,
} from '@pyng/shared';

export type Env = {
  PAIR_RELAY: DurableObjectNamespace;
};

type SocketAttachment = {
  sessionId: string;
  groupId: string | null;
  connectedAt: number;
};

type CodeRecord = {
  code: string;
  generatorSessionId: string;
  groupId: string;
  expiresAt: number;
};

type GroupRecord = {
  groupId: string;
  createdAt: number;
  revokedAt: number | null;
};

type CachedAvatar = {
  sessionId: string;
  imageBase64: string;
};

type CachedUsername = {
  sessionId: string;
  robloxUsername: string;
};

const SERVER_VERSION = 'cloudflare-0.1.0';
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_GENERATE_ATTEMPTS = 8;
const MAX_USERNAME_LEN = 25;

const codeKey = (code: string): string => `code:${code}`;
const groupKey = (groupId: string): string => `group:${groupId}`;
const pendingAvatarKey = (sessionId: string): string => `pending-avatar:${sessionId}`;
const pendingUsernameKey = (sessionId: string): string => `pending-username:${sessionId}`;
const groupAvatarKey = (groupId: string, sessionId: string): string =>
  `group-avatar:${groupId}:${sessionId}`;
const groupUsernameKey = (groupId: string, sessionId: string): string =>
  `group-username:${groupId}:${sessionId}`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return new Response('ok', {
        headers: { 'content-type': 'text/plain' },
      });
    }

    const upgrade = request.headers.get('upgrade');
    if (upgrade?.toLowerCase() === 'websocket') {
      const id = env.PAIR_RELAY.idFromName('global');
      return env.PAIR_RELAY.get(id).fetch(request);
    }

    return new Response('pyng relay', {
      headers: { 'content-type': 'text/plain' },
    });
  },
};

export class PairRelay {
  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      sessionId: crypto.randomUUID(),
      groupId: null,
      connectedAt: Date.now(),
    };

    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      this.sendError(socket, 'protocol_error', 'binary messages are not supported');
      socket.close(1003, 'binary_unsupported');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.sendError(socket, 'protocol_error', 'malformed json');
      socket.close(1002, 'protocol_error');
      return;
    }

    if (!isMessage(parsed)) {
      this.sendError(socket, 'protocol_error', 'invalid envelope');
      socket.close(1002, 'protocol_error');
      return;
    }

    await this.dispatch(socket, parsed);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = this.getAttachment(socket);
    await this.deleteCodesForSession(attachment.sessionId);
    await this.state.storage.delete(pendingAvatarKey(attachment.sessionId));
    await this.state.storage.delete(pendingUsernameKey(attachment.sessionId));
    if (attachment.groupId) {
      await this.state.storage.delete(groupAvatarKey(attachment.groupId, attachment.sessionId));
      await this.state.storage.delete(groupUsernameKey(attachment.groupId, attachment.sessionId));
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  private async dispatch(socket: WebSocket, message: Message): Promise<void> {
    const attachment = this.getAttachment(socket);

    switch (message.type) {
      case 'hello':
        this.send(
          socket,
          createEnvelope('welcome', {
            sessionId: attachment.sessionId,
            serverVersion: SERVER_VERSION,
          }),
        );
        return;

      case 'pair:generate':
        await this.handlePairGenerate(socket, attachment);
        return;

      case 'pair:redeem':
        await this.handlePairRedeem(socket, attachment, message);
        return;

      case 'pair:resume':
        await this.handlePairResume(socket, attachment, message);
        return;

      case 'pair:revoke':
        await this.handlePairRevoke(socket, attachment, message);
        return;

      case 'peer:avatar':
        await this.handlePeerAvatar(socket, attachment, message);
        return;

      case 'peer:username':
        await this.handlePeerUsername(socket, attachment, message);
        return;

      case 'ping:drop':
        this.send(
          socket,
          createEnvelope(
            'ping:ack',
            { messageId: message.messageId, receivedAt: Date.now() },
            attachment.groupId ? { groupId: attachment.groupId } : undefined,
          ),
        );
        this.broadcastToGroup(attachment, message);
        return;

      case 'ping:clear':
      case 'username:announce':
      case 'username:match':
        this.broadcastToGroup(attachment, message);
        return;

      case 'ping:ack':
      case 'pair:code':
      case 'pair:established':
      case 'pair:invalid':
      case 'pair:broken':
      case 'welcome':
      case 'error':
      case 'latency:report':
        return;
    }
  }

  private async handlePairGenerate(socket: WebSocket, attachment: SocketAttachment): Promise<void> {
    await this.cleanupExpiredCodes();
    await this.deleteCodesForSession(attachment.sessionId);

    const code = await this.generateUniqueCode();
    const groupId = crypto.randomUUID();
    const expiresAt = Date.now() + CODE_TTL_MS;
    const record: CodeRecord = {
      code,
      generatorSessionId: attachment.sessionId,
      groupId,
      expiresAt,
    };

    await this.state.storage.put(codeKey(code), record);
    this.send(socket, createEnvelope('pair:code', { code, expiresAt }));
  }

  private async handlePairRedeem(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: Envelope<'pair:redeem'>,
  ): Promise<void> {
    const code = message.payload.code.toUpperCase();
    const record = await this.state.storage.get<CodeRecord>(codeKey(code));
    if (!record) {
      this.send(socket, createEnvelope('pair:invalid', { reason: 'not_found' }));
      return;
    }
    if (record.expiresAt < Date.now()) {
      await this.state.storage.delete(codeKey(code));
      this.send(socket, createEnvelope('pair:invalid', { reason: 'expired' }));
      return;
    }
    if (record.generatorSessionId === attachment.sessionId || attachment.groupId !== null) {
      this.send(socket, createEnvelope('pair:invalid', { reason: 'already_used' }));
      return;
    }

    const group: GroupRecord = {
      groupId: record.groupId,
      createdAt: Date.now(),
      revokedAt: null,
    };
    await this.state.storage.put(groupKey(record.groupId), group);
    await this.state.storage.delete(codeKey(code));
    await this.attachSocketToGroup(socket, attachment, record.groupId);

    const generatorSocket = this.findSocketBySession(record.generatorSessionId);
    if (generatorSocket) {
      await this.attachSocketToGroup(
        generatorSocket,
        this.getAttachment(generatorSocket),
        record.groupId,
      );
    }

    this.sendEstablished(socket, record.groupId);
    if (generatorSocket) {
      this.sendEstablished(generatorSocket, record.groupId);
    }
    await this.drainPendingPeerState(record.groupId, [
      record.generatorSessionId,
      attachment.sessionId,
    ]);
    await this.replayPeerState(record.groupId);
  }

  private async handlePairResume(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: Envelope<'pair:resume'>,
  ): Promise<void> {
    const group = await this.state.storage.get<GroupRecord>(groupKey(message.payload.groupId));
    if (!group) {
      this.send(socket, createEnvelope('pair:invalid', { reason: 'not_found' }));
      return;
    }
    if (group.revokedAt !== null) {
      this.send(socket, createEnvelope('pair:invalid', { reason: 'expired' }));
      return;
    }

    await this.attachSocketToGroup(socket, attachment, group.groupId);
    this.sendEstablished(socket, group.groupId);
    await this.replayPeerState(group.groupId);
  }

  private async handlePairRevoke(
    _socket: WebSocket,
    attachment: SocketAttachment,
    message: Envelope<'pair:revoke'>,
  ): Promise<void> {
    const groupId = attachment.groupId ?? message.payload.groupId;
    if (groupId !== message.payload.groupId) return;

    const group = await this.state.storage.get<GroupRecord>(groupKey(groupId));
    if (group) {
      await this.state.storage.put(groupKey(groupId), { ...group, revokedAt: Date.now() });
    }

    const broken = createEnvelope('pair:broken', { reason: 'explicit' }, { groupId });
    for (const peer of this.socketsForGroup(groupId)) {
      this.send(peer, broken);
      const peerAttachment = this.getAttachment(peer);
      this.setAttachment(peer, { ...peerAttachment, groupId: null });
    }
  }

  private async handlePeerAvatar(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: Envelope<'peer:avatar'>,
  ): Promise<void> {
    if (message.payload.sessionId !== attachment.sessionId) {
      this.sendError(
        socket,
        'avatar_identity_mismatch',
        'peer:avatar payload.sessionId must match the publishing session',
      );
      return;
    }
    if (
      message.payload.imageBase64.length === 0 ||
      message.payload.imageBase64.length > MAX_AVATAR_BASE64_LEN
    ) {
      return;
    }

    if (!attachment.groupId) {
      await this.state.storage.put(pendingAvatarKey(attachment.sessionId), message.payload);
      return;
    }

    await this.state.storage.put(
      groupAvatarKey(attachment.groupId, attachment.sessionId),
      message.payload,
    );
    this.broadcastToGroup(attachment, message);
  }

  private async handlePeerUsername(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: Envelope<'peer:username'>,
  ): Promise<void> {
    if (message.payload.sessionId !== attachment.sessionId) {
      this.sendError(
        socket,
        'username_identity_mismatch',
        'peer:username payload.sessionId must match the publishing session',
      );
      return;
    }
    if (
      message.payload.robloxUsername.length === 0 ||
      message.payload.robloxUsername.length > MAX_USERNAME_LEN
    ) {
      return;
    }

    if (!attachment.groupId) {
      await this.state.storage.put(pendingUsernameKey(attachment.sessionId), message.payload);
      return;
    }

    await this.state.storage.put(
      groupUsernameKey(attachment.groupId, attachment.sessionId),
      message.payload,
    );
    this.broadcastToGroup(attachment, message);
  }

  private async attachSocketToGroup(
    socket: WebSocket,
    attachment: SocketAttachment,
    groupId: string,
  ): Promise<void> {
    this.setAttachment(socket, { ...attachment, groupId });
  }

  private sendEstablished(socket: WebSocket, groupId: string): void {
    this.send(socket, createEnvelope('pair:established', { groupId }, { groupId }));
  }

  private async drainPendingPeerState(groupId: string, sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const pendingAvatar = await this.state.storage.get<PeerAvatarPayload>(
        pendingAvatarKey(sessionId),
      );
      if (pendingAvatar) {
        await this.state.storage.put(groupAvatarKey(groupId, sessionId), pendingAvatar);
        await this.state.storage.delete(pendingAvatarKey(sessionId));
      }

      const pendingUsername = await this.state.storage.get<PeerUsernamePayload>(
        pendingUsernameKey(sessionId),
      );
      if (pendingUsername) {
        await this.state.storage.put(groupUsernameKey(groupId, sessionId), pendingUsername);
        await this.state.storage.delete(pendingUsernameKey(sessionId));
      }
    }
  }

  private async replayPeerState(groupId: string): Promise<void> {
    const members = this.socketsForGroup(groupId);
    const avatars = await this.state.storage.list<CachedAvatar>({
      prefix: `group-avatar:${groupId}:`,
    });
    for (const avatar of avatars.values()) {
      const envelope = createEnvelope(
        'peer:avatar',
        { sessionId: avatar.sessionId, imageBase64: avatar.imageBase64 },
        { groupId },
      );
      for (const member of members) {
        if (this.getAttachment(member).sessionId !== avatar.sessionId) {
          this.send(member, envelope);
        }
      }
    }

    const usernames = await this.state.storage.list<CachedUsername>({
      prefix: `group-username:${groupId}:`,
    });
    for (const username of usernames.values()) {
      const envelope = createEnvelope(
        'peer:username',
        { sessionId: username.sessionId, robloxUsername: username.robloxUsername },
        { groupId },
      );
      for (const member of members) {
        if (this.getAttachment(member).sessionId !== username.sessionId) {
          this.send(member, envelope);
        }
      }
    }
  }

  private broadcastToGroup(sender: SocketAttachment, message: Message): void {
    if (!sender.groupId) return;
    const serialized = JSON.stringify({ ...message, groupId: sender.groupId });
    for (const socket of this.socketsForGroup(sender.groupId)) {
      if (this.getAttachment(socket).sessionId !== sender.sessionId) {
        socket.send(serialized);
      }
    }
  }

  private socketsForGroup(groupId: string): WebSocket[] {
    return this.state
      .getWebSockets()
      .filter((socket) => this.getAttachment(socket).groupId === groupId);
  }

  private findSocketBySession(sessionId: string): WebSocket | null {
    return (
      this.state
        .getWebSockets()
        .find((socket) => this.getAttachment(socket).sessionId === sessionId) ?? null
    );
  }

  private getAttachment(socket: WebSocket): SocketAttachment {
    const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
    if (attachment) return attachment;

    const fallback: SocketAttachment = {
      sessionId: crypto.randomUUID(),
      groupId: null,
      connectedAt: Date.now(),
    };
    this.setAttachment(socket, fallback);
    return fallback;
  }

  private setAttachment(socket: WebSocket, attachment: SocketAttachment): void {
    socket.serializeAttachment(attachment);
  }

  private send(socket: WebSocket, message: Message): void {
    socket.send(JSON.stringify(message));
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, createEnvelope('error', { code, message }));
  }

  private async generateUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
      const code = generateCode();
      if (!(await this.state.storage.get(codeKey(code)))) {
        return code;
      }
    }
    throw new Error('code_generation_failed');
  }

  private async cleanupExpiredCodes(): Promise<void> {
    const now = Date.now();
    const codes = await this.state.storage.list<CodeRecord>({ prefix: 'code:' });
    const deletes: string[] = [];
    for (const [key, record] of codes) {
      if (record.expiresAt < now) deletes.push(key);
    }
    if (deletes.length > 0) {
      await this.state.storage.delete(deletes);
    }
  }

  private async deleteCodesForSession(sessionId: string): Promise<void> {
    const codes = await this.state.storage.list<CodeRecord>({ prefix: 'code:' });
    const deletes: string[] = [];
    for (const [key, record] of codes) {
      if (record.generatorSessionId === sessionId) deletes.push(key);
    }
    if (deletes.length > 0) {
      await this.state.storage.delete(deletes);
    }
  }
}

function generateCode(): string {
  const values = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(values);
  let code = '';
  for (const value of values) {
    code += CHARSET[value % CHARSET.length];
  }
  return code;
}

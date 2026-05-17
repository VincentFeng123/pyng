import type { WebSocket } from 'ws';
import { createEnvelope, type Envelope, type Message, type MessageType } from '@pyng/shared';
import {
  createCode,
  dropSession,
  getGroupAvatars,
  getGroupForSession,
  getGroupMembers,
  getGroupUsernames,
  redeemCode,
  resumeGroup,
  setGroupAvatar,
  setGroupUsername,
  setPendingAvatar,
  setPendingUsername,
  touchGroup,
} from './groups.js';

export const SERVER_VERSION = '0.0.0';

const sockets = new Map<string, WebSocket>();

export function registerSocket(sessionId: string, socket: WebSocket): void {
  sockets.set(sessionId, socket);
}

export function unregisterSocket(sessionId: string): void {
  sockets.delete(sessionId);
  dropSession(sessionId);
}

export function socketCount(): number {
  return sockets.size;
}

export function _resetSocketsForTests(): void {
  sockets.clear();
}

function send<T extends MessageType>(socket: WebSocket, envelope: Envelope<T>): void {
  socket.send(JSON.stringify(envelope));
}

export function handleHello(
  socket: WebSocket,
  sessionId: string,
  _envelope: Envelope<'hello'>,
): void {
  const reply = createEnvelope('welcome', {
    sessionId,
    serverVersion: SERVER_VERSION,
  });
  send(socket, reply);
}

export function handlePairGenerate(socket: WebSocket, sessionId: string): void {
  const { code, expiresAt } = createCode(sessionId);
  const reply = createEnvelope('pair:code', { code, expiresAt });
  send(socket, reply);
}

export function handlePairRedeem(
  socket: WebSocket,
  sessionId: string,
  envelope: Envelope<'pair:redeem'>,
): { ok: boolean; groupId?: string } {
  const result = redeemCode(envelope.payload.code, sessionId);
  if (!result.ok) {
    const reply = createEnvelope('pair:invalid', { reason: result.reason });
    send(socket, reply);
    return { ok: false };
  }
  const established = createEnvelope(
    'pair:established',
    { groupId: result.groupId },
    { groupId: result.groupId },
  );
  send(socket, established);
  const generatorSocket = sockets.get(result.generatorSessionId);
  if (generatorSocket) {
    send(generatorSocket, established);
  }
  replayAvatars(result.groupId);
  replayUsernames(result.groupId);
  return { ok: true, groupId: result.groupId };
}

export function handlePairResume(
  socket: WebSocket,
  sessionId: string,
  envelope: Envelope<'pair:resume'>,
): { ok: boolean; groupId?: string } {
  const result = resumeGroup(envelope.payload.groupId, sessionId);
  if (!result.ok) {
    const reply = createEnvelope('pair:invalid', { reason: result.reason });
    send(socket, reply);
    return { ok: false };
  }
  const established = createEnvelope(
    'pair:established',
    { groupId: result.groupId },
    { groupId: result.groupId },
  );
  send(socket, established);
  replayAvatars(result.groupId);
  replayUsernames(result.groupId);
  return { ok: true, groupId: result.groupId };
}

function replayAvatars(groupId: string): void {
  // After pair:established, push every cached avatar to every OTHER group member.
  // Handles the race where one client publishes peer:avatar before the other joins.
  const members = getGroupMembers(groupId);
  if (!members) return;
  for (const { sessionId: ownerSessionId, imageBase64 } of getGroupAvatars(groupId)) {
    const envelope = createEnvelope(
      'peer:avatar',
      { sessionId: ownerSessionId, imageBase64 },
      { groupId },
    );
    for (const member of members) {
      if (member === ownerSessionId) continue;
      const memberSocket = sockets.get(member);
      if (memberSocket) {
        send(memberSocket, envelope);
      }
    }
  }
}

function replayUsernames(groupId: string): void {
  const members = getGroupMembers(groupId);
  if (!members) return;
  for (const { sessionId: ownerSessionId, robloxUsername } of getGroupUsernames(groupId)) {
    const envelope = createEnvelope(
      'peer:username',
      { sessionId: ownerSessionId, robloxUsername },
      { groupId },
    );
    for (const member of members) {
      if (member === ownerSessionId) continue;
      const memberSocket = sockets.get(member);
      if (memberSocket) {
        send(memberSocket, envelope);
      }
    }
  }
}

function broadcastToGroup(
  senderSessionId: string,
  message: Message,
): { groupId: string | null; recipientCount: number } {
  const groupId = getGroupForSession(senderSessionId);
  if (!groupId) {
    return { groupId: null, recipientCount: 0 };
  }
  const members = getGroupMembers(groupId);
  if (!members) {
    return { groupId, recipientCount: 0 };
  }
  const serialized = JSON.stringify(message);
  let recipientCount = 0;
  for (const member of members) {
    if (member === senderSessionId) {
      continue;
    }
    const peerSocket = sockets.get(member);
    if (peerSocket) {
      peerSocket.send(serialized);
      recipientCount++;
    }
  }
  touchGroup(groupId);
  return { groupId, recipientCount };
}

export function dispatch(
  socket: WebSocket,
  sessionId: string,
  message: Message,
  log: (event: Record<string, unknown>) => void,
): void {
  switch (message.type) {
    case 'hello':
      handleHello(socket, sessionId, message);
      log({ event: 'hello', sessionId });
      return;
    case 'pair:generate':
      handlePairGenerate(socket, sessionId);
      log({ event: 'pair:generate', sessionId });
      return;
    case 'pair:redeem': {
      const result = handlePairRedeem(socket, sessionId, message);
      log({ event: 'pair:redeem', sessionId, ok: result.ok, groupId: result.groupId });
      return;
    }
    case 'pair:resume': {
      const result = handlePairResume(socket, sessionId, message);
      log({ event: 'pair:resume', sessionId, ok: result.ok, groupId: result.groupId });
      return;
    }
    case 'ping:drop':
    case 'ping:clear':
    case 'ping:ack': {
      // ping:drop carries a client-set `senderSessionId` in payload for avatar attribution.
      // The server NEVER trusts that field for routing — routing is keyed off the socket-bound
      // sessionId here. This matters for v2 hardening (a client could lie about senderSessionId).
      let ackSent = false;
      if (message.type === 'ping:drop') {
        // Send a server-generated ping:ack back to the sender so the client can measure
        // round-trip latency. The ack carries server-side receivedAt (we never trust the
        // payload for timestamps either). Sender-only — peers ignore this.
        const senderGroupId = getGroupForSession(sessionId);
        const ack = createEnvelope(
          'ping:ack',
          { messageId: message.messageId, receivedAt: Date.now() },
          senderGroupId !== null ? { groupId: senderGroupId } : undefined,
        );
        socket.send(JSON.stringify(ack));
        ackSent = true;
      }
      const { groupId, recipientCount } = broadcastToGroup(sessionId, message);
      const claimedSender =
        message.type === 'ping:drop' ? message.payload.senderSessionId : undefined;
      log({
        event: message.type,
        sessionId,
        groupId,
        recipientCount,
        claimedSender,
        ackSent: ackSent || undefined,
      });
      return;
    }
    case 'peer:avatar': {
      const result = handlePeerAvatar(socket, sessionId, message);
      log({
        event: 'peer:avatar',
        sessionId,
        groupId: result.groupId,
        recipientCount: result.recipientCount,
        rejected: result.rejected,
        pended: result.pended,
      });
      return;
    }
    case 'peer:username': {
      const result = handlePeerUsername(socket, sessionId, message);
      log({
        event: 'peer:username',
        sessionId,
        groupId: result.groupId ?? null,
        recipientCount: result.recipientCount,
        rejected: result.rejected,
        pended: result.pended,
      });
      return;
    }
    case 'username:announce': {
      const { groupId, recipientCount } = broadcastToGroup(sessionId, message);
      log({
        event: 'username:announce',
        sessionId,
        groupId,
        recipientCount,
        detectedUsername: (message as Envelope<'username:announce'>).payload.detectedUsername,
      });
      return;
    }
    case 'username:match': {
      const { groupId, recipientCount } = broadcastToGroup(sessionId, message);
      log({
        event: 'username:match',
        sessionId,
        groupId,
        recipientCount,
        matched: (message as Envelope<'username:match'>).payload.matched,
      });
      return;
    }
    default:
      log({ event: 'ignored', sessionId, type: message.type });
      return;
  }
}

export function handlePeerAvatar(
  socket: WebSocket,
  sessionId: string,
  message: Envelope<'peer:avatar'>,
): {
  rejected: 'identity_mismatch' | 'cache_rejected' | null;
  groupId: string | null;
  recipientCount: number;
  pended: boolean;
} {
  // Hard rule: a client can ONLY publish its own avatar. The server is the trust boundary;
  // payload.sessionId must match the socket-bound sessionId.
  if (message.payload.sessionId !== sessionId) {
    const err = createEnvelope('error', {
      code: 'avatar_identity_mismatch',
      message: 'peer:avatar payload.sessionId must match the publishing session',
    });
    send(socket, err);
    return { rejected: 'identity_mismatch', groupId: null, recipientCount: 0, pended: false };
  }
  const groupId = getGroupForSession(sessionId);
  if (!groupId) {
    // No group yet (e.g. generator publishes between generate and redeem).
    // Pend the avatar; redeemCode will drain pending entries into the new group.
    const pended = setPendingAvatar(sessionId, message.payload.imageBase64);
    return {
      rejected: pended ? null : 'cache_rejected',
      groupId: null,
      recipientCount: 0,
      pended,
    };
  }
  const cached = setGroupAvatar(groupId, sessionId, message.payload.imageBase64);
  if (!cached) {
    return { rejected: 'cache_rejected', groupId, recipientCount: 0, pended: false };
  }
  const { recipientCount } = broadcastToGroup(sessionId, message);
  return { rejected: null, groupId, recipientCount, pended: false };
}

export function handlePeerUsername(
  socket: WebSocket,
  sessionId: string,
  message: Envelope<'peer:username'>,
): {
  rejected: 'identity_mismatch' | null;
  groupId: string | null;
  recipientCount: number;
  pended: boolean;
} {
  if (message.payload.sessionId !== sessionId) {
    const err = createEnvelope('error', {
      code: 'username_identity_mismatch',
      message: 'peer:username payload.sessionId must match the publishing session',
    });
    send(socket, err);
    return { rejected: 'identity_mismatch', groupId: null, recipientCount: 0, pended: false };
  }
  const groupId = getGroupForSession(sessionId);
  if (!groupId) {
    setPendingUsername(sessionId, message.payload.robloxUsername);
    return { rejected: null, groupId: null, recipientCount: 0, pended: true };
  }
  setGroupUsername(groupId, sessionId, message.payload.robloxUsername);
  const { recipientCount } = broadcastToGroup(sessionId, message);
  return { rejected: null, groupId, recipientCount, pended: false };
}

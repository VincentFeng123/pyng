import { randomUUID } from 'node:crypto';
import { MAX_AVATAR_BASE64_LEN } from '@pyng/shared';

const MAX_USERNAME_LEN = 25;

export const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const GROUP_GRACE_MS = 5 * 60 * 1000;
const MAX_GENERATE_ATTEMPTS = 5;

export type CodeRecord = {
  code: string;
  generatorSessionId: string;
  expiresAt: number;
};

export type GroupRecord = {
  groupId: string;
  sessionIds: Set<string>;
  avatars: Map<string, string>;
  usernames: Map<string, string>;
  createdAt: number;
  lastActivityAt: number;
};

export type RedeemResult =
  | { ok: true; groupId: string; generatorSessionId: string }
  | { ok: false; reason: 'expired' | 'not_found' | 'already_used' };

export type ResumeResult =
  | { ok: true; groupId: string }
  | { ok: false; reason: 'expired' | 'not_found' | 'already_used' };

const codes = new Map<string, CodeRecord>();
const groups = new Map<string, GroupRecord>();
const sessionToGroup = new Map<string, string>();
// Avatars published before the session joined a group. Drained into the group's
// avatars map when redeemCode creates the group containing that session.
const pendingAvatars = new Map<string, string>();
// Usernames published before the session joined a group — same drain pattern as avatars.
const pendingUsernames = new Map<string, string>();

export function generateCode(): string {
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    let result = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      result += CHARSET[Math.floor(Math.random() * CHARSET.length)];
    }
    if (!codes.has(result)) {
      return result;
    }
  }
  throw new Error('code_generation_failed');
}

export function createCode(sessionId: string): { code: string; expiresAt: number } {
  for (const [existingCode, rec] of codes) {
    if (rec.generatorSessionId === sessionId) {
      codes.delete(existingCode);
    }
  }
  const code = generateCode();
  const expiresAt = Date.now() + CODE_TTL_MS;
  codes.set(code, { code, generatorSessionId: sessionId, expiresAt });
  return { code, expiresAt };
}

export function redeemCode(code: string, redeemerSessionId: string): RedeemResult {
  const rec = codes.get(code);
  if (!rec) {
    return { ok: false, reason: 'not_found' };
  }
  if (rec.expiresAt < Date.now()) {
    codes.delete(code);
    return { ok: false, reason: 'expired' };
  }
  if (rec.generatorSessionId === redeemerSessionId) {
    return { ok: false, reason: 'not_found' };
  }
  if (sessionToGroup.has(redeemerSessionId) || sessionToGroup.has(rec.generatorSessionId)) {
    return { ok: false, reason: 'already_used' };
  }
  const groupId = randomUUID();
  const now = Date.now();
  const avatars = new Map<string, string>();
  for (const sid of [rec.generatorSessionId, redeemerSessionId]) {
    const pending = pendingAvatars.get(sid);
    if (pending !== undefined) {
      avatars.set(sid, pending);
      pendingAvatars.delete(sid);
    }
  }
  const usernames = new Map<string, string>();
  for (const sid of [rec.generatorSessionId, redeemerSessionId]) {
    const pendingUsername = pendingUsernames.get(sid);
    if (pendingUsername !== undefined) {
      usernames.set(sid, pendingUsername);
      pendingUsernames.delete(sid);
    }
  }
  const record: GroupRecord = {
    groupId,
    sessionIds: new Set([rec.generatorSessionId, redeemerSessionId]),
    avatars,
    usernames,
    createdAt: now,
    lastActivityAt: now,
  };
  groups.set(groupId, record);
  sessionToGroup.set(rec.generatorSessionId, groupId);
  sessionToGroup.set(redeemerSessionId, groupId);
  codes.delete(code);
  return { ok: true, groupId, generatorSessionId: rec.generatorSessionId };
}

export function resumeGroup(groupId: string, sessionId: string): ResumeResult {
  const group = groups.get(groupId);
  if (!group) {
    return { ok: false, reason: 'not_found' };
  }
  if (Date.now() - group.lastActivityAt > GROUP_GRACE_MS) {
    groups.delete(groupId);
    for (const sid of group.sessionIds) {
      sessionToGroup.delete(sid);
    }
    return { ok: false, reason: 'expired' };
  }
  const existingGroup = sessionToGroup.get(sessionId);
  if (existingGroup && existingGroup !== groupId) {
    return { ok: false, reason: 'already_used' };
  }
  if (!group.sessionIds.has(sessionId) && group.sessionIds.size >= 2) {
    return { ok: false, reason: 'already_used' };
  }
  group.sessionIds.add(sessionId);
  sessionToGroup.set(sessionId, groupId);
  group.lastActivityAt = Date.now();
  return { ok: true, groupId };
}

export function getGroupMembers(groupId: string): string[] | null {
  const group = groups.get(groupId);
  if (!group) {
    return null;
  }
  return [...group.sessionIds];
}

export function getGroupForSession(sessionId: string): string | null {
  return sessionToGroup.get(sessionId) ?? null;
}

export function touchGroup(groupId: string): void {
  const group = groups.get(groupId);
  if (group) {
    group.lastActivityAt = Date.now();
  }
}

export function setGroupAvatar(groupId: string, sessionId: string, imageBase64: string): boolean {
  const group = groups.get(groupId);
  if (!group) {
    return false;
  }
  if (imageBase64.length === 0 || imageBase64.length > MAX_AVATAR_BASE64_LEN) {
    return false;
  }
  group.avatars.set(sessionId, imageBase64);
  group.lastActivityAt = Date.now();
  return true;
}

export function setPendingAvatar(sessionId: string, imageBase64: string): boolean {
  if (imageBase64.length === 0 || imageBase64.length > MAX_AVATAR_BASE64_LEN) {
    return false;
  }
  pendingAvatars.set(sessionId, imageBase64);
  return true;
}

export function getGroupAvatars(groupId: string): { sessionId: string; imageBase64: string }[] {
  const group = groups.get(groupId);
  if (!group) {
    return [];
  }
  return [...group.avatars.entries()].map(([sessionId, imageBase64]) => ({
    sessionId,
    imageBase64,
  }));
}

export function setGroupUsername(
  groupId: string,
  sessionId: string,
  robloxUsername: string,
): boolean {
  const group = groups.get(groupId);
  if (!group) {
    return false;
  }
  if (robloxUsername.length === 0 || robloxUsername.length > MAX_USERNAME_LEN) {
    return false;
  }
  group.usernames.set(sessionId, robloxUsername);
  group.lastActivityAt = Date.now();
  return true;
}

export function setPendingUsername(sessionId: string, robloxUsername: string): boolean {
  if (robloxUsername.length === 0 || robloxUsername.length > MAX_USERNAME_LEN) {
    return false;
  }
  pendingUsernames.set(sessionId, robloxUsername);
  return true;
}

export function getGroupUsernames(
  groupId: string,
): { sessionId: string; robloxUsername: string }[] {
  const group = groups.get(groupId);
  if (!group) {
    return [];
  }
  return [...group.usernames.entries()].map(([sessionId, robloxUsername]) => ({
    sessionId,
    robloxUsername,
  }));
}

export function dropSession(sessionId: string): void {
  for (const [code, rec] of codes) {
    if (rec.generatorSessionId === sessionId) {
      codes.delete(code);
    }
  }
  pendingAvatars.delete(sessionId);
  pendingUsernames.delete(sessionId);
  const groupId = sessionToGroup.get(sessionId);
  if (groupId !== undefined) {
    sessionToGroup.delete(sessionId);
    const group = groups.get(groupId);
    if (group) {
      group.sessionIds.delete(sessionId);
      group.avatars.delete(sessionId);
      group.usernames.delete(sessionId);
      group.lastActivityAt = Date.now();
    }
  }
}

export function cleanupExpiredCodes(): number {
  const now = Date.now();
  let removed = 0;
  for (const [code, rec] of codes) {
    if (rec.expiresAt < now) {
      codes.delete(code);
      removed++;
    }
  }
  return removed;
}

export function cleanupExpiredGroups(): number {
  const now = Date.now();
  let removed = 0;
  for (const [groupId, group] of groups) {
    if (group.sessionIds.size < 2 && now - group.lastActivityAt > GROUP_GRACE_MS) {
      groups.delete(groupId);
      for (const sid of group.sessionIds) {
        sessionToGroup.delete(sid);
      }
      removed++;
    }
  }
  return removed;
}

export function _resetStateForTests(): void {
  codes.clear();
  groups.clear();
  sessionToGroup.clear();
  pendingAvatars.clear();
  pendingUsernames.clear();
}

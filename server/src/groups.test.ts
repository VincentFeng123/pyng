import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCode,
  redeemCode,
  dropSession,
  setPendingAvatar,
  getGroupAvatars,
  setGroupUsername,
  setPendingUsername,
  getGroupUsernames,
  _resetStateForTests,
} from './groups.js';

function setupPair(): { groupId: string; genSession: string; redeemSession: string } {
  const genSession = 'session-gen';
  const redeemSession = 'session-redeem';
  const { code } = createCode(genSession);
  const result = redeemCode(code, redeemSession);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('setup failed');
  return { groupId: result.groupId, genSession, redeemSession };
}

describe('groups — username caching', () => {
  beforeEach(() => {
    _resetStateForTests();
  });

  it('setGroupUsername with valid name + valid group returns true and stores the entry', () => {
    const { groupId, genSession } = setupPair();
    const ok = setGroupUsername(groupId, genSession, 'PlayerOne');
    assert.equal(ok, true);
    const entries = getGroupUsernames(groupId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.sessionId, genSession);
    assert.equal(entries[0]!.robloxUsername, 'PlayerOne');
  });

  it('setGroupUsername with empty name returns false and leaves group.usernames unchanged', () => {
    const { groupId, genSession } = setupPair();
    const ok = setGroupUsername(groupId, genSession, '');
    assert.equal(ok, false);
    assert.equal(getGroupUsernames(groupId).length, 0);
  });

  it('setGroupUsername with name longer than 25 chars returns false and leaves group.usernames unchanged', () => {
    const { groupId, genSession } = setupPair();
    const tooLong = 'A'.repeat(26);
    const ok = setGroupUsername(groupId, genSession, tooLong);
    assert.equal(ok, false);
    assert.equal(getGroupUsernames(groupId).length, 0);
  });

  it('setGroupUsername with name exactly 25 chars returns true', () => {
    const { groupId, genSession } = setupPair();
    const exactly25 = 'B'.repeat(25);
    const ok = setGroupUsername(groupId, genSession, exactly25);
    assert.equal(ok, true);
    assert.equal(getGroupUsernames(groupId).length, 1);
  });

  it('setGroupUsername for unknown groupId returns false', () => {
    const ok = setGroupUsername('no-such-group', 'any-session', 'ValidName');
    assert.equal(ok, false);
  });

  it('setPendingUsername with valid name returns true and is stored', () => {
    const ok = setPendingUsername('orphan-session', 'CoolPlayer');
    assert.equal(ok, true);
  });

  it('setPendingUsername with empty name returns false', () => {
    const ok = setPendingUsername('orphan-session', '');
    assert.equal(ok, false);
  });

  it('setPendingUsername with name >25 chars returns false', () => {
    const ok = setPendingUsername('orphan-session', 'X'.repeat(26));
    assert.equal(ok, false);
  });

  it('redeemCode drains pendingUsernames for the redeemer into the new group', () => {
    const genSession = 'gen-drain';
    const redeemSession = 'redeem-drain';
    setPendingUsername(redeemSession, 'BobPlayer');
    const { code } = createCode(genSession);
    const result = redeemCode(code, redeemSession);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    const entries = getGroupUsernames(result.groupId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.sessionId, redeemSession);
    assert.equal(entries[0]!.robloxUsername, 'BobPlayer');
  });

  it('redeemCode drains pendingUsernames for the generator into the new group', () => {
    const genSession = 'gen-drain2';
    const redeemSession = 'redeem-drain2';
    setPendingUsername(genSession, 'AlicePlayer');
    const { code } = createCode(genSession);
    const result = redeemCode(code, redeemSession);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    const entries = getGroupUsernames(result.groupId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.sessionId, genSession);
    assert.equal(entries[0]!.robloxUsername, 'AlicePlayer');
  });

  it('dropSession clears both pending and group username entries', () => {
    const { groupId, genSession, redeemSession } = setupPair();
    setGroupUsername(groupId, genSession, 'Alice');
    setGroupUsername(groupId, redeemSession, 'Bob');
    setPendingUsername('orphan', 'Ghost');

    dropSession(genSession);
    const entries = getGroupUsernames(groupId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.sessionId, redeemSession);

    dropSession('orphan');
    // After orphan drop, pending is cleared — verify by trying a new pair using orphan as redeemer
    const gen2 = 'gen2-drop-test';
    const { code } = createCode(gen2);
    const result = redeemCode(code, 'orphan');
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    // orphan had pending username deleted by dropSession, so group should be empty
    assert.equal(getGroupUsernames(result.groupId).length, 0);
  });

  it('getGroupUsernames returns all entries for a two-member group', () => {
    const { groupId, genSession, redeemSession } = setupPair();
    setGroupUsername(groupId, genSession, 'Alice');
    setGroupUsername(groupId, redeemSession, 'Bob');
    const entries = getGroupUsernames(groupId);
    assert.equal(entries.length, 2);
    const sessionIds = entries.map((e) => e.sessionId).sort();
    assert.deepEqual(sessionIds, [genSession, redeemSession].sort());
  });

  it('getGroupUsernames returns empty array for unknown groupId', () => {
    assert.deepEqual(getGroupUsernames('nonexistent'), []);
  });

  it('username caching mirrors avatar caching: both drain correctly in same redemption', () => {
    const genSession = 'gen-both';
    const redeemSession = 'redeem-both';
    setPendingAvatar(genSession, 'aW1hZ2U=');
    setPendingUsername(genSession, 'AlicePlayer');
    const { code } = createCode(genSession);
    const result = redeemCode(code, redeemSession);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('setup failed');
    const avatars = getGroupAvatars(result.groupId);
    assert.equal(avatars.length, 1);
    assert.equal(avatars[0]!.sessionId, genSession);
    const usernames = getGroupUsernames(result.groupId);
    assert.equal(usernames.length, 1);
    assert.equal(usernames[0]!.sessionId, genSession);
    assert.equal(usernames[0]!.robloxUsername, 'AlicePlayer');
  });
});

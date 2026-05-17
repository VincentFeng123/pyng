import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UsernameMatcher } from './matcher.js';
import type { MatcherState } from './matcher.js';
import type { WsClient } from '../net/wsClient.js';
import { createEnvelope } from '@pyng/shared';

type MessageHandler = (msg: ReturnType<typeof createEnvelope>) => void;

function makeMockClient() {
  let registeredHandler: MessageHandler | null = null;
  const sentMessages: Array<{ type: string; payload: unknown; groupId?: string }> = [];

  const client = {
    onMessage: mock.fn((handler: MessageHandler) => {
      registeredHandler = handler;
      return () => {
        registeredHandler = null;
      };
    }),
    send: mock.fn((type: string, payload: unknown, opts?: { groupId?: string }) => {
      sentMessages.push({ type, payload, groupId: opts?.groupId });
    }),
    sendEnvelope: mock.fn(),
    dispatch: (msg: ReturnType<typeof createEnvelope>) => {
      registeredHandler?.(msg);
    },
  } as unknown as WsClient & {
    send: ReturnType<typeof mock.fn>;
    sendEnvelope: ReturnType<typeof mock.fn>;
    onMessage: ReturnType<typeof mock.fn>;
    dispatch: (msg: ReturnType<typeof createEnvelope>) => void;
    _sent: typeof sentMessages;
  };

  (client as unknown as { _sent: typeof sentMessages })._sent = sentMessages;

  return client;
}

function makeAnnounce(detectedUsername: string) {
  return createEnvelope('username:announce', {
    detectedUsername,
    confidence: 0.95,
    game: 'phantom-forces',
  });
}

function makeMatch(matched: boolean) {
  return createEnvelope('username:match', { matched });
}

describe('UsernameMatcher', () => {
  let client: ReturnType<typeof makeMockClient>;
  let stateChanges: MatcherState[];
  let ownUsername: string;
  let groupId: string | null;
  let matcher: UsernameMatcher;

  beforeEach(() => {
    client = makeMockClient();
    stateChanges = [];
    ownUsername = 'TestPlayer';
    groupId = 'grp-abc123';

    matcher = new UsernameMatcher({
      client: client as unknown as WsClient,
      getOwnUsername: () => ownUsername,
      getGroupId: () => groupId,
      onMatchStateChange: (s) => stateChanges.push(s),
    });

    matcher.start();
  });

  it('test 1: announce matching own name from idle → spectated, sends match:true, fires callback', () => {
    const sent = (client as unknown as { _sent: Array<{ type: string; payload: unknown }> })._sent;
    client.dispatch(makeAnnounce('TestPlayer'));

    assert.equal(matcher.getState(), 'spectated');
    assert.deepEqual(stateChanges, ['spectated']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.type, 'username:match');
    assert.deepEqual(sent[0]!.payload, { matched: true });
  });

  it('test 2: second matching announce while spectated → no new send, no new callback', () => {
    const sent = (client as unknown as { _sent: Array<{ type: string; payload: unknown }> })._sent;
    client.dispatch(makeAnnounce('TestPlayer'));
    // second announce while already spectated
    client.dispatch(makeAnnounce('TestPlayer'));

    assert.equal(matcher.getState(), 'spectated');
    assert.deepEqual(stateChanges, ['spectated']); // only one fire
    assert.equal(sent.length, 1); // only one send
  });

  it('test 3: non-matching announce from idle → no transition, no send, no callback', () => {
    const sent = (client as unknown as { _sent: Array<{ type: string; payload: unknown }> })._sent;
    client.dispatch(makeAnnounce('SomeOtherPlayer'));

    assert.equal(matcher.getState(), 'idle');
    assert.deepEqual(stateChanges, []);
    assert.equal(sent.length, 0);
  });

  it('test 4: non-matching announce from spectated → idle, sends match:false, fires callback', () => {
    const sent = (client as unknown as { _sent: Array<{ type: string; payload: unknown }> })._sent;
    // First get into spectated state
    client.dispatch(makeAnnounce('TestPlayer'));
    assert.equal(matcher.getState(), 'spectated');

    // Now peer OCR loses us
    client.dispatch(makeAnnounce('SomeOtherPlayer'));

    assert.equal(matcher.getState(), 'idle');
    assert.deepEqual(stateChanges, ['spectated', 'idle']);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.type, 'username:match');
    assert.deepEqual(sent[1]!.payload, { matched: false });
  });

  it('test 5: inbound username:match {matched: true} → spectating, fires callback', () => {
    client.dispatch(makeMatch(true));

    assert.equal(matcher.getState(), 'spectating');
    assert.deepEqual(stateChanges, ['spectating']);
  });

  it('test 6: inbound username:match {matched: false} → idle, fires callback', () => {
    // First get into spectating
    client.dispatch(makeMatch(true));
    // Then peer loses us
    client.dispatch(makeMatch(false));

    assert.equal(matcher.getState(), 'idle');
    assert.deepEqual(stateChanges, ['spectating', 'idle']);
  });

  it('test 7: getOwnUsername returns empty string → announce ignored entirely', () => {
    ownUsername = '';
    const sent = (client as unknown as { _sent: Array<{ type: string; payload: unknown }> })._sent;
    client.dispatch(makeAnnounce('TestPlayer'));

    assert.equal(matcher.getState(), 'idle');
    assert.deepEqual(stateChanges, []);
    assert.equal(sent.length, 0);
  });

  it('test 8: getGroupId returns null → announce ignored entirely', () => {
    groupId = null;
    const sent = (client as unknown as { _sent: Array<{ type: string; payload: unknown }> })._sent;
    client.dispatch(makeAnnounce('TestPlayer'));

    assert.equal(matcher.getState(), 'idle');
    assert.deepEqual(stateChanges, []);
    assert.equal(sent.length, 0);
  });

  it('test 9: reset() from spectated → idle, no outbound message, fires callback', () => {
    const sent = (client as unknown as { _sent: Array<{ type: string; payload: unknown }> })._sent;
    // Get into spectated
    client.dispatch(makeAnnounce('TestPlayer'));
    assert.equal(sent.length, 1);

    matcher.reset();

    assert.equal(matcher.getState(), 'idle');
    assert.deepEqual(stateChanges, ['spectated', 'idle']);
    // No additional sends after the initial match:true
    assert.equal(sent.length, 1);
  });
});

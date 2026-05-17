import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleUsernameChange, PeerUsernameStore, publishOwnUsername } from './peerUsername.js';
import type { Envelope, MessageType } from '@pyng/shared';

// ---- minimal fakes ----

interface EnvelopeSent {
  type: string;
  payload: unknown;
  groupId?: string;
}

function makeFakeClient() {
  const sent: EnvelopeSent[] = [];
  return {
    sent,
    sendEnvelope<T extends MessageType>(envelope: Envelope<T>): void {
      sent.push({ type: envelope.type, payload: envelope.payload, groupId: envelope.groupId });
    },
  };
}

type PairKind = 'unpaired' | 'paired';

function makeFakeMachine(kind: PairKind, groupId = 'g1', sessionId = 'sess-a') {
  return {
    getState: () => ({
      pair:
        kind === 'paired'
          ? { kind: 'paired' as const, groupId, sessionId }
          : { kind: 'unpaired' as const },
      connection: 'connected' as const,
      pairLostHint: false,
      latencyMs: null,
      spectatorState: null,
      peerRobloxUsername: null,
    }),
  };
}

// ---- test 1: publishOwnUsername with empty string skips send ----

describe('publishOwnUsername', () => {
  it('test 1: empty robloxUsername does not call sendEnvelope', () => {
    const client = makeFakeClient();
    publishOwnUsername(client as never, 'group1', 'sess-a', '');
    assert.equal(client.sent.length, 0);
  });

  it('test 2: valid robloxUsername calls sendEnvelope once with correct envelope', () => {
    const client = makeFakeClient();
    publishOwnUsername(client as never, 'group1', 'sess-a', 'Vincent_Feng');
    assert.equal(client.sent.length, 1);
    const msg = client.sent[0];
    assert.ok(msg !== undefined);
    assert.equal(msg.type, 'peer:username');
    assert.deepEqual(msg.payload, { sessionId: 'sess-a', robloxUsername: 'Vincent_Feng' });
    assert.equal(msg.groupId, 'group1');
  });
});

// ---- tests 3–4: PeerUsernameStore ----

describe('PeerUsernameStore', () => {
  let store: PeerUsernameStore;

  beforeEach(() => {
    store = new PeerUsernameStore();
  });

  it('test 3: set/getForSession/clear basic CRUD', () => {
    assert.equal(store.getForSession('s1'), null);

    store.set('s1', 'Alice');
    assert.equal(store.getForSession('s1'), 'Alice');

    store.set('s1', 'AliceUpdated');
    assert.equal(store.getForSession('s1'), 'AliceUpdated');

    store.clear();
    assert.equal(store.getForSession('s1'), null);
  });

  it('test 4: getPeerUsername returns the entry that is NOT ownSessionId', () => {
    store.set('s-own', 'OwnName');
    store.set('s-peer', 'PeerName');

    assert.equal(store.getPeerUsername('s-own'), 'PeerName');
  });

  it('test 4b: getPeerUsername returns null when only own session present', () => {
    store.set('s-own', 'OwnName');
    assert.equal(store.getPeerUsername('s-own'), null);
  });
});

// ---- tests 5–7: republishOnUsernameChange decision logic ----
//
// `republishOnUsernameChange` itself wires `handleUsernameChange` to the
// electron-store singleton via onSettingsChange. The diff/dispatch decision
// is factored out into `handleUsernameChange` for hermetic testing, so the
// tests below call it directly with mock machine + client. Driving the
// real onSettingsChange would require patching the default store and adds
// no coverage over the pure decision logic.

describe('handleUsernameChange (republishOnUsernameChange decision logic)', () => {
  it('test 5: fires publishOwnUsername when paired and username changes', () => {
    const client = makeFakeClient();
    const machine = makeFakeMachine('paired', 'group1', 'sess-a');
    const store = new PeerUsernameStore();

    const result = handleUsernameChange('', 'Vincent_Feng', machine, client as never, store);

    assert.equal(result.published, true);
    assert.equal(result.next, 'Vincent_Feng');
    assert.equal(client.sent.length, 1);
    const msg = client.sent[0];
    assert.ok(msg !== undefined);
    assert.equal(msg.type, 'peer:username');
    assert.deepEqual(msg.payload, { sessionId: 'sess-a', robloxUsername: 'Vincent_Feng' });
    assert.equal(store.getForSession('sess-a'), 'Vincent_Feng');
  });

  it('test 6: does NOT publish on the wire when state is unpaired', () => {
    const client = makeFakeClient();
    const machine = makeFakeMachine('unpaired');
    const store = new PeerUsernameStore();

    const result = handleUsernameChange('', 'Vincent_Feng', machine, client as never, store);

    assert.equal(result.published, false);
    // Tracked `previous` still updates so a later pair doesn't re-emit
    // the same value pointlessly.
    assert.equal(result.next, 'Vincent_Feng');
    assert.equal(client.sent.length, 0);
    assert.equal(store.getForSession('sess-a'), null);
  });

  it('test 7: does NOT fire when robloxUsername equals previous value', () => {
    const client = makeFakeClient();
    const machine = makeFakeMachine('paired', 'group1', 'sess-a');
    const store = new PeerUsernameStore();

    const result = handleUsernameChange(
      'Vincent_Feng',
      'Vincent_Feng',
      machine,
      client as never,
      store,
    );

    assert.equal(result.published, false);
    assert.equal(result.next, 'Vincent_Feng');
    assert.equal(client.sent.length, 0);
  });
});

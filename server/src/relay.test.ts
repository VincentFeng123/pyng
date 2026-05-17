import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createEnvelope, isMessage, type Envelope, type Message } from '@pyng/shared';
import { startServer, type ServerHandle } from './index.js';
import { _resetStateForTests } from './groups.js';
import { _resetSocketsForTests } from './relay.js';
import { loopbackListenSkipReason } from './test-preflight.js';

const LOOPBACK_SKIP_REASON = await loopbackListenSkipReason();

type Inbox = {
  ws: WebSocket;
  messages: Message[];
  waitFor: (predicate: (m: Message) => boolean, timeoutMs?: number) => Promise<Message>;
  drain: () => Message[];
  expectNone: (predicate: (m: Message) => boolean, windowMs: number) => Promise<void>;
};

function attachInbox(ws: WebSocket): Inbox {
  const messages: Message[] = [];
  const pending: Array<{
    predicate: (m: Message) => boolean;
    resolve: (m: Message) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  ws.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!isMessage(parsed)) {
      return;
    }
    messages.push(parsed);
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      if (entry && entry.predicate(parsed)) {
        clearTimeout(entry.timer);
        pending.splice(i, 1);
        entry.resolve(parsed);
      }
    }
  });

  return {
    ws,
    messages,
    waitFor(predicate, timeoutMs = 1000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = pending.findIndex((p) => p.timer === timer);
          if (idx >= 0) pending.splice(idx, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for matching message`));
        }, timeoutMs);
        pending.push({ predicate, resolve, reject, timer });
      });
    },
    drain() {
      const copy = [...messages];
      messages.length = 0;
      return copy;
    },
    expectNone(predicate, windowMs) {
      return new Promise<void>((resolve, reject) => {
        const offender = messages.find(predicate);
        if (offender) {
          reject(
            new Error(`expected no matching message, got ${offender.type}:${offender.messageId}`),
          );
          return;
        }
        setTimeout(() => {
          const found = messages.find(predicate);
          if (found) {
            reject(new Error(`expected no matching message, got ${found.type}:${found.messageId}`));
          } else {
            resolve();
          }
        }, windowMs);
      });
    },
  };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

async function helloAndPair(url: string): Promise<{
  alice: Inbox;
  bob: Inbox;
  groupId: string;
  aliceSessionId: string;
  bobSessionId: string;
}> {
  const aliceWs = await openSocket(url);
  const bobWs = await openSocket(url);
  const alice = attachInbox(aliceWs);
  const bob = attachInbox(bobWs);

  aliceWs.send(
    JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
  );
  const aliceWelcome = (await alice.waitFor((m) => m.type === 'welcome')) as Envelope<'welcome'>;
  const aliceSessionId = aliceWelcome.payload.sessionId;

  bobWs.send(
    JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
  );
  const bobWelcome = (await bob.waitFor((m) => m.type === 'welcome')) as Envelope<'welcome'>;
  const bobSessionId = bobWelcome.payload.sessionId;

  aliceWs.send(JSON.stringify(createEnvelope('pair:generate', {})));
  const codeMsg = (await alice.waitFor((m) => m.type === 'pair:code')) as Envelope<'pair:code'>;

  bobWs.send(JSON.stringify(createEnvelope('pair:redeem', { code: codeMsg.payload.code })));
  const aliceEstablished = (await alice.waitFor(
    (m) => m.type === 'pair:established',
  )) as Envelope<'pair:established'>;
  const bobEstablished = (await bob.waitFor(
    (m) => m.type === 'pair:established',
  )) as Envelope<'pair:established'>;

  assert.equal(aliceEstablished.payload.groupId, bobEstablished.payload.groupId);
  alice.drain();
  bob.drain();
  return {
    alice,
    bob,
    groupId: aliceEstablished.payload.groupId,
    aliceSessionId,
    bobSessionId,
  };
}

describe('relay ping broadcast', { skip: LOOPBACK_SKIP_REASON ?? false }, () => {
  let server: ServerHandle;
  let url: string;

  before(async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    server = await startServer({ port: 0, host: '127.0.0.1', log: () => {} });
    url = `ws://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.close();
  });

  it('routes ping:drop to peer, never echoes to sender', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId } = await helloAndPair(url);

    const ping = createEnvelope(
      'ping:drop',
      {
        coords: { x: 0.3, y: 0.7 },
        color: '#ff3344',
        ttl: 5000,
        senderSessionId: 'mock-session-id',
      },
      { groupId },
    );
    alice.ws.send(JSON.stringify(ping));

    const received = (await bob.waitFor(
      (m) => m.type === 'ping:drop' && m.messageId === ping.messageId,
    )) as Envelope<'ping:drop'>;
    assert.equal(received.messageId, ping.messageId);
    assert.equal(received.payload.color, '#ff3344');
    assert.equal(received.payload.ttl, 5000);
    assert.deepEqual(received.payload.coords, { x: 0.3, y: 0.7 });
    assert.equal(received.payload.senderSessionId, 'mock-session-id');

    await alice.expectNone((m) => m.type === 'ping:drop' && m.messageId === ping.messageId, 200);

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('sends ping:ack to sender on ping:drop and not to peers', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId } = await helloAndPair(url);

    const beforeSendAt = Date.now();
    const ping = createEnvelope(
      'ping:drop',
      {
        coords: { x: 0.5, y: 0.5 },
        color: '#33ff66',
        ttl: 5000,
        senderSessionId: 'mock-session-id',
      },
      { groupId },
    );
    alice.ws.send(JSON.stringify(ping));

    const ack = (await alice.waitFor(
      (m) => m.type === 'ping:ack' && m.payload.messageId === ping.messageId,
    )) as Envelope<'ping:ack'>;
    assert.equal(ack.payload.messageId, ping.messageId);
    assert.equal(typeof ack.payload.receivedAt, 'number');
    assert.ok(
      ack.payload.receivedAt >= beforeSendAt,
      `ack.receivedAt=${ack.payload.receivedAt} should be >= beforeSendAt=${beforeSendAt}`,
    );

    // Bob receives the ping:drop itself but NOT the ack (server sends ack to sender only).
    await bob.waitFor((m) => m.type === 'ping:drop' && m.messageId === ping.messageId);
    await bob.expectNone(
      (m) => m.type === 'ping:ack' && m.payload.messageId === ping.messageId,
      200,
    );

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('routes ping:clear to peer, never echoes to sender', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId } = await helloAndPair(url);

    const clear = createEnvelope('ping:clear', {}, { groupId });
    bob.ws.send(JSON.stringify(clear));

    await alice.waitFor((m) => m.type === 'ping:clear' && m.messageId === clear.messageId);
    await bob.expectNone((m) => m.type === 'ping:clear' && m.messageId === clear.messageId, 200);

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('routes ping:ack to peer, never echoes to sender', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId } = await helloAndPair(url);

    const ack = createEnvelope(
      'ping:ack',
      { messageId: 'original-id', receivedAt: Date.now() },
      { groupId },
    );
    alice.ws.send(JSON.stringify(ack));

    await bob.waitFor((m) => m.type === 'ping:ack' && m.messageId === ack.messageId);
    await alice.expectNone((m) => m.type === 'ping:ack' && m.messageId === ack.messageId, 200);

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('ignores ping:drop from a sender not in any group', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob } = await helloAndPair(url);

    const charlieWs = await openSocket(url);
    const charlie = attachInbox(charlieWs);
    charlieWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    await charlie.waitFor((m) => m.type === 'welcome');
    charlie.drain();

    const ping = createEnvelope('ping:drop', {
      coords: { x: 0.1, y: 0.1 },
      color: '#ffffff',
      ttl: 1000,
      senderSessionId: 'charlie-claimed-id',
    });
    charlieWs.send(JSON.stringify(ping));

    await alice.expectNone((m) => m.type === 'ping:drop', 200);
    await bob.expectNone((m) => m.type === 'ping:drop', 200);
    await charlie.expectNone((m) => m.type === 'ping:drop', 200);

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
    await closeSocket(charlieWs);
  });

  it('peer:avatar broadcasts to peers and identity is verified', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId, aliceSessionId, bobSessionId } = await helloAndPair(url);

    const aliceAvatar = createEnvelope(
      'peer:avatar',
      { sessionId: aliceSessionId, imageBase64: 'YWxpY2UtYXZhdGFy' },
      { groupId },
    );
    alice.ws.send(JSON.stringify(aliceAvatar));

    const bobReceived = (await bob.waitFor(
      (m) => m.type === 'peer:avatar' && m.messageId === aliceAvatar.messageId,
    )) as Envelope<'peer:avatar'>;
    assert.equal(bobReceived.payload.sessionId, aliceSessionId);
    assert.equal(bobReceived.payload.imageBase64, 'YWxpY2UtYXZhdGFy');

    await alice.expectNone(
      (m) => m.type === 'peer:avatar' && m.messageId === aliceAvatar.messageId,
      200,
    );

    bob.drain();
    const impersonation = createEnvelope(
      'peer:avatar',
      { sessionId: bobSessionId, imageBase64: 'aW1wZXJzb25hdGlvbg==' },
      { groupId },
    );
    alice.ws.send(JSON.stringify(impersonation));

    const errMsg = (await alice.waitFor(
      (m) => m.type === 'error' && m.payload.code === 'avatar_identity_mismatch',
    )) as Envelope<'error'>;
    assert.equal(errMsg.payload.code, 'avatar_identity_mismatch');

    await bob.expectNone(
      (m) => m.type === 'peer:avatar' && m.messageId === impersonation.messageId,
      200,
    );

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('pair:established replays cached avatars to the joining peer', async () => {
    _resetStateForTests();
    _resetSocketsForTests();

    // Alice connects, helloes, generates a code, then publishes peer:avatar BEFORE bob
    // redeems. Because there's no group yet, the server pends the avatar; the pending
    // entry is drained into the group's avatars Map when redeemCode creates the group.
    const aliceWs = await openSocket(url);
    const alice = attachInbox(aliceWs);
    aliceWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    const aliceWelcome = (await alice.waitFor((m) => m.type === 'welcome')) as Envelope<'welcome'>;
    const aliceSessionId = aliceWelcome.payload.sessionId;

    aliceWs.send(JSON.stringify(createEnvelope('pair:generate', {})));
    const codeMsg = (await alice.waitFor((m) => m.type === 'pair:code')) as Envelope<'pair:code'>;
    const code = codeMsg.payload.code;

    aliceWs.send(
      JSON.stringify(
        createEnvelope('peer:avatar', {
          sessionId: aliceSessionId,
          imageBase64: 'Y2FjaGVkLWFsaWNl',
        }),
      ),
    );
    // No echo to alice expected; the publish is pended server-side.
    await alice.expectNone((m) => m.type === 'peer:avatar', 100);

    // Bob connects and redeems. He should receive pair:established AND alice's pended avatar.
    const bobWs = await openSocket(url);
    const bob = attachInbox(bobWs);
    bobWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    await bob.waitFor((m) => m.type === 'welcome');
    bobWs.send(JSON.stringify(createEnvelope('pair:redeem', { code })));

    await bob.waitFor((m) => m.type === 'pair:established');
    const replayed = (await bob.waitFor(
      (m) => m.type === 'peer:avatar' && m.payload.sessionId === aliceSessionId,
    )) as Envelope<'peer:avatar'>;
    assert.equal(replayed.payload.imageBase64, 'Y2FjaGVkLWFsaWNl');

    // Bob never published, so alice gets no replay for bob.
    await alice.expectNone((m) => m.type === 'peer:avatar', 200);

    await closeSocket(aliceWs);
    await closeSocket(bobWs);
  });

  it('peer:username broadcasts to peer and sender is not echoed', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId, aliceSessionId } = await helloAndPair(url);

    const usernameMsg = createEnvelope(
      'peer:username',
      { sessionId: aliceSessionId, robloxUsername: 'AlicePlayer' },
      { groupId },
    );
    alice.ws.send(JSON.stringify(usernameMsg));

    const bobReceived = (await bob.waitFor(
      (m) => m.type === 'peer:username' && m.messageId === usernameMsg.messageId,
    )) as Envelope<'peer:username'>;
    assert.equal(bobReceived.payload.sessionId, aliceSessionId);
    assert.equal(bobReceived.payload.robloxUsername, 'AlicePlayer');

    await alice.expectNone(
      (m) => m.type === 'peer:username' && m.messageId === usernameMsg.messageId,
      200,
    );

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('peer:username with mismatched payload.sessionId emits error; no group state change', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId, bobSessionId } = await helloAndPair(url);

    // Alice sends a peer:username claiming to be Bob — server should reject.
    const impersonation = createEnvelope(
      'peer:username',
      { sessionId: bobSessionId, robloxUsername: 'ImpostorName' },
      { groupId },
    );
    alice.ws.send(JSON.stringify(impersonation));

    const errMsg = (await alice.waitFor(
      (m) => m.type === 'error' && m.payload.code === 'username_identity_mismatch',
    )) as Envelope<'error'>;
    assert.equal(errMsg.payload.code, 'username_identity_mismatch');

    await bob.expectNone(
      (m) => m.type === 'peer:username' && m.messageId === impersonation.messageId,
      200,
    );

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('peer:username from unpaired sender is pended, not broadcast', async () => {
    _resetStateForTests();
    _resetSocketsForTests();

    const charlieWs = await openSocket(url);
    const charlie = attachInbox(charlieWs);
    charlieWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    const charlieWelcome = (await charlie.waitFor(
      (m) => m.type === 'welcome',
    )) as Envelope<'welcome'>;
    const charlieSessionId = charlieWelcome.payload.sessionId;
    charlie.drain();

    // Charlie is not in any group — username should be pended, not crash.
    const usernameMsg = createEnvelope('peer:username', {
      sessionId: charlieSessionId,
      robloxUsername: 'PendedUser',
    });
    charlieWs.send(JSON.stringify(usernameMsg));

    // No broadcast — Charlie has no peers.
    await charlie.expectNone((m) => m.type === 'peer:username', 200);

    // Now Charlie generates a code and Dan redeems it. Dan should receive the pended username.
    charlieWs.send(JSON.stringify(createEnvelope('pair:generate', {})));
    const codeMsg = (await charlie.waitFor((m) => m.type === 'pair:code')) as Envelope<'pair:code'>;

    const danWs = await openSocket(url);
    const dan = attachInbox(danWs);
    danWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    await dan.waitFor((m) => m.type === 'welcome');
    danWs.send(JSON.stringify(createEnvelope('pair:redeem', { code: codeMsg.payload.code })));

    await dan.waitFor((m) => m.type === 'pair:established');

    const replayed = (await dan.waitFor(
      (m) => m.type === 'peer:username' && m.payload.sessionId === charlieSessionId,
    )) as Envelope<'peer:username'>;
    assert.equal(replayed.payload.robloxUsername, 'PendedUser');

    await closeSocket(charlieWs);
    await closeSocket(danWs);
  });

  it('username:announce routes to peer', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId } = await helloAndPair(url);

    const announce = createEnvelope(
      'username:announce',
      { detectedUsername: 'BobPlayer', confidence: 0.95, game: 'phantom-forces' },
      { groupId },
    );
    alice.ws.send(JSON.stringify(announce));

    const received = (await bob.waitFor(
      (m) => m.type === 'username:announce' && m.messageId === announce.messageId,
    )) as Envelope<'username:announce'>;
    assert.equal(received.payload.detectedUsername, 'BobPlayer');
    assert.equal(received.payload.confidence, 0.95);

    await alice.expectNone(
      (m) => m.type === 'username:announce' && m.messageId === announce.messageId,
      200,
    );

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('username:announce from sender not in any group is silently dropped', async () => {
    _resetStateForTests();
    _resetSocketsForTests();

    const lonelyWs = await openSocket(url);
    const lonely = attachInbox(lonelyWs);
    lonelyWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    await lonely.waitFor((m) => m.type === 'welcome');
    lonely.drain();

    const announce = createEnvelope('username:announce', {
      detectedUsername: 'Nobody',
      confidence: 0.8,
      game: 'phantom-forces',
    });
    lonelyWs.send(JSON.stringify(announce));

    // No crash, no echo.
    await lonely.expectNone((m) => m.type === 'username:announce', 200);

    await closeSocket(lonelyWs);
  });

  it('username:match routes to peer', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId } = await helloAndPair(url);

    const match = createEnvelope('username:match', { matched: true }, { groupId });
    alice.ws.send(JSON.stringify(match));

    const received = (await bob.waitFor(
      (m) => m.type === 'username:match' && m.messageId === match.messageId,
    )) as Envelope<'username:match'>;
    assert.equal(received.payload.matched, true);

    await alice.expectNone(
      (m) => m.type === 'username:match' && m.messageId === match.messageId,
      200,
    );

    await closeSocket(alice.ws);
    await closeSocket(bob.ws);
  });

  it('replayUsernames fires on pair establishment: generator username reaches redeemer', async () => {
    _resetStateForTests();
    _resetSocketsForTests();

    const aliceWs = await openSocket(url);
    const alice = attachInbox(aliceWs);
    aliceWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    const aliceWelcome = (await alice.waitFor((m) => m.type === 'welcome')) as Envelope<'welcome'>;
    const aliceSessionId = aliceWelcome.payload.sessionId;

    aliceWs.send(JSON.stringify(createEnvelope('pair:generate', {})));
    const codeMsg = (await alice.waitFor((m) => m.type === 'pair:code')) as Envelope<'pair:code'>;
    const code = codeMsg.payload.code;

    // Alice publishes username before Bob redeems — should be pended.
    aliceWs.send(
      JSON.stringify(
        createEnvelope('peer:username', {
          sessionId: aliceSessionId,
          robloxUsername: 'AliceGamer',
        }),
      ),
    );
    await alice.expectNone((m) => m.type === 'peer:username', 100);

    // Bob redeems and should receive the replayed username.
    const bobWs = await openSocket(url);
    const bob = attachInbox(bobWs);
    bobWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    await bob.waitFor((m) => m.type === 'welcome');
    bobWs.send(JSON.stringify(createEnvelope('pair:redeem', { code })));

    await bob.waitFor((m) => m.type === 'pair:established');
    const replayed = (await bob.waitFor(
      (m) => m.type === 'peer:username' && m.payload.sessionId === aliceSessionId,
    )) as Envelope<'peer:username'>;
    assert.equal(replayed.payload.robloxUsername, 'AliceGamer');

    await closeSocket(aliceWs);
    await closeSocket(bobWs);
  });

  it('second pair:generate invalidates the first code for that session', async () => {
    _resetStateForTests();
    _resetSocketsForTests();

    const aliceWs = await openSocket(url);
    const alice = attachInbox(aliceWs);
    aliceWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    await alice.waitFor((m) => m.type === 'welcome');

    aliceWs.send(JSON.stringify(createEnvelope('pair:generate', {})));
    const first = (await alice.waitFor((m) => m.type === 'pair:code')) as Envelope<'pair:code'>;
    alice.drain();

    aliceWs.send(JSON.stringify(createEnvelope('pair:generate', {})));
    const second = (await alice.waitFor((m) => m.type === 'pair:code')) as Envelope<'pair:code'>;
    assert.notEqual(first.payload.code, second.payload.code);

    const bobWs = await openSocket(url);
    const bob = attachInbox(bobWs);
    bobWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    await bob.waitFor((m) => m.type === 'welcome');

    bobWs.send(JSON.stringify(createEnvelope('pair:redeem', { code: first.payload.code })));
    const invalid = (await bob.waitFor(
      (m) => m.type === 'pair:invalid',
    )) as Envelope<'pair:invalid'>;
    assert.equal(invalid.payload.reason, 'not_found');

    bobWs.send(JSON.stringify(createEnvelope('pair:redeem', { code: second.payload.code })));
    await bob.waitFor((m) => m.type === 'pair:established');
    await alice.waitFor((m) => m.type === 'pair:established');

    await closeSocket(aliceWs);
    await closeSocket(bobWs);
  });

  it('pair:resume rejoins a grace-period group after disconnect', async () => {
    _resetStateForTests();
    _resetSocketsForTests();
    const { alice, bob, groupId } = await helloAndPair(url);

    await closeSocket(alice.ws);

    const resumedWs = await openSocket(url);
    const resumed = attachInbox(resumedWs);
    resumedWs.send(
      JSON.stringify(createEnvelope('hello', { clientVersion: '0.0.0', platform: 'linux' })),
    );
    await resumed.waitFor((m) => m.type === 'welcome');
    resumedWs.send(JSON.stringify(createEnvelope('pair:resume', { groupId })));
    const established = (await resumed.waitFor(
      (m) => m.type === 'pair:established',
    )) as Envelope<'pair:established'>;
    assert.equal(established.payload.groupId, groupId);

    const ping = createEnvelope(
      'ping:drop',
      {
        coords: { x: 0.25, y: 0.75 },
        color: '#abcdef',
        ttl: 5000,
        senderSessionId: 'resumed-session',
      },
      { groupId },
    );
    resumedWs.send(JSON.stringify(ping));
    await bob.waitFor((m) => m.type === 'ping:drop' && m.messageId === ping.messageId);

    await closeSocket(resumedWs);
    await closeSocket(bob.ws);
  });
});

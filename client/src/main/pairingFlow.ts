import { AbortError, type WsClient } from './net/wsClient.js';
import { AbortFlowError } from './state-machine-errors.js';

const CLIENT_VERSION = '0.0.0';
const POST_PAIR_HOLD_MS = 3_000;

export type FlowMode = 'generate' | 'redeem';

function platform(): 'win32' | 'darwin' | 'linux' {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortFlowError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortFlowError());
    };
    signal?.addEventListener('abort', onAbort);
  });
}

export type FlowOptions = {
  postPairHold?: boolean;
  signal?: AbortSignal;
  onCode?: (code: string, expiresAt: number) => void;
  onSessionId?: (sessionId: string) => void;
};

const ESTABLISHED_TIMEOUT_MS = 5 * 60_000;

function adaptAbort<T>(p: Promise<T>): Promise<T> {
  return p.catch((err) => {
    if (err instanceof AbortError) throw new AbortFlowError();
    throw err;
  });
}

export async function runGenerateFlow(
  client: WsClient,
  log: (line: string) => void,
  opts: FlowOptions = {},
): Promise<{ groupId: string; sessionId: string }> {
  client.send('hello', { clientVersion: CLIENT_VERSION, platform: platform() });
  log('hello sent');

  const welcome = await adaptAbort(client.waitFor('welcome', { signal: opts.signal }));
  const { sessionId } = welcome.payload;
  log(`welcome received (sessionId=${sessionId})`);
  opts.onSessionId?.(sessionId);

  client.send('pair:generate', {});
  log('pair:generate sent');

  const code = await adaptAbort(client.waitFor('pair:code', { signal: opts.signal }));
  const expiresIso = new Date(code.payload.expiresAt).toISOString();
  log(`Pairing code: ${code.payload.code} (expires at ${expiresIso})`);
  opts.onCode?.(code.payload.code, code.payload.expiresAt);

  const established = await adaptAbort(
    client.waitFor('pair:established', {
      timeoutMs: ESTABLISHED_TIMEOUT_MS,
      signal: opts.signal,
    }),
  );
  const { groupId } = established.payload;
  log(`Paired! groupId=${groupId}`);

  if (opts.postPairHold !== false) {
    await delay(POST_PAIR_HOLD_MS, opts.signal);
  }
  return { groupId, sessionId };
}

export async function runRedeemFlow(
  client: WsClient,
  code: string,
  log: (line: string) => void,
  opts: FlowOptions = {},
): Promise<{ groupId: string; sessionId: string }> {
  client.send('hello', { clientVersion: CLIENT_VERSION, platform: platform() });
  log('hello sent');

  const welcome = await adaptAbort(client.waitFor('welcome', { signal: opts.signal }));
  const { sessionId } = welcome.payload;
  log(`welcome received (sessionId=${sessionId})`);
  opts.onSessionId?.(sessionId);

  client.send('pair:redeem', { code });
  log(`pair:redeem sent (code=${code})`);

  const result = await adaptAbort(
    Promise.race([
      client
        .waitFor('pair:established', { signal: opts.signal })
        .then((env) => ({ kind: 'ok' as const, env })),
      client
        .waitFor('pair:invalid', { signal: opts.signal })
        .then((env) => ({ kind: 'invalid' as const, env })),
    ]),
  );

  if (result.kind === 'invalid') {
    throw new PairInvalidError(result.env.payload.reason);
  }

  const { groupId } = result.env.payload;
  log(`Paired! groupId=${groupId}`);
  if (opts.postPairHold !== false) {
    await delay(POST_PAIR_HOLD_MS, opts.signal);
  }
  return { groupId, sessionId };
}

export async function runResumeFlow(
  client: WsClient,
  groupId: string,
  log: (line: string) => void,
  opts: FlowOptions = {},
): Promise<{ groupId: string; sessionId: string }> {
  client.send('hello', { clientVersion: CLIENT_VERSION, platform: platform() });
  log('hello sent');

  const welcome = await adaptAbort(client.waitFor('welcome', { signal: opts.signal }));
  const { sessionId } = welcome.payload;
  log(`welcome received (sessionId=${sessionId})`);
  opts.onSessionId?.(sessionId);

  client.send('pair:resume', { groupId });
  log(`pair:resume sent (groupId=${groupId})`);

  const result = await adaptAbort(
    Promise.race([
      client
        .waitFor('pair:established', { signal: opts.signal })
        .then((env) => ({ kind: 'ok' as const, env })),
      client
        .waitFor('pair:invalid', { signal: opts.signal })
        .then((env) => ({ kind: 'invalid' as const, env })),
    ]),
  );

  if (result.kind === 'invalid') {
    throw new PairInvalidError(result.env.payload.reason);
  }

  const establishedGroupId = result.env.payload.groupId;
  log(`Pair resumed! groupId=${establishedGroupId}`);
  return { groupId: establishedGroupId, sessionId };
}

export class PairInvalidError extends Error {
  constructor(public readonly reason: string) {
    super(`pair:invalid (${reason})`);
    this.name = 'PairInvalidError';
  }
}

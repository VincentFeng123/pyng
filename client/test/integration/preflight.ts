import { createServer } from 'node:net';
import type { TestContext } from 'node:test';

export async function loopbackListenSkipReason(): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(reason));
        return;
      }
      resolve(reason);
    };

    server.once('error', (err: NodeJS.ErrnoException) => {
      finish(`loopback TCP listen unavailable in this environment: ${err.code ?? err.message}`);
    });
    server.listen(0, '127.0.0.1', () => finish(null));
  });
}

export function skipIfLoopbackUnavailable(t: TestContext, reason: string | null): boolean {
  if (reason === null) return false;
  t.skip(reason);
  return true;
}

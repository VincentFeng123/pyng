import { createServer } from 'node:net';

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

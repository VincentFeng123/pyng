import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createEnvelope, isMessage } from '@pyng/shared';
import { cleanupExpiredCodes, cleanupExpiredGroups } from './groups.js';
import { dispatch, registerSocket, unregisterSocket, socketCount } from './relay.js';

const DEFAULT_PORT = 7788;
const CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export type ServerHandle = {
  port: number;
  close: () => Promise<void>;
};

export type LogFn = (event: Record<string, unknown>) => void;

export type StartOptions = {
  port?: number;
  host?: string;
  log?: LogFn;
  heartbeatIntervalMs?: number;
};

type LiveSocket = WebSocket & { isAlive?: boolean };

function defaultLog(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: Date.now(), ...event })}\n`);
}

export function startServer(options: StartOptions = {}): Promise<ServerHandle> {
  const log: LogFn = options.log ?? defaultLog;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const requestedHost = options.host ?? process.env.HOST ?? '0.0.0.0';
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const sessionBySocket = new WeakMap<WebSocket, string>();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket: LiveSocket) => {
    const sessionId = randomUUID();
    sessionBySocket.set(socket, sessionId);
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    registerSocket(sessionId, socket);
    log({ event: 'connect', sessionId, sockets: socketCount() });

    socket.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        const err = createEnvelope('error', {
          code: 'protocol_error',
          message: 'malformed json',
        });
        socket.send(JSON.stringify(err));
        log({ event: 'protocol_error', sessionId, reason: 'json_parse' });
        socket.close(1002, 'protocol_error');
        return;
      }
      if (!isMessage(parsed)) {
        const err = createEnvelope('error', {
          code: 'protocol_error',
          message: 'invalid envelope',
        });
        socket.send(JSON.stringify(err));
        log({ event: 'protocol_error', sessionId, reason: 'envelope_shape' });
        socket.close(1002, 'protocol_error');
        return;
      }
      dispatch(socket, sessionId, parsed, log);
    });

    socket.on('close', (code, reason) => {
      unregisterSocket(sessionId);
      log({
        event: 'disconnect',
        sessionId,
        code,
        reason: reason.toString(),
        sockets: socketCount(),
      });
    });

    socket.on('error', (err) => {
      log({ event: 'socket_error', sessionId, message: err.message });
    });
  });

  const cleanupTimer = setInterval(() => {
    const removedCodes = cleanupExpiredCodes();
    const removedGroups = cleanupExpiredGroups();
    if (removedCodes > 0 || removedGroups > 0) {
      log({ event: 'cleanup', removedCodes, removedGroups });
    }
  }, CLEANUP_INTERVAL_MS);

  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients as Set<LiveSocket>) {
      if (client.isAlive === false) {
        const sessionId = sessionBySocket.get(client);
        log({ event: 'heartbeat_timeout', sessionId });
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        // socket may have closed mid-loop; next tick will terminate.
      }
    }
  }, heartbeatIntervalMs);

  return new Promise<ServerHandle>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, requestedHost, () => {
      httpServer.off('error', reject);
      const address = httpServer.address();
      const boundPort = typeof address === 'object' && address ? address.port : requestedPort;
      log({ event: 'listening', port: boundPort, host: requestedHost });
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((closeResolve) => {
            clearInterval(cleanupTimer);
            clearInterval(heartbeatTimer);
            for (const client of wss.clients) {
              try {
                client.close(1001, 'server_shutdown');
              } catch {
                // ignore
              }
            }
            wss.close(() => {
              httpServer.close(() => closeResolve());
            });
          }),
      });
    });
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST;
  const heartbeatIntervalMs = process.env.HEARTBEAT_INTERVAL_MS
    ? Number(process.env.HEARTBEAT_INTERVAL_MS)
    : undefined;
  startServer({ port, host, heartbeatIntervalMs }).then((handle) => {
    function shutdown(signal: string): void {
      defaultLog({ event: 'shutdown', signal });
      handle
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      setTimeout(() => process.exit(1), 5_000).unref();
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}

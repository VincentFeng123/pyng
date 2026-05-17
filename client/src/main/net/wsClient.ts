import { WebSocket } from 'ws';
import {
  createEnvelope,
  isMessage,
  type Envelope,
  type Message,
  type MessageType,
  type PayloadFor,
} from '@pyng/shared';

export type MessageHandler = (msg: Message) => void;
export type CloseHandler = (code: number, reason: string) => void;

export class AbortError extends Error {
  constructor() {
    super('waitFor aborted');
    this.name = 'AbortError';
  }
}

export class WsClient {
  private socket: WebSocket | null = null;
  private readonly handlers: MessageHandler[] = [];
  private readonly closeHandlers: CloseHandler[] = [];
  private readonly logger: (line: string) => void;

  constructor(logger: (line: string) => void) {
    this.logger = logger;
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;

      socket.once('open', () => {
        settled = true;
        socket.on('message', (raw) => this.onRawMessage(raw.toString()));
        socket.on('error', (err) => this.logger(`socket error: ${err.message}`));
        resolve();
      });

      socket.once('error', (err) => {
        if (!settled) {
          reject(err);
        }
      });

      socket.on('close', (code, reason) => {
        if (this.socket === socket) {
          this.socket = null;
        }
        const reasonText = reason.toString();
        for (const handler of [...this.closeHandlers]) handler(code, reasonText);
      });
    });
  }

  send<T extends MessageType>(type: T, payload: PayloadFor<T>, opts?: { groupId?: string }): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`cannot send ${type}: socket not open`);
    }
    const envelope: Envelope<T> = createEnvelope(type, payload, opts);
    this.socket.send(JSON.stringify(envelope));
  }

  sendEnvelope<T extends MessageType>(envelope: Envelope<T>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`cannot send ${envelope.type}: socket not open`);
    }
    this.socket.send(JSON.stringify(envelope));
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const idx = this.closeHandlers.indexOf(handler);
      if (idx >= 0) this.closeHandlers.splice(idx, 1);
    };
  }

  waitFor<T extends MessageType>(
    type: T,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Envelope<T>> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        const idx = this.handlers.indexOf(handler);
        if (idx >= 0) this.handlers.splice(idx, 1);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      const onAbort = (): void => {
        cleanup();
        reject(new AbortError());
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer);
          reject(new AbortError());
          return;
        }
        opts.signal.addEventListener('abort', onAbort);
      }
      const handler: MessageHandler = (msg) => {
        if (msg.type !== type) return;
        cleanup();
        resolve(msg as Envelope<T>);
      };
      this.handlers.push(handler);
    });
  }

  close(code = 1000): void {
    this.socket?.close(code);
  }

  private onRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger(`dropped malformed json: ${raw.slice(0, 80)}`);
      return;
    }
    if (!isMessage(parsed)) {
      this.logger(`dropped invalid envelope`);
      return;
    }
    for (const handler of [...this.handlers]) {
      handler(parsed);
    }
  }
}

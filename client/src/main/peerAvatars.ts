type Subscriber = (sessionId: string, imageBase64: string) => void;

export class PeerAvatarStore {
  private readonly avatars = new Map<string, string>();
  private readonly subscribers = new Set<Subscriber>();

  set(sessionId: string, imageBase64: string): void {
    this.avatars.set(sessionId, imageBase64);
    for (const cb of [...this.subscribers]) cb(sessionId, imageBase64);
  }

  get(sessionId: string): string | null {
    return this.avatars.get(sessionId) ?? null;
  }

  has(sessionId: string): boolean {
    return this.avatars.has(sessionId);
  }

  clear(): void {
    this.avatars.clear();
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }
}

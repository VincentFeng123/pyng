import type { WsClient } from '../net/wsClient.js';

export type MatcherState = 'idle' | 'spectating' | 'spectated';

export type UsernameMatcherOptions = {
  client: WsClient;
  getOwnUsername: () => string;
  getGroupId: () => string | null;
  onMatchStateChange: (state: MatcherState) => void;
};

export class UsernameMatcher {
  private state: MatcherState = 'idle';
  private readonly client: WsClient;
  private readonly getOwnUsername: () => string;
  private readonly getGroupId: () => string | null;
  private readonly onMatchStateChange: (state: MatcherState) => void;

  constructor(options: UsernameMatcherOptions) {
    this.client = options.client;
    this.getOwnUsername = options.getOwnUsername;
    this.getGroupId = options.getGroupId;
    this.onMatchStateChange = options.onMatchStateChange;
  }

  start(): () => void {
    return this.client.onMessage((msg) => {
      if (msg.type === 'username:announce') {
        this.handleAnnounce(msg.payload.detectedUsername);
      } else if (msg.type === 'username:match') {
        this.handleMatch(msg.payload.matched);
      }
    });
  }

  reset(): void {
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.onMatchStateChange('idle');
  }

  getState(): MatcherState {
    return this.state;
  }

  private handleAnnounce(detectedUsername: string): void {
    const ownUsername = this.getOwnUsername();
    const groupId = this.getGroupId();

    if (ownUsername === '' || groupId === null) return;

    const matched = detectedUsername.toLowerCase() === ownUsername.toLowerCase();

    if (matched) {
      if (this.state !== 'spectated') {
        this.state = 'spectated';
        this.onMatchStateChange('spectated');
        this.client.send('username:match', { matched: true }, { groupId });
      }
    } else {
      if (this.state === 'spectated') {
        this.state = 'idle';
        this.onMatchStateChange('idle');
        this.client.send('username:match', { matched: false }, { groupId });
      }
    }
  }

  private handleMatch(matched: boolean): void {
    const nextState: MatcherState = matched ? 'spectating' : 'idle';
    if (this.state !== nextState) {
      this.state = nextState;
      this.onMatchStateChange(nextState);
    }
  }
}

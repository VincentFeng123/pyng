type Props = {
  relayUrl: string;
  isDev: boolean;
};

export function ConnectionStatus({ relayUrl, isDev }: Props): JSX.Element {
  return (
    <div className="connection-status">
      <div className="settings-row">
        <span className="settings-row-label">Server</span>
        <code className="settings-row-value">{relayUrl}</code>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">Mode</span>
        <span className={`mode-badge${isDev ? ' dev' : ' prod'}`}>{isDev ? 'dev' : 'prod'}</span>
      </div>
    </div>
  );
}

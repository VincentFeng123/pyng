import { app } from 'electron';

const PROD_RELAY_URL = 'wss://pyng-relay.up.railway.app';
const DEV_RELAY_URL = 'ws://localhost:7788';

function isDev(): boolean {
  return process.env.NODE_ENV === 'development' || !app.isPackaged;
}

export type ClientConfig = {
  relayUrl: string;
  isDev: boolean;
};

export function loadConfig(): ClientConfig {
  const env = process.env.PYNG_RELAY_URL;
  const dev = isDev();
  return {
    relayUrl: env ?? (dev ? DEV_RELAY_URL : PROD_RELAY_URL),
    isDev: dev,
  };
}

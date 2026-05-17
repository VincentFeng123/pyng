import { app } from 'electron';

declare const __PYNG_BUILD_RELAY_URL__: string | undefined;

const DEFAULT_PROD_RELAY_URL = 'wss://pyng-relay.up.railway.app';
const BUILD_RELAY_URL =
  typeof __PYNG_BUILD_RELAY_URL__ === 'string' ? __PYNG_BUILD_RELAY_URL__.trim() : '';
const PROD_RELAY_URL = BUILD_RELAY_URL.length > 0 ? BUILD_RELAY_URL : DEFAULT_PROD_RELAY_URL;
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

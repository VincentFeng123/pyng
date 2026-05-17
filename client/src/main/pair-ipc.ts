import { ipcMain } from 'electron';
import { IPC_CHANNELS, type PairRequestRedeemPayload, type PairStatePayload } from '@pyng/shared';
import type { PairStateMachine } from './state-machine.js';

const SOLO_PAIR_STATE: PairStatePayload = {
  connection: 'disconnected',
  pair: { kind: 'unpaired' },
  latencyMs: null,
  spectatorState: null,
  peerRobloxUsername: null,
};

export function registerPairIpc(machine: PairStateMachine): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(IPC_CHANNELS.PAIR_GET_STATE, (): PairStatePayload => machine.getState());
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_GET_STATE));

  ipcMain.handle(IPC_CHANNELS.PAIR_REQUEST_GENERATE, async (): Promise<void> => {
    await machine.requestGenerate();
  });
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_REQUEST_GENERATE));

  ipcMain.handle(
    IPC_CHANNELS.PAIR_REQUEST_REDEEM,
    async (_event, payload: PairRequestRedeemPayload): Promise<void> => {
      await machine.requestRedeem(payload.code);
    },
  );
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_REQUEST_REDEEM));

  ipcMain.handle(IPC_CHANNELS.PAIR_REQUEST_UNPAIR, (): void => {
    machine.requestUnpair();
  });
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_REQUEST_UNPAIR));

  ipcMain.handle(IPC_CHANNELS.PAIR_DISMISS_LOST_HINT, (): void => {
    machine.dismissPairLostHint();
  });
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_DISMISS_LOST_HINT));

  return () => {
    for (const h of handlers) h();
  };
}

export function registerSoloPairIpc(): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(IPC_CHANNELS.PAIR_GET_STATE, (): PairStatePayload => SOLO_PAIR_STATE);
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_GET_STATE));

  const pairingUnavailable = (): never => {
    throw new Error('Pairing is unavailable in solo mode.');
  };

  ipcMain.handle(IPC_CHANNELS.PAIR_REQUEST_GENERATE, pairingUnavailable);
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_REQUEST_GENERATE));

  ipcMain.handle(IPC_CHANNELS.PAIR_REQUEST_REDEEM, pairingUnavailable);
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_REQUEST_REDEEM));

  ipcMain.handle(IPC_CHANNELS.PAIR_REQUEST_UNPAIR, (): void => {
    // Solo mode has no relay pair state to tear down.
  });
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_REQUEST_UNPAIR));

  ipcMain.handle(IPC_CHANNELS.PAIR_DISMISS_LOST_HINT, (): void => {
    // No-op: solo never sets pair-lost UI state.
  });
  handlers.push(() => ipcMain.removeHandler(IPC_CHANNELS.PAIR_DISMISS_LOST_HINT));

  return () => {
    for (const h of handlers) h();
  };
}

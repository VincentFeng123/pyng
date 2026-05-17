import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type OverlayClearPingsPayload,
  type OverlayEnterPingModePayload,
  type OverlayExitPingModePayload,
  type OverlayPingModeClickPayload,
  type OverlayShowPingPayload,
  type OverlayUpdatePingPositionPayload,
} from '@pyng/shared';

type Unsubscribe = () => void;

function subscribe<Payload>(channel: string, cb: (payload: Payload) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: Payload): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pyng', {
  onShowPing(cb: (payload: OverlayShowPingPayload) => void): Unsubscribe {
    return subscribe(IPC_CHANNELS.OVERLAY_SHOW_PING, cb);
  },
  onClearPings(cb: (payload: OverlayClearPingsPayload) => void): Unsubscribe {
    return subscribe(IPC_CHANNELS.OVERLAY_CLEAR_PINGS, cb);
  },
  onEnterPingMode(cb: (payload: OverlayEnterPingModePayload) => void): Unsubscribe {
    return subscribe(IPC_CHANNELS.OVERLAY_ENTER_PING_MODE, cb);
  },
  onExitPingMode(cb: (payload: OverlayExitPingModePayload) => void): Unsubscribe {
    return subscribe(IPC_CHANNELS.OVERLAY_EXIT_PING_MODE, cb);
  },
  sendPingModeClick(payload: OverlayPingModeClickPayload): void {
    ipcRenderer.send(IPC_CHANNELS.OVERLAY_PING_MODE_CLICK, payload);
  },
  onUpdatePingPosition(cb: (payload: OverlayUpdatePingPositionPayload) => void): Unsubscribe {
    return subscribe(IPC_CHANNELS.OVERLAY_UPDATE_PING_POSITION, cb);
  },
});

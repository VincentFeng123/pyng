import { ipcMain, type BrowserWindow } from 'electron';
import { IPC_CHANNELS, type CalibrationResultPayload } from '@pyng/shared';
import { saveCalibrationData } from '../settings.js';
import type { TrackingLoop } from './tracking-loop.js';

const CALIBRATION_PPD_MIN = 1.0;
const CALIBRATION_PPD_MAX = 50.0;
const DEFAULT_PPD = 8.0;

let isCalibrating = false;
let calibrationStartMs = 0;
let totalOpticalFlowPx = 0;
let totalMouseDeltaPx = 0;

let _trackingLoop: TrackingLoop | null = null;
let _mouseUnsubscribe: (() => void) | null = null;

export function setCalibrationTrackingLoop(loop: TrackingLoop, mouseUnsubscribe: () => void): void {
  _trackingLoop = loop;
  _mouseUnsubscribe = mouseUnsubscribe;
}

export function notifyCalibrationMouseDelta(dx: number, _dy: number): void {
  if (!isCalibrating) return;
  totalMouseDeltaPx += Math.abs(dx);
}

function clampPpd(value: number): number {
  if (!Number.isFinite(value) || value < CALIBRATION_PPD_MIN || value > CALIBRATION_PPD_MAX) {
    return DEFAULT_PPD;
  }
  return value;
}

export function registerCalibrationHandlers(getMainWindow: () => BrowserWindow | null): () => void {
  const startHandler = (_e: Electron.IpcMainInvokeEvent): void => {
    if (isCalibrating) return;

    if (_trackingLoop === null || !_trackingLoop.isRunning()) {
      console.warn('[calibration] tracking not running; returning default values');
      const result: CalibrationResultPayload = {
        pixelsPerDegree: DEFAULT_PPD,
        mousePixelsPerDegree: DEFAULT_PPD,
        durationMs: 0,
      };
      getMainWindow()?.webContents.send(IPC_CHANNELS.CALIBRATION_RESULT, result);
      return;
    }

    isCalibrating = true;
    calibrationStartMs = Date.now();
    totalOpticalFlowPx = 0;
    totalMouseDeltaPx = 0;

    _trackingLoop.setObserver((motion) => {
      if (!isCalibrating) return;
      if (motion.source !== 'optical') return;
      totalOpticalFlowPx += Math.abs(motion.dx);
    });
  };

  const stopHandler = (_e: Electron.IpcMainInvokeEvent): void => {
    if (!isCalibrating) return;
    isCalibrating = false;
    const durationMs = Date.now() - calibrationStartMs;

    _trackingLoop?.setObserver(null);

    // pixelsPerDegree = totalPx traversed over one full 360° rotation
    const rawPpd = totalOpticalFlowPx / 360;
    const rawMousePpd = totalMouseDeltaPx / 360;

    const pixelsPerDegree = clampPpd(rawPpd);
    const mousePixelsPerDegree = clampPpd(rawMousePpd);

    if (rawPpd < CALIBRATION_PPD_MIN || rawPpd > CALIBRATION_PPD_MAX) {
      console.warn(
        `[calibration] optical ppd=${rawPpd.toFixed(2)} out of range [${CALIBRATION_PPD_MIN}, ${CALIBRATION_PPD_MAX}]; using default ${DEFAULT_PPD}`,
      );
    }
    if (rawMousePpd < CALIBRATION_PPD_MIN || rawMousePpd > CALIBRATION_PPD_MAX) {
      console.warn(
        `[calibration] mouse ppd=${rawMousePpd.toFixed(2)} out of range [${CALIBRATION_PPD_MIN}, ${CALIBRATION_PPD_MAX}]; using default ${DEFAULT_PPD}`,
      );
    }

    const result: CalibrationResultPayload = {
      pixelsPerDegree,
      mousePixelsPerDegree,
      durationMs,
    };
    getMainWindow()?.webContents.send(IPC_CHANNELS.CALIBRATION_RESULT, result);

    saveCalibrationData({ pixelsPerDegree, mousePixelsPerDegree, calibratedAt: Date.now() });
  };

  ipcMain.handle(IPC_CHANNELS.CALIBRATION_START, startHandler);
  ipcMain.handle(IPC_CHANNELS.CALIBRATION_STOP, stopHandler);

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.CALIBRATION_START);
    ipcMain.removeHandler(IPC_CHANNELS.CALIBRATION_STOP);
    if (isCalibrating) {
      isCalibrating = false;
      _trackingLoop?.setObserver(null);
    }
    _trackingLoop = null;
    _mouseUnsubscribe = null;
  };
}

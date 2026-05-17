import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrackingConfig, NormalizedRect } from '@pyng/shared';

const GAMES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'games');
const ALLOWED_GAMES = new Set(['phantom-forces']);

export function loadGameConfig(gameId: string): TrackingConfig {
  if (!ALLOWED_GAMES.has(gameId)) {
    throw new Error(`Unknown gameId: ${gameId}. Allowed: ${[...ALLOWED_GAMES].join(', ')}`);
  }
  const filePath = path.join(GAMES_DIR, `${gameId}.json`);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as TrackingConfig;
}

export function getMaskRegions(config: TrackingConfig): NormalizedRect[] {
  return config.trackingMask.exclude;
}

export function computeFovV(fovH: number, screenWidth: number, screenHeight: number): number {
  const fovHRad = (fovH * Math.PI) / 180;
  const fovVRad = 2 * Math.atan(Math.tan(fovHRad / 2) * (screenHeight / screenWidth));
  return (fovVRad * 180) / Math.PI;
}

// Thin tsx-side launcher that spawns Electron with NODE_OPTIONS='--import tsx'
// set, so the .ts test runner and test files can be loaded directly.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'run-electron-tests.ts');
const ELECTRON = path.resolve(HERE, '..', '..', 'node_modules', '.bin', 'electron');

const proc = spawn(ELECTRON, [RUNNER], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: '--import tsx',
  },
});
proc.on('exit', (code) => process.exit(code ?? 1));

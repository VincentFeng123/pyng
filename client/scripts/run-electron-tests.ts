// Electron-side test runner. Boots Electron, runs node:test against test files
// that explicitly require Electron's main-process APIs (currently:
// avatarNormalize.test.ts, which calls nativeImage). Other tests run under
// plain Node via `npm test`. Invoked via `npm run test:electron`.
import { app } from 'electron';
import { run } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  path.resolve(HERE, '..', 'src', 'main', 'avatarNormalize.test.ts'),
  path.resolve(HERE, '..', 'src', 'main', 'tray.test.ts'),
  path.resolve(HERE, '..', 'src', 'main', 'opencv-sanity.test.ts'),
];
const QUIESCE_MS = 500;

app.whenReady().then(() => {
  process.stdout.write(`# running ${FILES.length} Electron-only test file(s)\n`);
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let quiesce: NodeJS.Timeout | null = null;

  const finish = (): void => {
    process.stdout.write(
      `# tests ${pass + fail + skip}\n# pass ${pass}\n# fail ${fail}\n# skip ${skip}\n`,
    );
    app.exit(fail === 0 ? 0 : 1);
  };

  const bump = (): void => {
    if (quiesce) clearTimeout(quiesce);
    quiesce = setTimeout(finish, QUIESCE_MS);
  };

  // isolation:'none' runs tests in-process so Electron's main-process APIs
  // (Tray, BrowserWindow, app) are usable post-app-ready. The default
  // subprocess isolation would launch plain-Node children that lack the
  // Electron runtime entirely. The cast is because @types/node 20.x predates
  // the isolation option; Node 22 runtime accepts it.
  const stream = run({ files: FILES, isolation: 'none' } as Parameters<typeof run>[0]);
  stream.on('test:pass', (e) => {
    if (e.skip) {
      skip++;
      process.stdout.write(`ok - ${e.name} # SKIP\n`);
    } else {
      pass++;
      process.stdout.write(`ok - ${e.name}\n`);
    }
    bump();
  });
  stream.on('test:fail', (e) => {
    fail++;
    process.stdout.write(`not ok - ${e.name}\n  ${String(e.details?.error ?? e)}\n`);
    bump();
  });
  stream.on('test:stderr', (e) => {
    process.stdout.write(`# stderr: ${e.message}`);
    bump();
  });
  stream.on('test:diagnostic', (e) => {
    process.stdout.write(`# diag: ${e.message}\n`);
    bump();
  });
  stream.on('end', finish);
  // Initial debounce in case run() emits everything synchronously and 'end'
  // doesn't fire (observed under Electron 42).
  bump();
});

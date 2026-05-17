// Pre-builds ALL runtime assets for the packaged installer:
//   - Main process (.ts) → src/main/index.cjs
//   - Main preload (.ts) → src/main/main-preload.cjs
//   - Overlay preload (.ts) → src/main/overlay-preload.cjs
//   - Renderer entrypoint (.tsx) → src/renderer/main.js
//   - Overlay renderer (.ts) → src/overlay/overlay.js
//   - Overlay renderer support modules (.ts) → matching .js outputs
//
// In dev, overlay.ts's prepareMainAssets/prepareOverlayAssets calls esbuild at
// app startup to compile these same files. For the packaged build we want
// zero runtime tooling: the asar ships only the compiled artifacts + static
// HTML + assets, no node_modules needed for renderer rebuilds. The startup
// esbuild calls become no-ops because the outputs already exist (esbuild
// happily rebuilds atop existing files; no behavior change in dev).
import { build, type BuildOptions } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '..');
const SRC_MAIN = path.join(CLIENT_ROOT, 'src', 'main');
const SRC_RENDERER = path.join(CLIENT_ROOT, 'src', 'renderer');
const SRC_OVERLAY = path.join(CLIENT_ROOT, 'src', 'overlay');

const MAIN_BANNER = 'var __pyng_import_meta_url = require("url").pathToFileURL(__filename).href;';
const BUILD_RELAY_URL = process.env.PYNG_BUILD_RELAY_URL ?? process.env.PYNG_RELAY_URL ?? '';
const MAIN_DEFINE = {
  'import.meta.url': '__pyng_import_meta_url',
  __PYNG_BUILD_RELAY_URL__: JSON.stringify(BUILD_RELAY_URL),
};

const tasks: Array<BuildOptions & { label: string }> = [
  {
    label: 'main',
    entryPoints: [path.join(SRC_MAIN, 'index.ts')],
    outfile: path.join(SRC_MAIN, 'index.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // electron + esbuild stay external (runtime-provided / native). Native
    // deps stay external too (asarUnpack keeps them on disk so dlopen works).
    // Native OpenCV must stay external so the compiled .node binding can be
    // loaded from node_modules at runtime.
    external: ['electron', 'uiohook-napi', 'esbuild', '@u4/opencv4nodejs'],
    sourcemap: 'linked',
    banner: { js: MAIN_BANNER },
    define: MAIN_DEFINE,
  },
  {
    label: 'ocr-worker',
    entryPoints: [path.join(SRC_MAIN, 'ocr', 'worker.ts')],
    outfile: path.join(SRC_MAIN, 'ocr', 'worker.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    // ESM output because worker.ts uses top-level await against tesseract.js's
    // async createWorker(). Worker threads loaded by `new Worker(path)` resolve
    // module format via the file's package.json `type: "module"`. Output is
    // .js (not .mjs) because the OcrLoop call site passes the path to Worker
    // unchanged; with `type: module` in client/package.json the .js loads as
    // ESM. CJS output would require restructuring the worker around an IIFE.
    format: 'esm',
    // tesseract.js-core ships WASM — must stay external so asarUnpack keeps it
    // on disk at runtime (Worker threads can't load WASM from inside asar).
    external: ['electron', 'tesseract.js-core', 'tesseract.js'],
    sourcemap: 'linked',
  },
  {
    label: 'main-preload',
    entryPoints: [path.join(SRC_MAIN, 'main-preload.ts')],
    outfile: path.join(SRC_MAIN, 'main-preload.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  },
  {
    label: 'overlay-preload',
    entryPoints: [path.join(SRC_MAIN, 'overlay-preload.ts')],
    outfile: path.join(SRC_MAIN, 'overlay-preload.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
  },
  {
    label: 'renderer',
    entryPoints: [path.join(SRC_RENDERER, 'main.tsx')],
    outfile: path.join(SRC_RENDERER, 'main.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.tsx': 'tsx' },
  },
  {
    label: 'overlay-renderer',
    entryPoints: [path.join(SRC_OVERLAY, 'overlay.ts')],
    outfile: path.join(SRC_OVERLAY, 'overlay.js'),
    format: 'esm',
    target: 'es2022',
    bundle: false,
  },
  {
    // overlay.ts imports tracking-math.ts via `./tracking-math.js` at runtime.
    // bundle:false leaves the import unresolved, so the imported module must
    // be compiled separately or the overlay script fails to load and
    // OVERLAY_SHOW_PING is never received.
    label: 'overlay-tracking-math',
    entryPoints: [path.join(SRC_OVERLAY, 'tracking-math.ts')],
    outfile: path.join(SRC_OVERLAY, 'tracking-math.js'),
    format: 'esm',
    target: 'es2022',
    bundle: false,
  },
  {
    // overlay.ts imports components/edge-arrow.ts via
    // `./components/edge-arrow.js` at runtime. Keep this in lockstep with
    // client/src/main/overlay.ts's dev-time prepareOverlayAssets().
    label: 'overlay-edge-arrow',
    entryPoints: [path.join(SRC_OVERLAY, 'components', 'edge-arrow.ts')],
    outfile: path.join(SRC_OVERLAY, 'components', 'edge-arrow.js'),
    format: 'esm',
    target: 'es2022',
    bundle: false,
  },
];

for (const { label, ...opts } of tasks) {
  await build(opts);
  process.stdout.write(`built ${label}: ${opts.outfile}\n`);
}

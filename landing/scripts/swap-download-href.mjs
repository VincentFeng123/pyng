#!/usr/bin/env node
// Updates landing/index.html's download anchor href from the local installer
// reference (`pyng-Setup-<version>.exe`) to the GitHub release-asset URL.
//
// Run this AFTER the GitHub release has been published — the asset URL has
// to be resolvable, otherwise the deployed landing page would 404 on download.
//
// Usage:
//   node landing/scripts/swap-download-href.mjs <owner> [version]
//
// Example:
//   node landing/scripts/swap-download-href.mjs vfeng 0.2.0
//   → href becomes:
//     https://github.com/vfeng/pyng/releases/download/v0.2.0/pyng-Setup-0.2.0.exe
//
// To restore the local href (e.g., for local preview), run with --restore:
//   node landing/scripts/swap-download-href.mjs --restore [version]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.resolve(HERE, '..', 'index.html');

const args = process.argv.slice(2);
const restore = args.includes('--restore');

if (restore) {
  const version = args.find((a) => !a.startsWith('--')) ?? '0.2.0';
  const localHref = `pyng-Setup-${version}.exe`;
  const html = readFileSync(INDEX_HTML, 'utf8');
  const swapped = html.replace(
    /href="https:\/\/github\.com\/[^"]+\/releases\/download\/v[^"]+\.exe"/,
    `href="${localHref}"`,
  );
  if (swapped === html) {
    console.error('no GitHub release URL found in index.html — already local?');
    process.exit(1);
  }
  writeFileSync(INDEX_HTML, swapped);
  console.log(`restored local href: ${localHref}`);
  process.exit(0);
}

const owner = args[0];
const version = args[1] ?? '0.2.0';

if (!owner) {
  console.error('usage: swap-download-href.mjs <owner> [version]');
  console.error('       swap-download-href.mjs --restore [version]');
  process.exit(2);
}

const assetUrl = `https://github.com/${owner}/pyng/releases/download/v${version}/pyng-Setup-${version}.exe`;
const localHref = `pyng-Setup-${version}.exe`;

const html = readFileSync(INDEX_HTML, 'utf8');
const swapped = html.replace(`href="${localHref}"`, `href="${assetUrl}"`);
if (swapped === html) {
  console.error(`href="${localHref}" not found in ${INDEX_HTML} — already swapped?`);
  process.exit(1);
}
writeFileSync(INDEX_HTML, swapped);
console.log(`swapped href to: ${assetUrl}`);

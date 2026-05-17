# landing

Static landing page for pyng. Pure HTML + CSS, no JS, no build step.

## Files

- `index.html` — single page (headline, download CTA, demo placeholder, how-it-works, beta disclaimer).
- `styles.css` — dark-mode styling. Mirrors the app's palette (`#0e0e10`, `#efeff1`, `#7c3aed`).
- `demo.gif` — placeholder. Replace with the real 15-second screencap when ready and delete the `.demo-placeholder` overlay in `index.html`.
- `pyng-Setup-0.2.0.exe` — installer artifact copied from `client/dist/`. Re-copy on each release.
- `scripts/make-placeholder-gif.mjs` — regenerates the placeholder gif (one-shot, ad-hoc).

## Local preview

```bash
cd landing
python3 -m http.server 8080
# open http://localhost:8080
```

Any static server works; there is no build step.

## Updating the installer

When a new version ships from `client/dist/`:

```bash
cp client/dist/pyng-Setup-<VERSION>.exe landing/pyng-Setup-<VERSION>.exe
```

Then edit `index.html`:
- `href="pyng-Setup-<VERSION>.exe"` on the download anchor.
- The `v<VERSION> · ~<SIZE> MB · Windows 10/11` meta line.

## Hosting the installer

Cloudflare Pages caps individual files at 25 MB. The `pyng-Setup-0.2.0.exe` artifact is ~89 MB, so it cannot ship in the Pages deploy. Use one of:

1. **Recommended:** upload the installer as a release asset on GitHub Releases (per #56), then point the download anchor at the asset URL (e.g., `https://github.com/<owner>/pyng/releases/download/v0.2.0/pyng-Setup-0.2.0.exe`). The `landing/pyng-Setup-0.2.0.exe` checked into the repo is the source of truth for that upload.
2. **Self-hosted:** put the installer on any object store (R2, S3) and update the anchor href.

Vercel has a similar per-file ~100 MB upper bound and would technically fit, but GitHub Releases is the cleaner pattern for desktop binaries — versioning, checksums, and changelog all in one place.

After the user uploads to GitHub Releases, swap the download anchor's href via the helper script:

```bash
node landing/scripts/swap-download-href.mjs <owner> 0.2.0
```

That rewrites `href="pyng-Setup-0.2.0.exe"` in `index.html` to the GitHub release-asset URL. To restore the local href for previewing the page against `landing/pyng-Setup-0.2.0.exe`:

```bash
node landing/scripts/swap-download-href.mjs --restore 0.2.0
```

The local copy in `landing/` remains useful for local previews and as the staging artifact (it's the file that gets uploaded to GitHub Releases). Note: `landing/*.exe` is gitignored — the local installer is never committed, it's re-copied from `client/dist/` on each release.

## Deploying the page to Cloudflare Pages

### One-time setup (user task)

1. Create a Cloudflare account.
2. `npm i -g wrangler` (or use the dashboard UI).
3. `wrangler login`.

### Deploy

From the repo root, excluding the installer (which lives on GitHub Releases):

```bash
npx wrangler pages deploy landing --project-name=pyng --commit-dirty=true --branch=main
```

If the installer is still present locally and the deploy fails on the 25 MB cap, temporarily move it out of `landing/` before deploying:

```bash
mv landing/pyng-Setup-0.2.0.exe /tmp/pyng-installer.exe
npx wrangler pages deploy landing --project-name=pyng
mv /tmp/pyng-installer.exe landing/pyng-Setup-0.2.0.exe
```

The output URL is `https://pyng.pages.dev` (or `https://<deploy-id>.pyng.pages.dev` for preview deploys).

### Domain (user task)

The `pyng.pages.dev` subdomain is fine for the soft launch. A custom domain is recommended for a public launch:

- `pyng.app` (~$15/yr, on-brand).
- `pyng.gg` (~$30-50/yr, gaming TLD).
- `pyng.dev` (~$15/yr).

Once a domain is registered, point it at Cloudflare Pages in the dashboard: **Workers & Pages → pyng → Custom domains → Set up a custom domain**.

## Alternative: Vercel

```bash
cd landing
npx vercel --prod
```

Vercel auto-detects the static directory. The same domain steps apply.

## Hard rules

- No JS unless strictly necessary. Currently zero JS.
- No tracking pixels, analytics, or third-party scripts.
- No remote fonts. System sans-serif via the CSS `font-family` stack.
- Total page weight (excluding the installer download) under 6 MB. The placeholder gif is ~110 KB; the real gif must compress to under ~5 MB.

## Out of scope

Multi-page site, email signup, blog, documentation site, login, server status page.

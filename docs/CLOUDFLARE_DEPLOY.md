# Cloudflare Deployment

Pyng has two relay targets:

- `server/`: the existing Node/WebSocket relay for Railway.
- `cloudflare/`: the Cloudflare Workers + Durable Objects relay.

Use the Cloudflare target for the free full deployment path. It hosts the WebSocket relay and stores long-term pair records in a SQLite-backed Durable Object. No Neon, Supabase, D1, or Railway database is required for this path.

## What Gets Deployed

`@pyng/cloudflare-relay` deploys a Worker named `pyng-relay`.

The Worker routes WebSocket upgrades into one Durable Object namespace:

```text
Electron clients
  -> wss://pyng-relay.<your-subdomain>.workers.dev
  -> Cloudflare Worker
  -> PairRelay Durable Object
  -> SQLite-backed Durable Object storage
```

The Durable Object stores:

- active pairing codes
- durable pair group records
- peer avatar and username cache for connected sessions

The Electron client now saves the durable `groupId` locally and sends `pair:resume` after reconnect. Manual unpair sends `pair:revoke`, which revokes the durable group on Cloudflare.

## Initial Cloudflare Setup

1. Go to `https://dash.cloudflare.com/sign-up`.
2. Create an account or sign in.
3. In the Cloudflare dashboard, open **Workers & Pages** once so Cloudflare initializes the Workers area.
4. Back in this repo, authenticate Wrangler:

```bash
npx wrangler login
```

5. Your browser opens a Cloudflare authorization screen.
6. Select your Cloudflare account.
7. Click **Allow**.
8. Return to the terminal. Wrangler should print that login succeeded.

## Deploy The Relay

From the repo root:

```bash
npm install
npm run lint --workspace @pyng/cloudflare-relay
npm run deploy:cloudflare
```

The deploy command prints a URL like:

```text
https://pyng-relay.<your-subdomain>.workers.dev
```

For the Electron app, convert it to WebSocket form:

```text
wss://pyng-relay.<your-subdomain>.workers.dev
```

## Deploy From The Cloudflare Dashboard

Use these settings if you connect GitHub directly in the Cloudflare dashboard.

The important part is the project root. This repository is a monorepo, and the
repo root contains the Electron app. If Cloudflare installs from the repo root,
it tries to build the desktop OpenCV dependency and the Worker deploy fails.

1. Open `https://dash.cloudflare.com`.
2. Click **Workers & Pages**.
3. Click the `pyng-relay` Worker.
4. Click **Settings**.
5. Click **Build** or **Builds**.
6. Under **Git Repository**, connect `VincentFeng123/pyng` if it is not already connected.
7. Set **Production branch** to `main`.
8. Set **Root directory** to:

```text
cloudflare
```

9. Leave **Build command** empty.
10. Set **Deploy command** to:

```bash
npm run deploy
```

11. If Cloudflare shows **Non-production branch deploy command**, set it to:

```bash
npx wrangler versions upload
```

12. Save the build settings.
13. Retry the failed deployment, or push a new commit.

This makes Cloudflare run `npm clean-install` inside `cloudflare/`, using
`cloudflare/package-lock.json`. It installs only the Worker dependencies and the
shared protocol package, not the Electron client dependencies.

## Check The Relay

Run:

```bash
curl https://pyng-relay.<your-subdomain>.workers.dev/healthz
```

Expected output:

```text
ok
```

## Build The Electron App Against Cloudflare

Use the Worker WebSocket URL as a build-time default:

```bash
PYNG_BUILD_RELAY_URL=wss://pyng-relay.<your-subdomain>.workers.dev npm run build:main --workspace client
```

For a full Windows installer build:

```bash
PYNG_BUILD_RELAY_URL=wss://pyng-relay.<your-subdomain>.workers.dev npm run build --workspace client
```

`PYNG_RELAY_URL` still works as a runtime override for local testing, but `PYNG_BUILD_RELAY_URL` bakes the Cloudflare relay into packaged builds.

## Optional Custom Domain

Use this if you want `wss://relay.yourdomain.com` instead of a `workers.dev` URL.

1. Open `https://dash.cloudflare.com`.
2. Click **Workers & Pages**.
3. Click the `pyng-relay` Worker.
4. Click **Settings**.
5. Click **Domains & Routes**.
6. Click **Add**.
7. Choose **Custom domain**.
8. Enter `relay.yourdomain.com`.
9. Click **Add domain**.
10. Wait for Cloudflare to show the domain as active.
11. Rebuild the Electron app with:

```bash
PYNG_BUILD_RELAY_URL=wss://relay.yourdomain.com npm run build --workspace client
```

## Useful Commands

Local Worker dev server:

```bash
npm run dev:cloudflare
```

Deploy:

```bash
npm run deploy:cloudflare
```

Type-check the Cloudflare relay:

```bash
npm run lint --workspace @pyng/cloudflare-relay
```

Tail Cloudflare logs after deployment:

```bash
npx wrangler tail pyng-relay
```

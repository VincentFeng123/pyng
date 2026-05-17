# Deploying the pyng relay to Railway

The relay is a single Node.js + ws process behind Railway's HTTPS termination.
This doc covers the **first-time deploy** and the routine **redeploy**. It is
written for the maintainer using the Railway dashboard, not for end users.

## Prerequisites

- A GitHub account.
- The pyng repo pushed to GitHub (user-task; not covered here).
- A Railway account at https://railway.app. Free tier ships with a $5/mo
  credit, sufficient for the v2 always-on relay.

## First-time deploy

The deploy config lives at `/Users/vincentfeng/Documents/pyng/railway.json`
(repo root). Railway reads this on every build and uses NIXPACKS to detect
the Node + npm-workspaces layout automatically. The start command points
explicitly at the `@pyng/server` workspace.

1. Sign in at https://railway.app.
2. Click **New Project → Deploy from GitHub repo**.
3. Authorize Railway against the org/account hosting the pyng repo, then
   select the pyng repo.
4. Railway reads `railway.json` from the repo root, runs `npm install` at
   the root (workspaces flag is implicit), and starts the server via
   `npm run start --workspace=@pyng/server`.
5. Wait for the first deploy. The build log streams in the Railway dashboard.
   The `/healthz` healthcheck (configured in `railway.json`) gates the
   deploy going live.
6. Railway auto-assigns a public hostname, typically
   `pyng-relay.up.railway.app`. (To pin this name: Settings → Networking →
   Generate Domain, then pick the slug.)
7. Verify HTTPS healthcheck:

   ```bash
   curl https://pyng-relay.up.railway.app/healthz
   # Expect: ok
   ```

8. Verify the WebSocket handshake. Install wscat if needed (`npm i -g wscat`):

   ```bash
   wscat -c wss://pyng-relay.up.railway.app
   > {"type":"hello","payload":{"clientVersion":"0.0.0","platform":"linux"},"messageId":"manual-test","timestamp":0}
   # Expect a welcome envelope back.
   ```

The hardcoded production URL in `client/src/main/config.ts` is
`wss://pyng-relay.up.railway.app`. If you change the Railway-assigned
domain or pin a custom one, update that constant (see task #64).

## Redeploy

Railway watches the linked GitHub branch (default: `main`). Every push to
that branch triggers a build + redeploy automatically. No CLI needed:

```bash
git push origin main
# Railway picks it up within ~30 seconds.
```

The healthcheck gates the new deployment going live; if `/healthz` doesn't
return 200 within `healthcheckTimeout` (100 seconds, per `railway.json`),
Railway holds the previous version live and surfaces the failure in the
dashboard.

## Operational notes

- **Region:** Railway picks a US region by default. Median NA round-trip is
  well under the 500ms end-to-end budget. If non-NA users show up at scale,
  add a second deployment in a different region.
- **Always-on:** Railway keeps the service running 24/7 — there's no Fly-style
  idle-stop semantics. Heartbeat (server-side, 30s ping/pong) is still active
  so transient proxy intermediaries don't drop sockets.
- **Memory:** Railway defaults to 512 MB per service. Each WebSocket
  connection costs ~10 KB of buffers plus the in-memory group state. At v2
  scale this is wildly oversized.
- **Heartbeat:** the server pings every 30s and terminates sockets that
  miss two pongs in a row. See `server/src/index.ts` for the implementation.
- **Logs:** Railway's dashboard streams stdout. Each log line is a single
  JSON object. The server NEVER logs payload contents — only metadata
  (type, sessionId, groupId, recipientCount, rejection reason).

## Rollback

In the Railway dashboard:

- **Deployments** tab → click the green-checked previous deploy → **Redeploy**.

Or in a pinch (zero-downtime not guaranteed):

- Settings → Service → **Pause Service** (clients fail closed; the WsClient
  retries with backoff once the service is unpaused).
- Settings → Service → **Resume Service**.

## Monorepo / NIXPACKS notes

The `startCommand` in `railway.json` invokes `npm run start --workspace=@pyng/server`,
which runs from the repo root. The NIXPACKS builder runs `npm install`
without explicit workspace flags by default, but our root `package.json`
declares `workspaces: ["shared", "server", "client"]`, so npm picks them
up automatically.

If NIXPACKS detection fails (rare; usually visible as a build error about a
missing workspace package), fall back to an explicit `Procfile` at the repo
root:

```
web: npm install && npm run start --workspace=@pyng/server
```

Then push and let Railway re-detect.

## Cost / SLA expectations

This is a side project. There is no SLA. Railway's $5/mo free credit covers
the always-on v2 relay (estimated ~$1–2/mo usage). If the bill exceeds the
credit, evaluate Fly.io, Render, or a $5 DIY VPS.

# PlanHub Telemetry Backend (Cloudflare Worker + D1)

Central backend that receives heartbeats and events from the 30 scraper laptops and serves data to the two panels.

Everything runs on Cloudflare's free tier: Workers (API), D1 (SQLite), and eventually Pages (the panels).

---

## One-time setup

Do this once, on your dev machine, from this `backend/` folder.

### 1. Install wrangler (Cloudflare's CLI)

```
npm install
```

### 2. Log in to Cloudflare

```
npx wrangler login
```

Opens a browser for you to authorize. You only do this once per machine.

### 3. Create the D1 database

```
npx wrangler d1 create planhub-telemetry
```

Wrangler prints a block like this — copy the `database_id`:

```
[[d1_databases]]
binding = "DB"
database_name = "planhub-telemetry"
database_id = "abc123-..."
```

Paste that `database_id` into `wrangler.toml` (replace the `PASTE-DATABASE-ID-HERE` placeholder).

### 4. Create the tables

```
npm run db:init
```

### 5. Set the two bearer-token secrets

These are shared passwords — scrapers use `INGEST_TOKEN` to write, panels use `READ_TOKEN` to read.

Generate two strong random strings:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it twice to get two different tokens. Then:

```
npx wrangler secret put INGEST_TOKEN
# paste first token, press enter

npx wrangler secret put READ_TOKEN
# paste second token, press enter
```

Save both tokens somewhere safe — you'll need `INGEST_TOKEN` for every laptop's `.env`, and `READ_TOKEN` for the panel configs.

### 6. Deploy

```
npm run deploy
```

Wrangler prints the live URL, something like:

```
https://planhub-telemetry.<your-subdomain>.workers.dev
```

Test it:

```
curl https://planhub-telemetry.<your-subdomain>.workers.dev/health
# -> {"ok":true,"service":"planhub-telemetry"}
```

Backend is live. No more ops.

---

## Deploying updates later

After editing `src/index.js`:

```
npm run deploy
```

That's it — zero downtime, takes about 5 seconds.

If you change `schema.sql`, apply it with:

```
npm run db:init
```

(D1 migrations are manual for now. If we change schemas often later, we can add a migrations folder.)

---

## API reference

All endpoints return JSON. Writes require `Authorization: Bearer <INGEST_TOKEN>`, reads require `Authorization: Bearer <READ_TOKEN>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/heartbeat` | Scraper sends status every 60s |
| POST | `/api/quarantine` | Scraper reports a failed project |
| POST | `/api/run-complete` | Scraper reports end-of-run summary |
| POST | `/api/companies` | Scraper batch-uploads scraped companies |
| GET  | `/api/laptops` | Panel: list all laptops + latest status |
| GET  | `/api/quarantine?unresolved=1` | Panel: list recent failures |
| GET  | `/api/stats` | Owner panel: aggregate counts |
| GET  | `/api/config` | Panel: current fleet config |
| POST | `/api/config` | Admin panel: flip a config key |
| POST | `/api/quarantine/resolve` | Admin panel: mark failure resolved |

Heartbeat response includes the current `config` so a laptop can react to e.g. `paused=true` on the next tick.

---

## Local dev

```
npm run dev
```

Starts a local worker on `localhost:8787`. `npm run db:local` creates a local D1 that's separate from prod.

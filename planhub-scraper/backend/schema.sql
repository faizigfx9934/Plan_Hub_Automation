-- PlanHub telemetry schema for Cloudflare D1
-- Run: wrangler d1 execute planhub-telemetry --file=backend/schema.sql

-- One row per laptop in the fleet. Updated on every heartbeat.
CREATE TABLE IF NOT EXISTS laptops (
  id TEXT PRIMARY KEY,                 -- LAPTOP_ID from .env
  state TEXT,                          -- US state this laptop scrapes
  first_seen INTEGER,                  -- epoch ms, first ever heartbeat
  last_seen INTEGER,                   -- epoch ms, latest heartbeat
  status TEXT,                         -- 'idle' | 'running' | 'error' | 'stopped'
  current_project TEXT,                -- name of project currently being scraped
  last_error TEXT,                     -- latest error message (for quick glance)
  companies_today INTEGER DEFAULT 0,   -- rolling 24h company count
  version TEXT                         -- git commit hash the laptop is running
);

-- Time-series of heartbeats. Pruned to last 30 days by a scheduled trigger (see below).
CREATE TABLE IF NOT EXISTS heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  laptop_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                 -- epoch ms
  status TEXT,
  current_project TEXT,
  elapsed_ms INTEGER,                  -- how long this run has been going
  companies_today INTEGER
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_laptop_ts ON heartbeats(laptop_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_heartbeats_ts ON heartbeats(ts DESC);

-- Every project that failed mid-run. Admin panel shows these.
CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  laptop_id TEXT NOT NULL,
  project TEXT,
  error TEXT,
  stack TEXT,
  date_range TEXT,
  ts INTEGER NOT NULL,
  resolved INTEGER DEFAULT 0           -- admin can mark resolved from panel
);
CREATE INDEX IF NOT EXISTS idx_quarantine_ts ON quarantine(ts DESC);
CREATE INDEX IF NOT EXISTS idx_quarantine_unresolved ON quarantine(resolved, ts DESC);

-- One row per scraper-run (8.5hr session). Summary metrics.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  laptop_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  companies_scraped INTEGER,
  new_companies INTEGER,
  date_ranges INTEGER,
  quarantined INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_laptop ON runs(laptop_id, started_at DESC);

-- Canonical data: every subcontractor ever scraped. Feeds owner-panel CSV export.
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  laptop_id TEXT,
  state TEXT,
  project TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  scraped_at INTEGER,
  UNIQUE(state, project, company)      -- dedup safety net across laptops
);
CREATE INDEX IF NOT EXISTS idx_companies_state ON companies(state);
CREATE INDEX IF NOT EXISTS idx_companies_scraped ON companies(scraped_at DESC);

-- Fleet-wide config the admin can flip from the panel without a code deploy.
-- Read by the scraper at startup.
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);
INSERT OR IGNORE INTO config (key, value, updated_at) VALUES
  ('paused', 'false', unixepoch() * 1000),
  ('max_runtime_hours', '8.5', unixepoch() * 1000);

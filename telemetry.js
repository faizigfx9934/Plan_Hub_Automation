// Telemetry client — talks to the Cloudflare Worker backend.
//
// All functions are fire-and-forget. If the backend is down or the network is
// flaky, we log and swallow the error — a telemetry failure must NEVER break
// an 8.5hr scraping run.

import { logger } from './logger.js';

const BASE = process.env.TELEMETRY_URL || '';
const TOKEN = process.env.INGEST_TOKEN || '';
const LAPTOP_ID = process.env.LAPTOP_ID || 'unknown-laptop';
const STATE = process.env.STATE || '';

const isEnabled = () => Boolean(BASE && TOKEN);

async function post(path, body, { timeoutMs = 10000 } = {}) {
  if (!isEnabled()) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.fail(`📡 telemetry ${path} → ${res.status}: ${data.error || 'unknown'}`);
      return null;
    }
    return data;
  } catch (err) {
    logger.fail(`📡 telemetry ${path} failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- Public API ----

// State shared with the heartbeat so the loop can read current progress.
export const state = {
  startedAt: Date.now(),
  currentProject: null,
  companiesToday: 0,
  status: 'idle',        // 'idle' | 'running' | 'error' | 'stopped'
  version: null,         // set by scraper if we detect git commit hash
  remoteConfig: {},      // last config received from server (e.g., paused)
};

export function setCurrentProject(name) {
  state.currentProject = name;
  state.status = 'running';
}

export function incCompanies(n = 1) {
  state.companiesToday += n;
}

export function setStatus(s) {
  state.status = s;
}

// Start background heartbeat loop. Returns a stop function.
export function startHeartbeat({ intervalMs = 30_000 } = {}) {
  if (!isEnabled()) {
    logger.info('📡 Telemetry disabled (TELEMETRY_URL or INGEST_TOKEN missing)');
    return () => {};
  }
  logger.ok(`📡 Telemetry enabled — heartbeats to ${BASE}`);
  const tick = async () => {
    const resp = await post('/api/heartbeat', {
      laptop_id: LAPTOP_ID,
      state: STATE,
      status: state.status,
      current_project: state.currentProject,
      elapsed_ms: Date.now() - state.startedAt,
      companies_today: state.companiesToday,
      version: state.version,
    });
    if (resp?.config) state.remoteConfig = resp.config;
  };
  // fire one immediately so the laptop shows up in the panel fast
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

export async function reportQuarantine({ project, error, stack, dateRange }) {
  setStatus('error');
  await post('/api/quarantine', {
    laptop_id: LAPTOP_ID,
    project,
    error,
    stack,
    date_range: dateRange,
  });
}

export async function reportCompanies(companies) {
  if (!companies?.length) return;
  await post('/api/companies', {
    laptop_id: LAPTOP_ID,
    state: STATE,
    companies: companies.map((c) => ({
      project: c.project,
      company: c.company,
      email: c.email,
      phone: c.phone,
      website: c.website,
      scraped_at: Date.parse(c.scrapedAt) || Date.now(),
    })),
  });
}

export async function reportRunComplete(summary) {
  setStatus('stopped');
  await post('/api/run-complete', {
    laptop_id: LAPTOP_ID,
    started_at: state.startedAt,
    companies_scraped: summary.companiesScraped ?? 0,
    new_companies: summary.newCompanies ?? 0,
    date_ranges: summary.dateRanges ?? 0,
    quarantined: summary.quarantined ?? 0,
  });
}

export function isPaused() {
  return state.remoteConfig.paused === 'true';
}

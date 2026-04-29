import { logger } from './logger.js';
import 'dotenv/config';

const TELEMETRY_URL = process.env.TELEMETRY_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const LAPTOP_ID = process.env.LAPTOP_ID || 'Unknown';

const state = {
  logBuffer: [],
  startedAt: Date.now(),
  currentStatus: 'idle',
  remoteConfig: { paused: 'false' },
};

export function isEnabled() {
  return !!(TELEMETRY_URL && INGEST_TOKEN);
}

async function post(path, body, { timeoutMs = 10000, retries = 3 } = {}) {
  if (!isEnabled()) return false;

  for (let i = 0; i < retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(`${TELEMETRY_URL}${path}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Authorization': `Bearer ${INGEST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        if (path === '/api/heartbeat') {
          const data = await res.json();
          if (data.config) state.remoteConfig = data.config;
        }
        return true;
      } else {
        const text = await res.text().catch(() => '');
        logger.fail(`[TELEMETRY] ${path} failed with status ${res.status}: ${text.slice(0, 100)}`);
      }
    } catch (e) {
      if (i === retries - 1) {
        logger.fail(`[TELEMETRY] ${path} connection error: ${e.message}`);
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise(r => setTimeout(r, 1000)); // Wait before retry
  }
  return false;
}

export function setStatus(status) {
  state.currentStatus = status;
}

export function addLog(message, level = 'info') {
  const cleanMessage = typeof message === 'string' ? message.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '') : String(message);
  state.logBuffer.push({ message: cleanMessage, level, ts: Date.now() });
  if (state.logBuffer.length > 500) state.logBuffer.shift();
}

async function uploadLogBatch() {
  if (state.logBuffer.length === 0) return;
  const logs = [...state.logBuffer];
  state.logBuffer = [];
  const ok = await post('/api/logs', { laptop_id: LAPTOP_ID, logs });
  if (!ok) {
    state.logBuffer = [...logs, ...state.logBuffer].slice(0, 500);
  }
}

export function startHeartbeat({ intervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 5000) } = {}) {
  if (!isEnabled()) return () => {};

  let timer = null;
  const tick = async () => {
    const context = logger.getContext?.() || 'Idle';
    const payload = {
      laptop_id: LAPTOP_ID,
      status: state.currentStatus,
      state: process.env.STATE || 'CA',
      current_project: context,
      project: context,
      companies_today: state.companiesToday || 0, // NEW: Pass the count to the dashboard
    };
    
    await post('/api/heartbeat', payload);
    await uploadLogBatch();
    timer = setTimeout(tick, intervalMs);
  };

  tick();
  return () => clearTimeout(timer);
}

export function setCompaniesToday(count) {
  state.companiesToday = count;
}

export async function reportStopping() {
  setStatus('idle');
  await post('/api/heartbeat', {
    laptop_id: LAPTOP_ID,
    status: 'idle',
    current_project: '(offline)',
    companies_today: state.companiesToday || 0,
  }, { timeoutMs: 5000, retries: 3 });
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

export async function reportCompanies(companies) {
  if (!companies || companies.length === 0) return;
  
  const payload = {
    laptop_id: LAPTOP_ID,
    state: process.env.STATE || 'CA',
    companies: companies.map(c => ({
      ...c,
      laptop_id: LAPTOP_ID,
      state: process.env.STATE || 'CA',
      scraped_at: typeof c.scraped_at === 'number' ? c.scraped_at : Date.now(), // Critical: Backend query > expects number
    }))
  };

  const ok = await post('/api/companies', payload);

  if (ok) {
    // Force immediate heartbeat with latest info
    await post('/api/heartbeat', {
      laptop_id: LAPTOP_ID,
      status: state.currentStatus,
      state: process.env.STATE || 'CA',
      current_project: logger.getContext?.() || 'Idle',
      project: logger.getContext?.() || 'Idle',
      companies_today: state.companiesToday || 0,
    });
  }
}

export function isPaused() {
  return state.remoteConfig.paused === 'true';
}

export async function reportError(msg) {
  setStatus('error');
  await post('/api/heartbeat', {
    laptop_id: LAPTOP_ID,
    status: 'error',
    current_project: `ERROR: ${msg.slice(0, 50)}`,
  }, { timeoutMs: 2000, retries: 1 });
}

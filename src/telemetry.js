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
      }
    } catch (e) {
      // Quietly retry
    } finally {
      clearTimeout(timer);
    }
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
    await post('/api/heartbeat', {
      laptop_id: LAPTOP_ID,
      status: state.currentStatus,
      state: process.env.STATE || 'CA',
      current_project: logger.getContext?.() || 'Idle',
    });
    await uploadLogBatch();
    timer = setTimeout(tick, intervalMs);
  };

  tick();
  return () => clearTimeout(timer);
}

export async function reportStopping() {
  setStatus('stopped');
  await post('/api/heartbeat', {
    laptop_id: LAPTOP_ID,
    status: 'stopped',
    current_project: '(exiting)',
  }, { timeoutMs: 2000, retries: 1 });
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

export async function reportError(msg) {
  setStatus('error');
  await post('/api/heartbeat', {
    laptop_id: LAPTOP_ID,
    status: 'error',
    current_project: `ERROR: ${msg.slice(0, 50)}`,
  }, { timeoutMs: 2000, retries: 1 });
}

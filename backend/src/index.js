// PlanHub Telemetry Worker
// Receives heartbeats + events from 30 scraper laptops, serves data to the two panels.

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });

const now = () => Date.now();

// ---- Auth helpers ----
// Three "roles":
//   ingest — scrapers posting data      → INGEST_TOKEN
//   read   — either panel reading data  → OWNER_PASSWORD or ADMIN_PASSWORD
//   admin  — admin panel writing config → ADMIN_PASSWORD
function requireToken(request, env, kind) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return 'unauthorized';

  if (kind === 'ingest') {
    if (token && token === env.INGEST_TOKEN) return null;
  } else if (kind === 'read') {
    if (env.OWNER_PASSWORD && token === env.OWNER_PASSWORD) return null;
    if (env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD) return null;
  } else if (kind === 'admin') {
    if (env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD) return null;
  }
  return 'unauthorized';
}

// Simple role-check endpoint: panel sends its password, we tell it which role it has.
// Lets the login screen show/hide admin features without embedding passwords in code.
async function handleWhoAmI(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return json({ role: null }, 200);
  if (env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD) return json({ role: 'admin' });
  if (env.OWNER_PASSWORD && token === env.OWNER_PASSWORD) return json({ role: 'owner' });
  return json({ role: null }, 200);
}

// ---- Route handlers ----
async function handleHeartbeat(request, env) {
  const err = requireToken(request, env, 'ingest');
  if (err) return json({ error: err }, 401);

  const body = await request.json().catch(() => null);
  if (!body?.laptop_id) return json({ error: 'laptop_id required' }, 400);

  const ts = now();
  const {
    laptop_id,
    state = null,
    status = 'running',
    current_project = null,
    elapsed_ms = 0,
    companies_today = 0,
    version = null,
  } = body;

  // Upsert the laptops row
  await env.DB.prepare(
    `INSERT INTO laptops (id, state, first_seen, last_seen, status, current_project, companies_today, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state=excluded.state,
       last_seen=excluded.last_seen,
       status=excluded.status,
       current_project=excluded.current_project,
       companies_today=excluded.companies_today,
       version=excluded.version`
  )
    .bind(laptop_id, state, ts, ts, status, current_project, companies_today, version)
    .run();

  // Append to time-series
  await env.DB.prepare(
    `INSERT INTO heartbeats (laptop_id, ts, status, current_project, elapsed_ms, companies_today)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(laptop_id, ts, status, current_project, elapsed_ms, companies_today)
    .run();

  // Return any pending fleet-wide config so the scraper can react (e.g. pause)
  const { results: cfg } = await env.DB.prepare('SELECT key, value FROM config').all();
  const config = Object.fromEntries(cfg.map((r) => [r.key, r.value]));
  return json({ ok: true, config });
}

async function handleQuarantine(request, env) {
  const err = requireToken(request, env, 'ingest');
  if (err) return json({ error: err }, 401);

  const body = await request.json().catch(() => null);
  if (!body?.laptop_id) return json({ error: 'laptop_id required' }, 400);

  await env.DB.prepare(
    `INSERT INTO quarantine (laptop_id, project, error, stack, date_range, ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.laptop_id,
      body.project || null,
      body.error || null,
      body.stack || null,
      body.date_range || null,
      now()
    )
    .run();

  // Also update last_error on the laptop row
  await env.DB.prepare(
    `UPDATE laptops SET last_error=?, status='error' WHERE id=?`
  )
    .bind((body.error || '').slice(0, 500), body.laptop_id)
    .run();

  return json({ ok: true });
}

async function handleRunComplete(request, env) {
  const err = requireToken(request, env, 'ingest');
  if (err) return json({ error: err }, 401);

  const body = await request.json().catch(() => null);
  if (!body?.laptop_id) return json({ error: 'laptop_id required' }, 400);

  await env.DB.prepare(
    `INSERT INTO runs (laptop_id, started_at, finished_at, companies_scraped, new_companies, date_ranges, quarantined)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.laptop_id,
      body.started_at || now(),
      now(),
      body.companies_scraped || 0,
      body.new_companies || 0,
      body.date_ranges || 0,
      body.quarantined || 0
    )
    .run();

  return json({ ok: true });
}

async function handleCompaniesBatch(request, env) {
  const err = requireToken(request, env, 'ingest');
  if (err) return json({ error: err }, 401);

  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.companies)) return json({ error: 'companies[] required' }, 400);

  // D1 supports batch for performance
  const stmts = body.companies.map((c) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO companies (laptop_id, state, project, company, email, phone, website, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      c.laptop_id || body.laptop_id || null,
      c.state || body.state || null,
      c.project || null,
      c.company || null,
      c.email || null,
      c.phone || null,
      c.website || null,
      c.scraped_at || now()
    )
  );
  await env.DB.batch(stmts);

  return json({ ok: true, inserted: body.companies.length });
}

// ---- Read endpoints (panels) ----
async function handleLaptops(request, env) {
  const err = requireToken(request, env, 'read');
  if (err) return json({ error: err }, 401);
  const { results } = await env.DB.prepare(
    `SELECT * FROM laptops ORDER BY last_seen DESC`
  ).all();
  return json({ laptops: results });
}

async function handleQuarantineList(request, env) {
  const err = requireToken(request, env, 'read');
  if (err) return json({ error: err }, 401);
  const url = new URL(request.url);
  const unresolvedOnly = url.searchParams.get('unresolved') === '1';
  const q = unresolvedOnly
    ? `SELECT * FROM quarantine WHERE resolved=0 ORDER BY ts DESC LIMIT 200`
    : `SELECT * FROM quarantine ORDER BY ts DESC LIMIT 200`;
  const { results } = await env.DB.prepare(q).all();
  return json({ quarantine: results });
}

async function handleStats(request, env) {
  const err = requireToken(request, env, 'read');
  if (err) return json({ error: err }, 401);

  const day = now() - 24 * 60 * 60 * 1000;
  const week = now() - 7 * 24 * 60 * 60 * 1000;

  const [today, thisWeek, allTime, perState, online] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as n FROM companies WHERE scraped_at > ?`).bind(day).first(),
    env.DB.prepare(`SELECT COUNT(*) as n FROM companies WHERE scraped_at > ?`).bind(week).first(),
    env.DB.prepare(`SELECT COUNT(*) as n FROM companies`).first(),
    env.DB.prepare(
      `SELECT state, COUNT(*) as n FROM companies GROUP BY state ORDER BY n DESC`
    ).all(),
    env.DB.prepare(`SELECT COUNT(*) as n FROM laptops WHERE last_seen > ?`)
      .bind(now() - 5 * 60 * 1000)
      .first(),
  ]);

  return json({
    companies: { today: today.n, week: thisWeek.n, total: allTime.n },
    per_state: perState.results,
    laptops_online: online.n,
  });
}

async function handleConfigGet(request, env) {
  const err = requireToken(request, env, 'read');
  if (err) return json({ error: err }, 401);
  const { results } = await env.DB.prepare(`SELECT key, value, updated_at FROM config`).all();
  return json({ config: results });
}

async function handleConfigSet(request, env) {
  const err = requireToken(request, env, 'admin');
  if (err) return json({ error: err }, 401);
  const body = await request.json().catch(() => null);
  if (!body?.key) return json({ error: 'key required' }, 400);
  await env.DB.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  )
    .bind(body.key, String(body.value ?? ''), now())
    .run();
  return json({ ok: true });
}

async function handleReset(request, env) {
  const err = requireToken(request, env, 'admin');
  if (err) return json({ error: err }, 401);

  // Wipe all scraped data and run history
  await env.DB.batch([
    env.DB.prepare('DELETE FROM companies'),
    env.DB.prepare('DELETE FROM quarantine'),
    env.DB.prepare('DELETE FROM runs'),
    env.DB.prepare('DELETE FROM heartbeats'),
    env.DB.prepare('UPDATE laptops SET status=\'idle\', current_project=NULL, last_error=NULL, companies_today=0'),
    // Signal every laptop to wipe its local dedup cache on next heartbeat
    env.DB.prepare(`INSERT INTO config (key, value, updated_at) VALUES ('reset_requested','true',?)
      ON CONFLICT(key) DO UPDATE SET value='true', updated_at=excluded.updated_at`).bind(now()),
  ]);

  return json({ ok: true, message: 'Fleet reset. All laptops will clear local cache on next heartbeat.' });
}

async function handleQuarantineResolve(request, env) {
  const err = requireToken(request, env, 'admin');
  if (err) return json({ error: err }, 401);
  const body = await request.json().catch(() => null);
  if (!body?.id) return json({ error: 'id required' }, 400);
  await env.DB.prepare(`UPDATE quarantine SET resolved=1 WHERE id=?`).bind(body.id).run();
  return json({ ok: true });
}

// ---- Router ----
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    try {
      if (m === 'POST' && p === '/api/heartbeat') return handleHeartbeat(request, env);
      if (m === 'POST' && p === '/api/quarantine') return handleQuarantine(request, env);
      if (m === 'POST' && p === '/api/run-complete') return handleRunComplete(request, env);
      if (m === 'POST' && p === '/api/companies') return handleCompaniesBatch(request, env);

      if (m === 'GET' && p === '/api/laptops') return handleLaptops(request, env);
      if (m === 'GET' && p === '/api/quarantine') return handleQuarantineList(request, env);
      if (m === 'GET' && p === '/api/stats') return handleStats(request, env);
      if (m === 'GET' && p === '/api/config') return handleConfigGet(request, env);
      if (m === 'POST' && p === '/api/config') return handleConfigSet(request, env);
      if (m === 'POST' && p === '/api/quarantine/resolve') return handleQuarantineResolve(request, env);

      if (m === 'GET' && p === '/api/whoami') return handleWhoAmI(request, env);
      if (m === 'POST' && p === '/api/reset') return handleReset(request, env);

      if (p === '/' || p === '/health') return json({ ok: true, service: 'planhub-telemetry' });
      return json({ error: 'not found', path: p }, 404);
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  },

  // Scheduled job: prune old heartbeats (keep last 30 days). Cron set below.
  async scheduled(event, env) {
    const cutoff = now() - 30 * 24 * 60 * 60 * 1000;
    await env.DB.prepare(`DELETE FROM heartbeats WHERE ts < ?`).bind(cutoff).run();
  },
};

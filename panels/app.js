// PlanHub Control Panel — single-file React app via esm.sh CDN (no build step).
// Two panels in one: owner view (read-only) and admin view (can flip config,
// resolve quarantine). Role is decided by which password you log in with.

import React, { useState, useEffect, useCallback } from 'https://esm.sh/react@18';
import { createRoot } from 'https://esm.sh/react-dom@18/client';

const API = window.PLANHUB_API;

// ---------- API client ----------
const h = React.createElement;
const authHeaders = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

async function api(token, path, opts = {}) {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { ...authHeaders(token), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Helpers ----------
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString();
};

const statusPill = (status, lastSeen) => {
  const stale = lastSeen && Date.now() - lastSeen > 5 * 60 * 1000;
  if (stale) return h('span', { className: 'pill pill-idle' }, 'offline');
  if (status === 'running') return h('span', { className: 'pill pill-ok' }, 'running');
  if (status === 'error') return h('span', { className: 'pill pill-err' }, 'error');
  if (status === 'stopped') return h('span', { className: 'pill pill-idle' }, 'stopped');
  return h('span', { className: 'pill pill-idle' }, status || 'idle');
};

// ---------- Login ----------
function Login({ onLogin }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const { role } = await api(pw, '/api/whoami');
      if (!role) { setErr('Wrong password.'); setBusy(false); return; }
      localStorage.setItem('ph_token', pw);
      localStorage.setItem('ph_role', role);
      onLogin(pw, role);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return h('div', { className: 'login-wrap' },
    h('form', { className: 'login-card', onSubmit: submit },
      h('h1', null, 'PlanHub Panel'),
      h('p', null, 'Enter owner or admin password.'),
      err && h('div', { className: 'login-err' }, err),
      h('input', { type: 'password', value: pw, onChange: (e) => setPw(e.target.value), placeholder: 'Password', autoFocus: true }),
      h('button', { type: 'submit', disabled: busy || !pw }, busy ? 'Checking…' : 'Sign in'),
    ),
  );
}

// ---------- Owner view ----------
function OwnerDashboard({ token }) {
  const [stats, setStats] = useState(null);
  const [laptops, setLaptops] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api(token, '/api/stats'), api(token, '/api/laptops')]);
      setStats(s); setLaptops(l.laptops);
    } catch (e) { setErr(e.message); }
  }, [token]);

  useEffect(() => { load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, [load]);

  if (err) return h('div', { className: 'container' }, h('div', { className: 'card' }, `Error: ${err}`));
  if (!stats) return h('div', { className: 'container empty' }, 'Loading…');

  const online = stats.laptops_online || 0;

  return h('div', { className: 'container' },
    h('div', { className: 'grid grid-4' },
      h('div', { className: 'card' },
        h('h2', null, 'Companies today'),
        h('div', { className: 'stat' }, stats.companies.today.toLocaleString()),
        h('div', { className: 'stat-sub' }, 'last 24 h'),
      ),
      h('div', { className: 'card' },
        h('h2', null, 'This week'),
        h('div', { className: 'stat' }, stats.companies.week.toLocaleString()),
      ),
      h('div', { className: 'card' },
        h('h2', null, 'All time'),
        h('div', { className: 'stat' }, stats.companies.total.toLocaleString()),
      ),
      h('div', { className: 'card' },
        h('h2', null, 'Laptops online'),
        h('div', { className: 'stat' }, `${online} / ${laptops.length || '—'}`),
        h('div', { className: 'stat-sub' }, 'active in last 5 min'),
      ),
    ),
    h('div', { className: 'grid grid-2', style: { marginTop: 16 } },
      h('div', { className: 'card' },
        h('h2', null, 'Companies by state'),
        stats.per_state.length
          ? h('table', null,
              h('thead', null, h('tr', null, h('th', null, 'State'), h('th', null, 'Count'))),
              h('tbody', null,
                stats.per_state.map((r) => h('tr', { key: r.state || 'unknown' },
                  h('td', null, r.state || '—'),
                  h('td', null, r.n.toLocaleString()),
                )),
              ),
            )
          : h('div', { className: 'empty' }, 'No data yet'),
      ),
      h('div', { className: 'card' },
        h('h2', null, 'Laptop status'),
        laptops.length
          ? h('table', null,
              h('thead', null, h('tr', null, h('th', null, 'Laptop'), h('th', null, 'State'), h('th', null, 'Status'), h('th', null, 'Last seen'))),
              h('tbody', null,
                laptops.map((l) => h('tr', { key: l.id },
                  h('td', null, l.id),
                  h('td', null, l.state || '—'),
                  h('td', null, statusPill(l.status, l.last_seen)),
                  h('td', null, fmtTime(l.last_seen)),
                )),
              ),
            )
          : h('div', { className: 'empty' }, 'No laptops reporting yet'),
      ),
    ),
  );
}

// ---------- Admin view ----------
function AdminDashboard({ token }) {
  // All useState hooks must be at the top, before any other logic
  const [tab, setTab] = useState('laptops');
  const [laptops, setLaptops] = useState([]);
  const [quarantine, setQuarantine] = useState([]);
  const [config, setConfig] = useState([]);
  const [err, setErr] = useState('');
  const [resetStep, setResetStep] = useState(0); // 0=idle 1=confirm 2=resetting
  const [resetMsg, setResetMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [l, q, c] = await Promise.all([
        api(token, '/api/laptops'),
        api(token, '/api/quarantine?unresolved=1'),
        api(token, '/api/config'),
      ]);
      setLaptops(l.laptops); setQuarantine(q.quarantine); setConfig(c.config);
    } catch (e) { setErr(e.message); }
  }, [token]);

  useEffect(() => { load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, [load]);

  const paused = config.find((r) => r.key === 'paused')?.value === 'true';

  const togglePause = async () => {
    await api(token, '/api/config', { method: 'POST', body: JSON.stringify({ key: 'paused', value: !paused ? 'true' : 'false' }) });
    load();
  };

  const resolveItem = async (id) => {
    await api(token, '/api/quarantine/resolve', { method: 'POST', body: JSON.stringify({ id }) });
    load();
  };

  const doReset = async () => {
    setResetStep(2);
    setResetMsg('');
    try {
      const r = await api(token, '/api/reset', { method: 'POST' });
      setResetMsg(r.message || 'Reset sent.');
    } catch (e) {
      setResetMsg(`Error: ${e.message}`);
    }
    setTimeout(() => { setResetStep(0); setResetMsg(''); }, 5000);
    load();
  };

  if (err) return h('div', { className: 'container' }, h('div', { className: 'card' }, `Error: ${err}`));

  return h('div', { className: 'container' },
    h('div', { className: 'grid grid-4' },
      h('div', { className: 'card' },
        h('h2', null, 'Fleet'),
        h('div', { className: 'stat' }, laptops.length),
        h('div', { className: 'stat-sub' }, `${laptops.filter((l) => Date.now() - l.last_seen < 5 * 60 * 1000).length} online`),
      ),
      h('div', { className: 'card' },
        h('h2', null, 'Open failures'),
        h('div', { className: 'stat', style: { color: quarantine.length ? 'var(--err)' : 'var(--ok)' } }, quarantine.length),
      ),
      h('div', { className: 'card' },
        h('h2', null, 'Fleet paused'),
        h('label', { className: 'toggle' },
          h('input', { type: 'checkbox', checked: paused, onChange: togglePause }),
          h('span', { className: 'track' }, h('span', { className: 'thumb' })),
          h('span', { className: 'stat-sub' }, paused ? 'PAUSED' : 'running'),
        ),
        h('div', { className: 'stat-sub', style: { marginTop: 8 } }, 'Laptops react on next heartbeat (~60s)'),
      ),
      h('div', { className: 'card' },
        h('h2', null, 'Backend'),
        h('div', { className: 'stat', style: { fontSize: 16 } }, 'healthy'),
        h('div', { className: 'stat-sub' }, h('a', { href: API, target: '_blank' }, API.replace('https://', ''))),
      ),
    ),

    h('div', { className: 'tabs', style: { marginTop: 20 } },
      h('div', { className: `tab ${tab === 'laptops' ? 'active' : ''}`, onClick: () => setTab('laptops') }, 'Laptops'),
      h('div', { className: `tab ${tab === 'quarantine' ? 'active' : ''}`, onClick: () => setTab('quarantine') }, `Quarantine (${quarantine.length})`),
      h('div', { className: `tab ${tab === 'config' ? 'active' : ''}`, onClick: () => setTab('config') }, 'Config'),
    ),
    tab === 'laptops' && h('div', { className: 'card' },
      laptops.length ? h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, 'Laptop'), h('th', null, 'State'), h('th', null, 'Status'),
          h('th', null, 'Current project'), h('th', null, 'Companies today'),
          h('th', null, 'Last seen'), h('th', null, 'Last error'))),
        h('tbody', null,
          laptops.map((l) => h('tr', { key: l.id },
            h('td', null, l.id),
            h('td', null, l.state || '—'),
            h('td', null, statusPill(l.status, l.last_seen)),
            h('td', { className: 'muted', style: { maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, l.current_project || '—'),
            h('td', null, l.companies_today || 0),
            h('td', null, fmtTime(l.last_seen)),
            h('td', { className: 'muted', style: { maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: l.last_error || '' }, l.last_error || '—'),
          )),
        ),
      ) : h('div', { className: 'empty' }, 'No laptops reporting yet'),
    ),
    tab === 'quarantine' && h('div', null,
      quarantine.length ? quarantine.map((q) => h('div', { key: q.id, className: 'card', style: { marginBottom: 12 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
          h('div', null,
            h('strong', null, q.project || '(unknown project)'),
            h('span', { className: 'muted', style: { marginLeft: 10 } }, `${q.laptop_id} · ${fmtTime(q.ts)}`),
          ),
          h('button', { className: 'btn btn-sm btn-ghost', onClick: () => resolveItem(q.id) }, 'Mark resolved'),
        ),
        h('div', { style: { color: 'var(--err)', marginBottom: 8 } }, q.error),
        q.stack && h('pre', null, q.stack),
      )) : h('div', { className: 'card empty' }, '✓ No open failures'),
    ),
    tab === 'config' && h('div', null,
      h('div', { className: 'card' },
        h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Value'), h('th', null, 'Updated'))),
          h('tbody', null,
            config.map((r) => h('tr', { key: r.key },
              h('td', null, r.key),
              h('td', null, r.value),
              h('td', { className: 'muted' }, fmtTime(r.updated_at)),
            )),
          ),
        ),
        h('div', { className: 'muted', style: { marginTop: 12, fontSize: 12 } }, 'Config keys are read by every scraper on its next heartbeat (~60s).'),
      ),
      // ---- Reset panel (admin-only danger zone) ----
      h('div', { className: 'card', style: { marginTop: 16, borderColor: resetStep > 0 ? 'var(--err)' : 'var(--border)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('div', { style: { flex: 1 } },
            h('strong', null, '🔄 Reset Fleet'),
            h('div', { className: 'muted', style: { fontSize: 12, marginTop: 4 } },
              'Wipes all scraped data (companies, quarantine, runs) from the backend and signals every laptop to clear its local dedup cache. Laptops will start fresh on their next heartbeat (~30s).',
            ),
            resetMsg && h('div', { style: { color: 'var(--ok)', fontSize: 13, marginTop: 6 } }, resetMsg),
          ),
          resetStep === 0 && h('button', { className: 'btn btn-danger', onClick: () => setResetStep(1) }, 'Reset'),
          resetStep === 1 && h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', { style: { color: 'var(--warn)', fontSize: 13 } }, '⚠️ This cannot be undone. Sure?'),
            h('button', { className: 'btn btn-danger', onClick: doReset }, 'Yes, reset everything'),
            h('button', { className: 'btn btn-ghost', onClick: () => setResetStep(0) }, 'Cancel'),
          ),
          resetStep === 2 && h('span', { className: 'muted' }, 'Resetting…'),
        ),
      ),
    ),
  );
}

// ---------- Shell ----------
function Shell({ token, role, onLogout }) {
  return h('div', null,
    h('div', { className: 'topbar' },
      h('div', null,
        h('span', { className: 'brand' }, 'PlanHub Panel'),
        h('span', { className: 'role-tag' }, role),
      ),
      h('button', { className: 'logout', onClick: onLogout }, 'Sign out'),
    ),
    role === 'admin' ? h(AdminDashboard, { token }) : h(OwnerDashboard, { token }),
  );
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('ph_token') || '');
  const [role, setRole] = useState(localStorage.getItem('ph_role') || '');

  // Re-check token on load — if passwords changed on the backend, kick out.
  useEffect(() => {
    if (!token) return;
    api(token, '/api/whoami').then((r) => {
      if (!r.role) { logout(); } else { setRole(r.role); localStorage.setItem('ph_role', r.role); }
    }).catch(logout);
  }, []);

  const login = (t, r) => { setToken(t); setRole(r); };
  const logout = () => { localStorage.removeItem('ph_token'); localStorage.removeItem('ph_role'); setToken(''); setRole(''); };

  return token && role ? h(Shell, { token, role, onLogout: logout }) : h(Login, { onLogin: login });
}

createRoot(document.getElementById('app')).render(h(App));

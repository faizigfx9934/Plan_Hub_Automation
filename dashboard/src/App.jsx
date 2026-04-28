import React, { useState, useEffect, useCallback } from 'react';
import { 
  LayoutDashboard, 
  Laptop, 
  AlertCircle, 
  Settings, 
  LogOut, 
  Database, 
  Activity, 
  Clock,
  ShieldCheck,
  ShieldAlert,
  Search,
  RefreshCw,
  Pause,
  Play
} from 'lucide-react';

const API_BASE = 'https://planhub-telemetry.itscyper987.workers.dev';

function App() {
  const [token, setToken] = useState(localStorage.getItem('telemetry_token') || 'a2b5f70d02997a7847dc05bf01b96d0cbc4d957a8f10f616a8c743cba1c7fd26');
  const [role, setRole] = useState('admin');
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  
  const [stats, setStats] = useState({ companies: { today: 0, week: 0, total: 0 }, laptops_online: 0 });
  const [laptops, setLaptops] = useState([]);
  const [quarantine, setQuarantine] = useState([]);
  const [fleetConfig, setFleetConfig] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [localLaptopId, setLocalLaptopId] = useState('');

  // Fetch this laptop's ID from the local server
  useEffect(() => {
    fetch('/api/local-id')
      .then(r => r.json())
      .then(d => setLocalLaptopId(d.laptop_id || ''))
      .catch(() => setLocalLaptopId(''));
  }, []);

  const fetchWithAuth = useCallback(async (path, options = {}) => {
    if (!token) return null;
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
    });
    if (res.status === 401) {
      setToken('');
      localStorage.removeItem('telemetry_token');
      return null;
    }
    return res.json();
  }, [token]);

  const checkAuth = useCallback(async () => {
    if (!token) return;
    setIsAuthLoading(true);
    try {
      const data = await fetchWithAuth('/api/whoami');
      if (data && data.role) {
        setRole(data.role);
      } else {
        setRole(null);
      }
    } catch (e) {
      console.error('Auth check failed', e);
    } finally {
      setIsAuthLoading(false);
    }
  }, [token, fetchWithAuth]);

  const refreshData = useCallback(async () => {
    if (!token || !role) return;
    setIsLoading(true);
    try {
      const [statsData, laptopsData, configData, qData] = await Promise.all([
        fetchWithAuth('/api/stats'),
        fetchWithAuth('/api/laptops'),
        fetchWithAuth('/api/config'),
        fetchWithAuth('/api/quarantine?unresolved=1')
      ]);

      if (statsData) setStats(statsData);
      if (laptopsData) setLaptops(laptopsData.laptops || []);
      if (configData) {
        const cfgMap = {};
        configData.config.forEach(c => cfgMap[c.key] = c.value);
        setFleetConfig(cfgMap);
      }
      if (qData) setQuarantine(qData.quarantine || []);
      
      setLastUpdated(new Date());
    } catch (e) {
      console.error('Refresh failed', e);
    } finally {
      setIsLoading(false);
    }
  }, [token, role, fetchWithAuth]);

  useEffect(() => {
    checkAuth();
  }, [token, checkAuth]);

  useEffect(() => {
    if (role) {
      refreshData();
      const interval = setInterval(refreshData, 10000);
      return () => clearInterval(interval);
    }
  }, [role, refreshData]);

  const handleLogin = (e) => {
    e.preventDefault();
    const val = e.target.token.value;
    setToken(val);
    localStorage.setItem('telemetry_token', val);
  };

  const togglePause = async () => {
    if (role !== 'admin') return;
    const newValue = fleetConfig.paused === 'true' ? 'false' : 'true';
    await fetchWithAuth('/api/config', {
      method: 'POST',
      body: JSON.stringify({ key: 'paused', value: newValue })
    });
    refreshData();
  };

  if (!token || !role) {
    return (
      <div className="modal-overlay">
        <div className="modal-content glass">
          <div className="logo-icon" style={{ margin: '0 auto 24px' }}>
            <Activity size={20} />
          </div>
          <h2>PlanHub Control</h2>
          <p>Enter your access token to continue</p>
          <form onSubmit={handleLogin}>
            <div className="input-group">
              <label>Access Token</label>
              <input type="password" name="token" placeholder="••••••••••••" required autoFocus />
            </div>
            <button type="submit" className="btn-primary" disabled={isAuthLoading}>
              {isAuthLoading ? 'Authenticating...' : 'Access Dashboard'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-layout">
      <aside className="sidebar">
        <div className="logo-area">
          <div className="logo-icon">
            <Activity size={20} color="white" />
          </div>
          <span className="logo-text">PLANHUB PRO</span>
        </div>

        <nav className="nav-links">
          <div 
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard size={18} />
            Dashboard
          </div>
          <div 
            className={`nav-item ${activeTab === 'laptops' ? 'active' : ''}`}
            onClick={() => setActiveTab('laptops')}
          >
            <Laptop size={18} />
            Fleet Status
          </div>
          <div 
            className={`nav-item ${activeTab === 'quarantine' ? 'active' : ''}`}
            onClick={() => setActiveTab('quarantine')}
          >
            <AlertCircle size={18} />
            Quarantine
            {quarantine.length > 0 && (
              <span style={{ 
                marginLeft: 'auto', 
                background: 'var(--error)', 
                color: 'white', 
                fontSize: '10px', 
                padding: '2px 6px', 
                borderRadius: '10px' 
              }}>
                {quarantine.length}
              </span>
            )}
          </div>
        </nav>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className="nav-item" onClick={() => { localStorage.removeItem('telemetry_token'); setToken(''); setRole(null); }}>
            <LogOut size={18} />
            Logout
          </div>
        </div>
      </aside>

      <main className="main-viewport">
        <header className="top-header">
          <div className="page-title">
            <h1>{activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}</h1>
            <p>Last updated: {lastUpdated.toLocaleTimeString()}</p>
          </div>
          
          <div className="header-actions">
            {role === 'admin' && (
              <button 
                onClick={togglePause}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 20px',
                  borderRadius: '12px',
                  border: 'none',
                  background: fleetConfig.paused === 'true' ? 'var(--success)' : 'var(--warning)',
                  color: 'white',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                {fleetConfig.paused === 'true' ? <Play size={16} fill="white" /> : <Pause size={16} fill="white" />}
                {fleetConfig.paused === 'true' ? 'Resume Fleet' : 'Pause Fleet'}
              </button>
            )}
            
            <div className="auth-badge">
              {role === 'admin' ? <ShieldCheck size={14} color="#10b981" /> : <ShieldAlert size={14} color="#8b5cf6" />}
              {role.toUpperCase()} ACCESS
            </div>
            
            <div className={`stat-icon ${isLoading ? 'pulse' : ''}`} style={{ cursor: 'pointer', background: 'var(--bg-card)' }} onClick={refreshData}>
              <RefreshCw size={18} />
            </div>
          </div>
        </header>

        {activeTab === 'dashboard' && (() => {
          const myLaptop = laptops.find(l => l.id === localLaptopId);
          const isOnline = myLaptop && (Date.now() - myLaptop.last_seen) < 5 * 60 * 1000;
          return (
          <div className="fade-enter-active">
            {localLaptopId && <h3 style={{ marginBottom: '24px', fontSize: '20px', opacity: 0.6 }}>📍 {localLaptopId}</h3>}
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-header">
                  <div className="stat-icon"><Database size={20} /></div>
                  <span className={`status-dot ${isOnline ? 'status-online' : 'status-offline'}`}></span>
                </div>
                <div className="stat-value">{myLaptop ? myLaptop.companies_today : 0}</div>
                <div className="stat-label">My Companies Today</div>
              </div>
              
              <div className="stat-card">
                <div className="stat-header">
                  <div className="stat-icon"><Laptop size={20} /></div>
                </div>
                <div className="stat-value" style={{ fontSize: '18px', color: isOnline ? 'var(--success)' : 'var(--error)' }}>{myLaptop ? (isOnline ? myLaptop.status?.toUpperCase() : 'OFFLINE') : 'N/A'}</div>
                <div className="stat-label">My Status</div>
              </div>

              <div className="stat-card">
                <div className="stat-header">
                  <div className="stat-icon"><Activity size={20} /></div>
                </div>
                <div className="stat-value">{stats.laptops_online}</div>
                <div className="stat-label">Fleet Laptops Online</div>
              </div>
            </div>

            <h3 style={{ marginBottom: '24px', fontSize: '20px' }}>My Progress</h3>
            <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              <div className="stat-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <span className="stat-label">Current Project</span>
                <div style={{ minHeight: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', padding: '16px' }}>
                   <p style={{ color: 'var(--text-main)', fontSize: '15px', fontWeight: '600', textAlign: 'center' }}>{myLaptop?.current_project || 'Idle / Waiting'}</p>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-label">Scraping Region</span>
                <div style={{ fontSize: '24px', fontWeight: '700', marginTop: '12px', color: 'var(--primary)' }}>
                  {myLaptop?.state || 'N/A'}
                </div>
                <p style={{ fontSize: '13px', color: 'var(--text-dim)', marginTop: '8px' }}>Assigned state</p>
              </div>
            </div>

            <h3 style={{ marginBottom: '24px', fontSize: '20px', marginTop: '32px' }}>Fleet Summary</h3>
            <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <div className="stat-card">
                <div className="stat-value">{stats.companies.today}</div>
                <div className="stat-label">All Laptops Today</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.companies.week}</div>
                <div className="stat-label">All Laptops This Week</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.companies.total}</div>
                <div className="stat-label">All Time Total</div>
              </div>
            </div>
          </div>
          );
        })()}

        {activeTab === 'laptops' && (
          <div className="laptops-grid fade-enter-active">
            {laptops.map(laptop => {
              const isOnline = (Date.now() - laptop.last_seen) < 5 * 60 * 1000;
              return (
                <div key={laptop.id} className="laptop-card glass">
                  <div className="laptop-id">
                    <span className={`status-dot ${!isOnline ? 'status-offline' : laptop.status === 'error' ? 'status-error' : laptop.status === 'paused' ? 'status-paused' : 'status-online'}`}></span>
                    {laptop.id}
                  </div>
                  <div className="laptop-details">
                    <div className="detail-row">
                      <span className="detail-label">Status</span>
                      <span className="detail-value" style={{ color: !isOnline ? 'var(--text-dim)' : laptop.status === 'error' ? 'var(--error)' : 'var(--text-main)' }}>
                        {isOnline ? laptop.status.toUpperCase() : 'OFFLINE'}
                      </span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">State</span>
                      <span className="detail-value">{laptop.state || 'N/A'}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Companies Today</span>
                      <span className="detail-value">{laptop.companies_today}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label">Last Seen</span>
                      <span className="detail-value">{new Date(laptop.last_seen).toLocaleTimeString()}</span>
                    </div>
                    
                    {laptop.current_project && (
                      <div className="project-badge">
                        <span style={{ display: 'block', marginBottom: '4px', opacity: 0.5 }}>Current Project:</span>
                        {laptop.current_project}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === 'quarantine' && (
          <div className="fade-enter-active">
            {quarantine.length === 0 ? (
              <div className="stat-card" style={{ textAlign: 'center', padding: '80px' }}>
                <ShieldCheck size={48} color="var(--success)" style={{ marginBottom: '16px', opacity: 0.5 }} />
                <h3>No issues detected</h3>
                <p style={{ color: 'var(--text-dim)' }}>All projects are being processed successfully.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {quarantine.map(q => (
                  <div key={q.id} className="stat-card" style={{ borderLeft: '4px solid var(--error)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <span style={{ fontWeight: '700', color: 'var(--error)' }}>FAILED: {q.project}</span>
                      <span className="stat-label">{new Date(q.ts).toLocaleString()}</span>
                    </div>
                    <div className="project-badge" style={{ background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.1)' }}>
                      {q.error}
                    </div>
                    <div className="detail-row" style={{ marginTop: '12px' }}>
                      <span className="detail-label">Laptop ID: {q.laptop_id}</span>
                      <button 
                        style={{ border: 'none', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
                        onClick={async () => {
                          if (role !== 'admin') return;
                          await fetchWithAuth('/api/quarantine/resolve', { method: 'POST', body: JSON.stringify({ id: q.id }) });
                          refreshData();
                        }}
                      >
                        Mark as Resolved
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;

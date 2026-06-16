import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { AgentsPage } from './pages/Agents';
import { ArchivePage } from './pages/Archive';
import { JobsWatchPage } from './pages/JobsWatch';
import { ActionsPage } from './pages/Actions';
import { api } from './api';

type Page = 'login' | 'dashboard' | 'agents' | 'archive' | 'jobs' | 'actions';

const navItems: Array<{ page: Page; label: string; hint: string }> = [
  { page: 'dashboard', label: 'Overview', hint: 'health and activity' },
  { page: 'agents', label: 'MCP Agents', hint: 'clients, tokens, access' },
  { page: 'archive', label: 'Archive', hint: 'completed actions' },
  { page: 'jobs', label: 'Job Queue', hint: 'background runs' },
  { page: 'actions', label: 'Actions', hint: 'task cockpit' },
];

function getPage(): Page {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  if (hash === 'log') return 'archive';
  if (['login', 'dashboard', 'agents', 'archive', 'jobs', 'actions'].includes(hash)) return hash as Page;
  return 'dashboard';
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (p: Page) => {
    window.location.hash = p;
    setPage(p);
  };

  if (page === 'login') {
    return <LoginPage onLogin={() => navigate('dashboard')} />;
  }

  const handleSignOutEverywhere = async () => {
    if (!confirm('Sign out every active admin session, including other browsers and tabs? Each one will need to re-authenticate via a fresh magic link.')) {
      return;
    }
    try {
      await api.signOutEverywhere();
    } catch {
      // Even if the call fails, push to login — cookie is likely already invalid.
    }
    navigate('login');
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-logo">
          <span>VoltMind</span>
          <span className="sidebar-logo-subtitle">Admin</span>
        </div>
        <div className="sidebar-nav">
          {navItems.map(item => (
            <a
              key={item.page}
              className={`nav-item ${page === item.page ? 'active' : ''}`}
              onClick={() => navigate(item.page)}
            >
              <span className="nav-label">{item.label}</span>
              <span className="nav-hint">{item.hint}</span>
            </a>
          ))}
        </div>
        <div style={{ marginTop: 'auto', padding: '16px 12px', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={handleSignOutEverywhere}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              cursor: 'pointer',
              width: '100%',
            }}
            title="Revoke every active admin session — every browser, every tab"
          >
            Sign out everywhere
          </button>
        </div>
      </nav>
      <main className="main">
        {page === 'dashboard' && <DashboardPage />}
        {page === 'agents' && <AgentsPage />}
        {page === 'archive' && <ArchivePage />}
        {page === 'jobs' && <JobsWatchPage />}
        {page === 'actions' && <ActionsPage />}
      </main>
    </div>
  );
}

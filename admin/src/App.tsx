import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { AgentsPage } from './pages/Agents';
import { ArchivePage } from './pages/Archive';
import { JobsWatchPage } from './pages/JobsWatch';
import { ActionsPage } from './pages/Actions';
import { api } from './api';
import voltageLogoV from './assets/voltage-logo-v.png';

type Page = 'login' | 'dashboard' | 'agents' | 'archive' | 'jobs' | 'actions';

const navItems: Array<{ page: Page; label: string; icon: string }> = [
  { page: 'dashboard', label: 'Dashboard', icon: '⌂' },
  { page: 'agents', label: 'Agents', icon: '♙' },
  { page: 'archive', label: 'Archive', icon: '▰' },
  { page: 'jobs', label: 'Jobs Watch', icon: '◴' },
  { page: 'actions', label: 'Actions', icon: 'ϟ' },
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
          <img className="brand-mark" src={voltageLogoV} alt="Voltage" />
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
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </a>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="local-state"><span>Local First</span><i /> <em>v0.9.3</em></div>
          <div className="profile-strip">
            <span className="avatar">JL</span>
            <div><strong>Justike Liu</strong><small>Local Profile</small></div>
            <span>⌄</span>
          </div>
          <button
            onClick={handleSignOutEverywhere}
            className="signout-button"
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

import React, { useCallback, useEffect, useState } from 'react';
import { api, clearSessionMemory, setUnauthorizedHandler, type SessionState } from './api';
import { LoginPage } from './pages/Login';
import { AdminConsole } from './pages/AdminConsole';
import voltageLogoV from './assets/voltage-logo-v.png';

type AuthState = 'checking' | 'authenticated' | 'anonymous';

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [session, setSession] = useState<SessionState | null>(null);

  const showLogin = useCallback(() => {
    clearSessionMemory();
    setSession(null);
    setAuth('anonymous');
  }, []);

  const hydrateSession = useCallback(async () => {
    try {
      const response = await api.session();
      setSession(response.data);
      setAuth('authenticated');
    } catch {
      showLogin();
    }
  }, [showLogin]);

  useEffect(() => {
    setUnauthorizedHandler(showLogin);
    void hydrateSession();
    return () => setUnauthorizedHandler(null);
  }, [hydrateSession, showLogin]);

  if (auth === 'checking') {
    return (
      <div className="vm-admin-v1 boot-screen">
        <img src={voltageLogoV} alt="" />
        <span>Connecting to VoltMind Host…</span>
      </div>
    );
  }

  if (auth === 'anonymous') {
    return <LoginPage onLogin={hydrateSession} />;
  }

  return <AdminConsole session={session!} onSessionRefresh={hydrateSession} />;
}

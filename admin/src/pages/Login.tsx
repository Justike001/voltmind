import React, { useRef, useState } from 'react';
import { AdminApiError, api } from '../api';
import voltageLogoV from '../assets/voltage-logo-v.png';

export function LoginPage({ onLogin }: { onLogin: () => Promise<void> | void }) {
  const tokenRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = tokenRef.current?.value ?? '';
    if (!token) return;
    setError('');
    setLoading(true);
    try {
      await api.login(token);
      if (tokenRef.current) tokenRef.current.value = '';
      await onLogin();
    } catch (cause) {
      if (tokenRef.current) tokenRef.current.value = '';
      const error = cause as AdminApiError;
      setError(error.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="vm-admin-v1 login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <img src={voltageLogoV} alt="" />
          <div><strong>VoltMind</strong><span>Host Administration</span></div>
        </div>
        <div className="login-copy">
          <p className="eyebrow">Secure control plane</p>
          <h1 id="login-title">Sign in to Admin</h1>
          <p>The bootstrap token is used only for this request. It is never saved in browser storage or placed in a URL.</p>
        </div>
        <form onSubmit={handleSubmit} autoComplete="off">
          <label htmlFor="admin-token">Admin bootstrap token</label>
          <input ref={tokenRef} id="admin-token" type="password" name="admin-bootstrap-token" autoComplete="off" spellCheck={false} required autoFocus placeholder="Paste token" />
          <button className="primary-button" disabled={loading}>{loading ? 'Authenticating…' : 'Continue'}</button>
          {error && <div className="error-banner" role="alert">{error}</div>}
        </form>
        <p className="security-note">Session credentials remain in an HttpOnly, SameSite=Strict cookie.</p>
      </section>
    </main>
  );
}

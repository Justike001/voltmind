const BASE = '';

// v0.26.3 trust model (D11 + D12): the admin UI does NOT cache the
// bootstrap token in browser JS state. On 401, redirect to login —
// no auto-reauth via saved token, no localStorage/sessionStorage read.
// The HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (res.status === 401) {
    // No token cache to retry from. Redirect to login.
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// v0.36.1.0 (T15 / E6) — SVG fetch (text/plain payload, NOT JSON).
async function apiFetchText(path: string) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const api = {
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
  stats: () => apiFetch('/admin/api/stats'),
  health: () => apiFetch('/admin/api/health-indicators'),
  agents: () => apiFetch('/admin/api/agents'),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  apiKeys: () => apiFetch('/admin/api/api-keys'),
  createApiKey: (name: string) => apiFetch('/admin/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (name: string) => apiFetch('/admin/api/api-keys/revoke', { method: 'POST', body: JSON.stringify({ name }) }),
  updateClientTtl: (clientId: string, tokenTtl: number | null) => apiFetch('/admin/api/update-client-ttl', { method: 'POST', body: JSON.stringify({ clientId, tokenTtl }) }),
  revokeClient: (clientId: string) => apiFetch('/admin/api/revoke-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
  // v0.36.1.0 (T15 / E6) — calibration endpoints.
  calibrationProfile: (holder?: string) =>
    apiFetch(`/admin/api/calibration/profile${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  // v0.41 D2 — live minion-jobs dashboard snapshot.
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
  actionsScan: () => apiFetch('/admin/api/actions/scan', { method: 'POST', body: JSON.stringify({}) }),
  actions: (qs = '') => apiFetch(`/admin/api/actions${qs}`),
  actionRuns: (slug: string, sourceId = 'default') =>
    apiFetch(`/admin/api/actions/${encodeURIComponent(slug)}/runs?source_id=${encodeURIComponent(sourceId)}`),
  approveAction: (slug: string, sourceId = 'default') =>
    apiFetch(`/admin/api/actions/${encodeURIComponent(slug)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, approved_by: 'admin-ui' }),
    }),
  runAction: (slug: string, sourceId = 'default', userPrompt = '') =>
    apiFetch(`/admin/api/actions/${encodeURIComponent(slug)}/run`, {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, now: true, user_prompt: userPrompt }),
    }),
  saveActionPlan: (slug: string, sourceId = 'default', plan: any) =>
    apiFetch(`/admin/api/actions/${encodeURIComponent(slug)}/plan/save`, {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, plan }),
    }),
  getActionPlan: (slug: string, sourceId = 'default') =>
    apiFetch(`/admin/api/actions/${encodeURIComponent(slug)}/plan?source_id=${encodeURIComponent(sourceId)}`),
  generateActionPlan: (slug: string, sourceId = 'default', userPrompt = '') =>
    apiFetch(`/admin/api/actions/${encodeURIComponent(slug)}/plan`, {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, user_prompt: userPrompt }),
    }),
  updateAction: (slug: string, sourceId = 'default', dueAt?: string, userPrompt?: string) =>
    apiFetch(`/admin/api/actions/${encodeURIComponent(slug)}/update`, {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, due_at: dueAt, user_prompt: userPrompt }),
    }),
  setActionStatus: (slug: string, sourceId: string, status: string) =>
    apiFetch(`/admin/api/actions/${encodeURIComponent(slug)}/status`, {
      method: 'POST',
      body: JSON.stringify({ source_id: sourceId, status }),
    }),
};

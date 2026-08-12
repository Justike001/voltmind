export type ApiResponse<T> = {
  data: T;
  meta: { request_id: string; next_cursor?: string | null };
};

export type ApiErrorBody = {
  error?: { code?: string; message?: string; details?: unknown };
  request_id?: string;
};

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export interface SessionState {
  authenticated: boolean;
  csrf_token: string;
  expires_at: string;
}

export interface SourceSummary {
  id: string;
  name: string;
  archived: boolean;
  archived_at: string | null;
  archive_expires_at: string | null;
  last_sync_at: string | null;
  last_commit: string | null;
  federated: boolean;
  owner_email: string | null;
  page_count: number;
  oauth_client_count: number;
}

export interface OAuthClient {
  client_id: string;
  client_name: string;
  contact_email: string | null;
  source_id: string;
  federated_read: string[];
  grant_types: string[];
  scope: string;
  token_endpoint_auth_method: string;
  created_at: string;
  deleted_at: string | null;
}

export interface SourceDetail {
  id?: string;
  source_id?: string;
  name?: string;
  archived?: boolean;
  federated?: boolean;
  page_count?: number;
  clone_state?: string;
  last_sync_at?: string | null;
  last_commit?: string | null;
  remote_url?: string | null;
  oauth_clients: OAuthClient[];
  [key: string]: unknown;
}

export interface GogsStatus {
  source_id: string;
  configured: boolean;
  repository_host: string | null;
  repository_owner: string | null;
  repository_name: string | null;
  api_state: 'unconfigured' | 'healthy' | 'unreachable' | 'denied';
  clone_state: string;
  last_sync_at: string | null;
  last_commit: string | null;
}

export interface AdminJob {
  id: number;
  source_id: string | null;
  name: string;
  queue: string;
  status: string;
  priority: number;
  attempts_made: number;
  max_attempts: number;
  progress: unknown;
  result: Record<string, unknown> | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface AutopilotStatus {
  configured: boolean;
  state: 'starting' | 'running' | 'degraded' | 'stopping' | 'failed' | 'stopped_or_unknown';
  engine?: 'postgres' | 'pglite';
  started_at?: string;
  updated_at?: string;
  heartbeat_at?: string;
  heartbeat_stale?: boolean;
  database?: { state: string; last_connected_at?: string };
  supervisor?: { state: string; worker_expected: boolean; restart_count: number };
}

export interface Overview {
  sources: { total: number; archived: number };
  oauth_clients: { active: number; revoked: number };
  jobs: { open: number; failed: number };
}

export interface AuditEntry {
  id: number;
  request_id: string;
  source_id: string | null;
  client_id: string | null;
  job_id: number | null;
  action: string;
  status: 'ok' | 'error';
  params_summary: { body_keys?: string[]; duration_ms?: number };
  error_code: string | null;
  created_at: string;
}

export interface SecretResult {
  client_id: string;
  client_secret?: string;
  source_id?: string;
  client_name?: string;
  contact_email?: string;
  scope?: string;
  replaced_client_id?: string;
  secret_shown_once: boolean;
}

export type OAuthClientStatus = 'active' | 'revoked' | 'all';

export interface OAuthScopeUpdateResult {
  client_id: string;
  scope: string;
  tokens_revoked: number;
  codes_revoked: number;
  updated: true;
}

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export function clearSessionMemory() {
  csrfToken = null;
}

async function parseError(response: Response): Promise<AdminApiError> {
  const body = await response.json().catch(() => ({})) as ApiErrorBody;
  return new AdminApiError(
    response.status,
    body.error?.code ?? `http_${response.status}`,
    body.error?.message ?? response.statusText ?? `HTTP ${response.status}`,
    body.request_id ?? response.headers.get('X-Request-ID') ?? undefined,
    body.error?.details,
  );
}

async function requestSession(): Promise<ApiResponse<SessionState>> {
  const response = await fetch('/admin/api/v1/session', { credentials: 'same-origin' });
  if (!response.ok) throw await parseError(response);
  const body = await response.json() as ApiResponse<SessionState>;
  csrfToken = body.data.csrf_token;
  return body;
}

export async function adminFetch<T>(
  path: string,
  init: RequestInit = {},
  csrfRetry = true,
): Promise<ApiResponse<T>> {
  const method = (init.method ?? 'GET').toUpperCase();
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (mutation && csrfToken) headers.set('X-VoltMind-CSRF', csrfToken);

  const response = await fetch(path, { ...init, method, credentials: 'same-origin', headers });
  if (response.ok) return response.json() as Promise<ApiResponse<T>>;

  const error = await parseError(response);
  if (error.status === 401) {
    clearSessionMemory();
    unauthorizedHandler?.();
  } else if (error.status === 403 && error.code === 'csrf_failed' && mutation && csrfRetry) {
    try {
      await requestSession();
      return adminFetch<T>(path, init, false);
    } catch (sessionError) {
      clearSessionMemory();
      unauthorizedHandler?.();
      throw sessionError;
    }
  }
  throw error;
}

const enc = encodeURIComponent;

export const api = {
  async login(token: string) {
    const response = await fetch('/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw await parseError(response);
    return response.json() as Promise<{ status: string }>;
  },
  session: requestSession,
  overview: () => adminFetch<Overview>('/admin/api/v1/overview'),
  autopilot: () => adminFetch<AutopilotStatus>('/admin/api/v1/autopilot'),
  sources: (includeArchived = false) => adminFetch<SourceSummary[]>(`/admin/api/v1/sources${includeArchived ? '?include_archived=true' : ''}`),
  source: (id: string) => adminFetch<SourceDetail>(`/admin/api/v1/sources/${enc(id)}`),
  createSource: (input: { source_id: string; name: string; remote_url?: string; owner_email?: string; federated: boolean; allow_ssh: boolean }) =>
    adminFetch<{ source_id: string; name: string }>('/admin/api/v1/sources', { method: 'POST', body: JSON.stringify(input) }),
  archiveSource: (id: string) => adminFetch<{ source_id: string; archive_expires_at: string; revoked_client_count: number }>(`/admin/api/v1/sources/${enc(id)}/archive`, { method: 'POST', body: '{}' }),
  restoreSource: (id: string, federated: boolean) => adminFetch<{ source_id: string; restored: boolean; oauth_clients_restored: false }>(`/admin/api/v1/sources/${enc(id)}/restore`, { method: 'POST', body: JSON.stringify({ federated }) }),
  gogs: (id: string) => adminFetch<GogsStatus>(`/admin/api/v1/sources/${enc(id)}/gogs`),
  oauthClients: (options: { sourceId?: string; status?: OAuthClientStatus } = {}) => {
    const query = new URLSearchParams();
    if (options.sourceId) query.set('source_id', options.sourceId);
    if (options.status) query.set('status', options.status);
    const suffix = query.size ? `?${query.toString()}` : '';
    return adminFetch<OAuthClient[]>(`/admin/api/v1/oauth-clients${suffix}`);
  },
  createOAuthClient: (input: { source_id: string; name: string; contact_email: string; scopes: string[] }) =>
    adminFetch<SecretResult>('/admin/api/v1/oauth-clients', { method: 'POST', body: JSON.stringify(input) }),
  updateOAuthClientScopes: (clientId: string, scopes: string[]) =>
    adminFetch<OAuthScopeUpdateResult>(`/admin/api/v1/oauth-clients/${enc(clientId)}`, { method: 'PATCH', body: JSON.stringify({ scopes }) }),
  rotateOAuthClient: (clientId: string) => adminFetch<SecretResult>(`/admin/api/v1/oauth-clients/${enc(clientId)}/rotate`, { method: 'POST', body: '{}' }),
  revokeOAuthClient: (clientId: string) => adminFetch<{ client_id: string; revoked: boolean }>(`/admin/api/v1/oauth-clients/${enc(clientId)}/revoke`, { method: 'POST', body: '{}' }),
  sourceJobs: (sourceId: string, options: { status?: string; limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.status) query.set('status', options.status);
    if (options.limit) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', options.cursor);
    const suffix = query.size ? `?${query.toString()}` : '';
    return adminFetch<AdminJob[]>(`/admin/api/v1/sources/${enc(sourceId)}/jobs${suffix}`);
  },
  job: (id: number) => adminFetch<AdminJob>(`/admin/api/v1/jobs/${enc(String(id))}`),
  cancelJob: (id: number) => adminFetch<AdminJob>(`/admin/api/v1/jobs/${enc(String(id))}/cancel`, { method: 'POST', body: '{}' }),
  retryJob: (id: number) => adminFetch<AdminJob>(`/admin/api/v1/jobs/${enc(String(id))}/retry`, { method: 'POST', body: '{}' }),
  cycleProfiles: () => adminFetch<Array<{ id: string; phases: string[] }>>('/admin/api/v1/cycle-profiles'),
  cycles: (sourceId: string, cursor?: string) => adminFetch<AdminJob[]>(`/admin/api/v1/sources/${enc(sourceId)}/cycles${cursor ? `?cursor=${enc(cursor)}` : ''}`),
  submitCycle: (sourceId: string, input: { profile: string; phases?: string[]; dry_run: boolean }) => adminFetch<{ job_id: number; source_id: string; profile: string; phases: string[]; dry_run: boolean }>(`/admin/api/v1/sources/${enc(sourceId)}/cycles`, { method: 'POST', body: JSON.stringify(input) }),
  audit: (limit = 50) => adminFetch<AuditEntry[]>(`/admin/api/v1/audit?limit=${limit}`),
};

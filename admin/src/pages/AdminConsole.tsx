import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AdminApiError,
  api,
  type AdminJob,
  type AuditEntry,
  type AutopilotStatus,
  type GogsStatus,
  type OAuthClient,
  type OAuthClientStatus,
  type Overview,
  type SecretResult,
  type SessionState,
  type SourceDetail,
  type SourceSummary,
} from '../api';
import voltageLogoV from '../assets/voltage-logo-v.png';
import { DIALOG_FOCUSABLE_SELECTOR, isRowActivationKey, trappedFocusTarget } from '../accessibility';

type View = 'overview' | 'sources' | 'oauth' | 'jobs' | 'autopilot' | 'audit';
const views: Array<{ id: View; label: string; hint: string }> = [
  { id: 'overview', label: 'Overview', hint: 'Host health' },
  { id: 'sources', label: 'Sources', hint: 'Core workspace' },
  { id: 'oauth', label: 'OAuth Clients', hint: 'Source bindings' },
  { id: 'jobs', label: 'Jobs & Cycles', hint: 'Work queue' },
  { id: 'autopilot', label: 'Autopilot', hint: 'Read-only runtime' },
  { id: 'audit', label: 'Audit Log', hint: 'Admin activity' },
];

const terminalStatuses = new Set(['completed', 'failed', 'dead', 'cancelled']);
const cancellableStatuses = new Set(['waiting', 'active', 'delayed', 'waiting-children', 'paused']);
const retryableStatuses = new Set(['failed', 'dead']);

function formatTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function shortId(value?: string | null, size = 18) {
  if (!value) return '—';
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

function sourceOptionLabel(source: Pick<SourceSummary, 'id' | 'name'>) {
  return source.name === source.id ? source.id : `${source.name} · ${source.id}`;
}

function errorText(error: unknown) {
  const apiError = error as AdminApiError;
  if (apiError.code === 'origin_failed') return 'Deployment error: this origin does not match VOLTMIND_ADMIN_PUBLIC_URL. The request was not retried.';
  return `${apiError.message || 'Request failed'}${apiError.requestId ? ` · Request ${apiError.requestId}` : ''}`;
}

function StatusBadge({ value }: { value: string }) {
  const tone = ['healthy', 'running', 'active', 'completed', 'ok'].includes(value) ? 'good'
    : ['failed', 'dead', 'denied', 'error'].includes(value) ? 'bad'
      : ['degraded', 'unreachable', 'delayed', 'waiting', 'starting'].includes(value) ? 'warn' : 'muted';
  return <span className={`status-badge ${tone}`}>{value.split('_').join(' ')}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function Loading() { return <div className="loading-state">Loading…</div>; }

function activateRow(event: React.KeyboardEvent<HTMLTableRowElement>, action: () => void) {
  if (!isRowActivationKey(event.key)) return;
  event.preventDefault();
  action();
}

function ErrorBanner({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div className="error-banner" role="alert"><span>{error}</span>{onRetry && <button onClick={onRetry}>Retry</button>}</div>;
}

export function AdminConsole({ session, onSessionRefresh }: { session: SessionState; onSessionRefresh: () => Promise<void> | void }) {
  const [view, setView] = useState<View>('overview');
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);

  const navigate = (next: View) => { setView(next); setMobileNav(false); };

  return (
    <div className="vm-admin-v1 admin-shell">
      <aside className={`admin-sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="admin-brand"><img src={voltageLogoV} alt="" /><div><strong>VoltMind</strong><span>Host Admin</span></div></div>
        <nav aria-label="Admin navigation">
          {views.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><strong>{item.label}</strong><span>{item.hint}</span></button>)}
        </nav>
        <div className="sidebar-session"><span className="live-dot" />Authenticated<small>Expires {formatTime(session.expires_at)}</small></div>
      </aside>
      <div className="admin-main">
        <header className="mobile-header"><button onClick={() => setMobileNav(v => !v)} aria-label="Toggle navigation">☰</button><strong>VoltMind Admin</strong></header>
        {view === 'overview' && <OverviewPage onNavigate={navigate} />}
        {view === 'sources' && <SourcesPage selected={selectedSource} onSelect={setSelectedSource} />}
        {view === 'oauth' && <OAuthPage initialSource={selectedSource} />}
        {view === 'jobs' && <JobsPage initialSource={selectedSource} />}
        {view === 'autopilot' && <AutopilotPage />}
        {view === 'audit' && <AuditPage />}
        <footer className="admin-footer"><span>Same-origin control plane</span><button onClick={() => void onSessionRefresh()}>Refresh session</button></footer>
      </div>
    </div>
  );
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function OverviewPage({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [autopilot, setAutopilot] = useState<AutopilotStatus | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const [o, a] = await Promise.all([api.overview(), api.autopilot()]);
      setOverview(o.data); setAutopilot(a.data);
    } catch (cause) { setError(errorText(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!overview && !error) return <Loading />;
  return <section className="page"><PageHeader eyebrow="Host overview" title="Control plane at a glance" description="Sources, credentials, queues, and runtime health from the Ubuntu Host." action={<button className="secondary-button" onClick={load}>Refresh</button>} />
    {error && <ErrorBanner error={error} onRetry={load} />}
    {overview && <div className="metric-grid">
      <Metric label="Active sources" value={overview.sources.total - overview.sources.archived} onClick={() => onNavigate('sources')} />
      <Metric label="Archived sources" value={overview.sources.archived} onClick={() => onNavigate('sources')} tone={overview.sources.archived ? 'warn' : undefined} />
      <Metric label="Active clients" value={overview.oauth_clients.active} onClick={() => onNavigate('oauth')} />
      <Metric label="Revoked clients" value={overview.oauth_clients.revoked} onClick={() => onNavigate('oauth')} />
      <Metric label="Open jobs" value={overview.jobs.open} onClick={() => onNavigate('jobs')} tone={overview.jobs.open ? 'accent' : undefined} />
      <Metric label="Failed jobs" value={overview.jobs.failed} onClick={() => onNavigate('jobs')} tone={overview.jobs.failed ? 'bad' : undefined} />
    </div>}
    <div className="overview-panels overview-single">
      <article className="panel"><div className="panel-title"><h2>Runtime</h2>{autopilot && <StatusBadge value={autopilot.state} />}</div>{autopilot ? <dl className="fact-list"><div><dt>Engine</dt><dd>{autopilot.engine ?? '—'}</dd></div><div><dt>Heartbeat</dt><dd>{formatTime(autopilot.heartbeat_at)}</dd></div><div><dt>Database</dt><dd>{autopilot.database?.state ?? '—'}</dd></div></dl> : <Empty>Runtime status unavailable.</Empty>}</article>
    </div>
  </section>;
}

function Metric({ label, value, tone, onClick }: { label: string; value: number; tone?: string; onClick: () => void }) {
  return <button className={`metric-card ${tone ?? ''}`} onClick={onClick}><span>{label}</span><strong>{value}</strong><small>Open details →</small></button>;
}

function SourcesPage({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [includeArchived, setIncludeArchived] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { setSources((await api.sources(includeArchived)).data); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, [includeArchived]);
  useEffect(() => { void load(); }, [load]);
  if (selected) return <SourceWorkspace sourceId={selected} onBack={() => onSelect(null)} onChanged={load} />;
  return <section className="page"><PageHeader eyebrow="SourceID management" title="Sources" description="Every repository, credential, job, and cycle is anchored to a SourceID." action={<button className="primary-button" onClick={() => setCreating(true)}>New source</button>} />
    <div className="toolbar"><label className="check"><input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)} /> Include archived</label><button className="secondary-button" onClick={load}>Refresh</button></div>
    {error && <ErrorBanner error={error} onRetry={load} />}{loading ? <Loading /> : sources.length === 0 ? <Empty>No sources found.</Empty> : <div className="table-card"><table><thead><tr><th>Source</th><th>Status</th><th>Pages</th><th>Clients</th><th>Federated</th><th>Last sync</th></tr></thead><tbody>{sources.map(source => <tr key={source.id} onClick={() => onSelect(source.id)} onKeyDown={event => activateRow(event, () => onSelect(source.id))} className="clickable" role="button" tabIndex={0} aria-label={`Open source ${source.name}`}><td><strong>{source.name}</strong><code>{source.id}</code></td><td><StatusBadge value={source.archived ? 'archived' : 'active'} /></td><td>{source.page_count}</td><td>{source.oauth_client_count}</td><td>{source.federated ? 'Enabled' : 'Off'}</td><td>{formatTime(source.last_sync_at)}</td></tr>)}</tbody></table></div>}
    {creating && <CreateSourceModal onClose={() => setCreating(false)} onCreated={async id => { setCreating(false); await load(); onSelect(id); }} />}
  </section>;
}

function CreateSourceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(''); try { const id = String(data.get('source_id')); await api.createSource({ source_id: id, name: String(data.get('name')), remote_url: String(data.get('remote_url')) || undefined, owner_email: String(data.get('owner_email')) || undefined, federated: data.get('federated') === 'on', allow_ssh: data.get('allow_ssh') === 'on' }); onCreated(id); } catch (cause) { setError(errorText(cause)); setBusy(false); } };
  return <Modal title="Provision source" onClose={busy ? undefined : onClose}><form className="form-grid" onSubmit={submit}><label>SourceID<input name="source_id" required pattern="[a-z0-9][a-z0-9._-]*" placeholder="alice-example" /></label><label>Display name<input name="name" required placeholder="Alice Example" /></label><label className="full">Gogs remote URL<input name="remote_url" type="url" placeholder="ssh://git@gogs.internal.example/alice-example/brain.git" /></label><label className="full">Owner email<input name="owner_email" type="email" placeholder="alice-example@company.example" /></label><label className="check"><input name="federated" type="checkbox" /> Federated read</label><label className="check"><input name="allow_ssh" type="checkbox" defaultChecked /> Allow SSH clone</label>{error && <div className="error-banner full">{error}</div>}<div className="modal-actions full"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Cloning repository…' : 'Create source'}</button></div></form></Modal>;
}

function SourceWorkspace({ sourceId, onBack, onChanged }: { sourceId: string; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<SourceDetail | null>(null); const [gogs, setGogs] = useState<GogsStatus | null>(null); const [gogsError, setGogsError] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [creatingClient, setCreatingClient] = useState(false); const [secret, setSecret] = useState<SecretResult | null>(null);
  const load = useCallback(async () => { setError(''); try { setDetail((await api.source(sourceId)).data); } catch (cause) { setError(errorText(cause)); } setGogsError(''); try { setGogs((await api.gogs(sourceId)).data); } catch (cause) { setGogsError(errorText(cause)); } }, [sourceId]);
  useEffect(() => { void load(); }, [load]);
  const archived = detail?.archived === true;
  const mutateArchive = async () => { if (!archived && !confirm('Archive will immediately disconnect bound clients. Restoring the source will not restore old credentials. Continue?')) return; let federated = false; if (archived) federated = confirm('Restore with federated read enabled? Choose Cancel to restore with federation disabled.'); setBusy(true); try { archived ? await api.restoreSource(sourceId, federated) : await api.archiveSource(sourceId); await load(); onChanged(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <section className="page"><button className="back-button" onClick={onBack}>← All sources</button><PageHeader eyebrow={`SourceID · ${sourceId}`} title={detail?.name ?? sourceId} description="Repository health, OAuth bindings, and lifecycle controls in one workspace." action={<div className="button-row">{!archived && <button className="primary-button" onClick={() => setCreatingClient(true)} disabled={busy}>New client</button>}<button className={archived ? 'secondary-button' : 'danger-button'} onClick={mutateArchive} disabled={busy || sourceId === 'default'}>{archived ? 'Restore source' : 'Archive source'}</button></div>} />
    {error && <ErrorBanner error={error} onRetry={load} />}{!detail ? <Loading /> : <><div className="summary-strip"><div><span>Status</span><StatusBadge value={archived ? 'archived' : 'active'} /></div><div><span>Federation</span><strong>{detail.federated ? 'Enabled' : 'Off'}</strong></div><div><span>Clone</span><strong>{String(detail.clone_state ?? '—')}</strong></div><div><span>Last sync</span><strong>{formatTime(detail.last_sync_at as string | null)}</strong></div></div>
      <div className="overview-panels"><article className="panel"><div className="panel-title"><h2>Gogs repository</h2>{gogs && <StatusBadge value={gogs.api_state} />}</div>{gogsError ? <ErrorBanner error={gogsError} onRetry={load} /> : gogs ? <dl className="fact-list"><div><dt>Host</dt><dd>{gogs.repository_host ?? '—'}</dd></div><div><dt>Repository</dt><dd>{gogs.repository_owner && gogs.repository_name ? `${gogs.repository_owner}/${gogs.repository_name}` : '—'}</dd></div><div><dt>Clone state</dt><dd>{gogs.clone_state}</dd></div><div><dt>Last commit</dt><dd><code>{shortId(gogs.last_commit)}</code></dd></div></dl> : <Loading />}</article>
      <article className="panel"><div className="panel-title"><h2>Repository binding</h2></div><dl className="fact-list"><div><dt>Remote</dt><dd className="breakable">{String(detail.remote_url ?? '—')}</dd></div><div><dt>OAuth clients</dt><dd>{detail.oauth_clients?.filter(c => !c.deleted_at).length ?? 0} active</dd></div><div><dt>Local path</dt><dd>Hidden by Host</dd></div></dl></article></div>
      <h2 className="section-title">Active OAuth clients</h2><OAuthTable clients={(detail.oauth_clients ?? []).filter(client => !client.deleted_at)} onChanged={load} onSecret={setSecret} /></>}
    {creatingClient && <OAuthClientModal sources={[{ id: sourceId, name: detail?.name ?? sourceId }]} initialSource={sourceId} lockSource onClose={() => setCreatingClient(false)} onCreated={async result => { setCreatingClient(false); setSecret(result); await load(); }} />}
    {secret && <SecretModal result={secret} onClose={() => setSecret(null)} />}
  </section>;
}

function OAuthPage({ initialSource }: { initialSource: string | null }) {
  const [clients, setClients] = useState<OAuthClient[]>([]); const [sources, setSources] = useState<SourceSummary[]>([]); const [sourceId, setSourceId] = useState(initialSource ?? ''); const [status, setStatus] = useState<Exclude<OAuthClientStatus, 'all'>>('active'); const [creating, setCreating] = useState(false); const [secret, setSecret] = useState<SecretResult | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(''); try { const [c, s] = await Promise.all([api.oauthClients({ sourceId: sourceId || undefined, status }), api.sources()]); setClients(c.data.filter(client => status === 'active' ? !client.deleted_at : !!client.deleted_at)); setSources(s.data); setLoaded(true); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, [sourceId, status]);
  useEffect(() => { void load(); }, [load]);
  return <section className="page"><PageHeader eyebrow="Credential lifecycle" title="OAuth Clients" description="Source-bound clients. Secrets are displayed once and never persisted." action={<button className="primary-button" onClick={() => setCreating(true)} disabled={!sources.length}>New client</button>} />
    <div className="oauth-controls"><div className="status-tabs" role="tablist" aria-label="OAuth client status"><button className={status === 'active' ? 'active' : ''} onClick={() => setStatus('active')} role="tab" aria-selected={status === 'active'}>Active</button><button className={status === 'revoked' ? 'active' : ''} onClick={() => setStatus('revoked')} role="tab" aria-selected={status === 'revoked'}>Revoked</button></div><div className="toolbar"><label>Source <select value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">All sources</option>{sources.map(s => <option key={s.id} value={s.id}>{sourceOptionLabel(s)}</option>)}</select></label><button className="secondary-button" onClick={load}>Refresh</button></div></div>
    {error && <ErrorBanner error={error} onRetry={load} />}{loading && !loaded ? <Loading /> : loaded ? <OAuthTable clients={clients} onChanged={load} onSecret={setSecret} /> : null}
    {creating && <OAuthClientModal sources={sources} initialSource={sourceId || undefined} onClose={() => setCreating(false)} onCreated={async result => { setCreating(false); setStatus('active'); setSecret(result); await load(); }} />}
    {secret && <SecretModal result={secret} onClose={() => setSecret(null)} />}
  </section>;
}

function OAuthTable({ clients, onChanged, onSecret }: { clients: OAuthClient[]; onChanged: () => void; onSecret: (result: SecretResult) => void }) {
  const [error, setError] = useState(''); const [editing, setEditing] = useState<OAuthClient | null>(null); const act = async (client: OAuthClient, action: 'rotate' | 'revoke') => { if (!confirm(action === 'rotate' ? 'Rotate creates a new Client ID and revokes the old client and tokens. Continue?' : 'Revoke this client and all of its tokens?')) return; try { if (action === 'rotate') onSecret((await api.rotateOAuthClient(client.client_id)).data); else await api.revokeOAuthClient(client.client_id); onChanged(); } catch (cause) { setError(errorText(cause)); } };
  if (!clients.length) return <Empty>No OAuth clients found.</Empty>;
  return <>{error && <ErrorBanner error={error} />}<div className="table-card"><table><thead><tr><th>Client</th><th>Contact</th><th>Source</th><th>Scope</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>{clients.map(client => <tr key={client.client_id}><td><strong>{client.client_name}</strong><code title={client.client_id}>{shortId(client.client_id, 24)}</code></td><td>{client.contact_email || '—'}</td><td><code>{client.source_id}</code></td><td><span className="scope-list">{client.scope.split(' ').filter(Boolean).map(scope => <span key={scope}>{scope}</span>)}</span></td><td><StatusBadge value={client.deleted_at ? 'revoked' : 'active'} /></td><td>{formatTime(client.created_at)}</td><td>{!client.deleted_at && <div className="button-row"><button className="table-button" onClick={() => setEditing(client)}>Edit scope</button><button className="table-button" onClick={() => act(client, 'rotate')}>Rotate</button><button className="table-button danger" onClick={() => act(client, 'revoke')}>Revoke</button></div>}</td></tr>)}</tbody></table></div>{editing && <OAuthScopeModal client={editing} onClose={() => setEditing(null)} onUpdated={async () => { setEditing(null); await onChanged(); }} />}</>;
}

function OAuthClientModal({ sources, initialSource, lockSource = false, onClose, onCreated }: { sources: Array<Pick<SourceSummary, 'id' | 'name'>>; initialSource?: string; lockSource?: boolean; onClose: () => void; onCreated: (result: SecretResult) => Promise<void> | void }) {
  const [read, setRead] = useState(true); const [write, setWrite] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!read && !write) { setError('Select at least one permission.'); return; } const data = new FormData(event.currentTarget); setBusy(true); setError(''); try { const result = await api.createOAuthClient({ source_id: String(data.get('source_id')), name: String(data.get('name')), contact_email: String(data.get('contact_email')), scopes: [read && 'read', write && 'write'].filter(Boolean) as string[] }); await onCreated(result.data); } catch (cause) { setError(errorText(cause)); setBusy(false); } };
  return <Modal title="Create OAuth client" onClose={busy ? undefined : onClose}><form className="form-grid" onSubmit={submit}><label>Client name<input name="name" required autoFocus placeholder="Windows Admin Agent" /></label><label>Contact email<input name="contact_email" type="email" required placeholder="operator@example.com" /></label><label className="full">Bound source<select name="source_id" required defaultValue={initialSource ?? sources[0]?.id ?? ''} disabled={lockSource}>{sources.map(source => <option key={source.id} value={source.id}>{sourceOptionLabel(source)}</option>)}</select>{lockSource && <input type="hidden" name="source_id" value={initialSource} />}</label><fieldset className="permission-field full"><legend>Permissions</legend><label className="permission-option"><input type="checkbox" checked={read} onChange={event => setRead(event.target.checked)} /><span><strong>Read</strong><small>Search, retrieve, and inspect this Source.</small></span></label><label className="permission-option"><input type="checkbox" checked={write} onChange={event => setWrite(event.target.checked)} /><span><strong>Write</strong><small>Create or update content. Write also implies read at runtime.</small></span></label></fieldset>{error && <div className="error-banner full">{error}</div>}<div className="modal-actions full"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy || (!read && !write)}>{busy ? 'Creating…' : 'Create client'}</button></div></form></Modal>;
}

function OAuthScopeModal({ client, onClose, onUpdated }: { client: OAuthClient; onClose: () => void; onUpdated: () => Promise<void> | void }) {
  const current = new Set(client.scope.split(' ').filter(Boolean)); const [read, setRead] = useState(current.has('read')); const [write, setWrite] = useState(current.has('write')); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!read && !write) { setError('Select at least one permission.'); return; } if (!confirm('Changing scope immediately revokes this client\'s existing access tokens and authorization codes. Continue?')) return; setBusy(true); setError(''); try { await api.updateOAuthClientScopes(client.client_id, [read && 'read', write && 'write'].filter(Boolean) as string[]); await onUpdated(); } catch (cause) { setError(errorText(cause)); setBusy(false); } };
  return <Modal title="Edit client permissions" onClose={busy ? undefined : onClose}><form onSubmit={submit}><div className="client-context"><strong>{client.client_name}</strong><code>{client.client_id}</code><span>{client.contact_email}</span></div><fieldset className="permission-field"><legend>Permissions</legend><label className="permission-option"><input type="checkbox" checked={read} onChange={event => setRead(event.target.checked)} /><span><strong>Read</strong><small>Search, retrieve, and inspect this Source.</small></span></label><label className="permission-option"><input type="checkbox" checked={write} onChange={event => setWrite(event.target.checked)} /><span><strong>Write</strong><small>Create or update content. Write also implies read at runtime.</small></span></label></fieldset><div className="scope-warning">Saving permissions immediately revokes every token and pending authorization code issued to this client. The existing Client ID and secret remain valid for requesting a new token.</div>{error && <div className="error-banner">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy || (!read && !write)}>{busy ? 'Saving…' : 'Save permissions'}</button></div></form></Modal>;
}

function SecretModal({ result, onClose }: { result: SecretResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false); const [confirmed, setConfirmed] = useState(false); const secret = result.client_secret ?? '';
  const copy = async () => { await navigator.clipboard.writeText(secret); setCopied(true); };
  return <Modal title="Save this secret now"><div className="secret-warning">This secret is shown once. Closing this dialog permanently clears it from the page.</div><label>Client ID<div className="secret-value"><code>{result.client_id}</code><button onClick={() => navigator.clipboard.writeText(result.client_id)}>Copy</button></div></label><label>Client secret<div className="secret-value"><code>{secret || 'No secret returned'}</code><button onClick={copy} disabled={!secret}>{copied ? 'Copied' : 'Copy'}</button></div></label><label className="check confirm-save"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I saved the client ID and secret in an approved password manager.</label><div className="modal-actions"><button className="primary-button" disabled={!confirmed} onClick={onClose}>Done and clear secret</button></div></Modal>;
}

function JobsPage({ initialSource }: { initialSource: string | null }) {
  const [sources, setSources] = useState<SourceSummary[]>([]); const [sourceId, setSourceId] = useState(initialSource ?? ''); const [status, setStatus] = useState(''); const [jobType, setJobType] = useState(''); const [jobs, setJobs] = useState<AdminJob[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [history, setHistory] = useState<string[]>([]); const [selected, setSelected] = useState<AdminJob | null>(null); const [profiles, setProfiles] = useState<Array<{ id: string; phases: string[] }>>([]); const [profile, setProfile] = useState('quick'); const [customPhases, setCustomPhases] = useState<string[]>(['lint', 'backlinks', 'sync', 'extract']); const [dryRun, setDryRun] = useState(false); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [loaded, setLoaded] = useState(false);
  useEffect(() => { let active = true; setLoading(true); Promise.all([api.sources(), api.cycleProfiles()]).then(([s, p]) => { if (!active) return; setSources(s.data); setProfiles(p.data); if (!sourceId && s.data[0]) setSourceId(s.data[0].id); if (!s.data.length) setLoaded(true); }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const load = useCallback(async () => { if (!sourceId) return; setLoading(true); setError(''); try { const response = await api.sourceJobs(sourceId, { status: status || undefined, limit: 50, cursor: cursor ?? undefined }); setJobs(response.data); setNextCursor(response.meta.next_cursor ?? null); setLoaded(true); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, [sourceId, status, cursor]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => { setCursor(null); setHistory([]); }, [sourceId, status]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!jobs.some(job => !terminalStatuses.has(job.status))) return; const timer = window.setInterval(() => void load(), 4000); return () => window.clearInterval(timer); }, [jobs, load]);
  const next = () => { if (!nextCursor) return; setHistory(items => [...items, cursor ?? '']); setCursor(nextCursor); };
  const previous = () => { const prior = history[history.length - 1]; setHistory(items => items.slice(0, -1)); setCursor(prior || null); };
  const visibleJobs = useMemo(() => jobs.filter(job => !jobType || job.name.toLowerCase().includes(jobType.toLowerCase())), [jobs, jobType]);
  const safePhases = useMemo(() => Array.from(new Set(profiles.flatMap(item => item.phases))).filter(item => item !== 'purge'), [profiles]);
  const submit = async () => { if (!sourceId || (profile === 'custom' && !customPhases.length)) return; try { const result = await api.submitCycle(sourceId, { profile, phases: profile === 'custom' ? customPhases : undefined, dry_run: dryRun }); await load(); setSelected((await api.job(result.data.job_id)).data); } catch (cause) { setError(errorText(cause)); } };
  return <section className="page"><PageHeader eyebrow="Background work" title="Jobs & Dream Cycles" description="Filter by SourceID, inspect progress, and safely submit approved cycle profiles." action={<button className="secondary-button" onClick={load} disabled={loading || !sourceId}>Refresh</button>} /><div className="job-layout"><div><div className="toolbar"><label>Source <select value={sourceId} onChange={e => setSourceId(e.target.value)}>{sources.map(s => <option key={s.id} value={s.id}>{sourceOptionLabel(s)}</option>)}</select></label><label>Status <select value={status} onChange={e => setStatus(e.target.value)}><option value="">All</option>{['waiting','active','delayed','completed','failed','dead','cancelled'].map(s => <option key={s}>{s}</option>)}</select></label><label>Job type<input value={jobType} onChange={e => setJobType(e.target.value)} placeholder="Filter loaded jobs" /></label></div>{error && <ErrorBanner error={error} onRetry={load} />}{loading && !loaded ? <Loading /> : loaded ? visibleJobs.length ? <div className="table-card"><table><thead><tr><th>ID</th><th>Job</th><th>Status</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>{visibleJobs.map(job => <tr key={job.id} className="clickable" onClick={() => setSelected(job)} onKeyDown={event => activateRow(event, () => setSelected(job))} role="button" tabIndex={0} aria-label={`Open job ${job.id}: ${job.name}`}><td>#{job.id}</td><td><strong>{job.name}</strong><code>{job.queue}</code></td><td><StatusBadge value={job.status} /></td><td>{job.attempts_made}/{job.max_attempts}</td><td>{formatTime(job.updated_at)}</td></tr>)}</tbody></table></div> : <Empty>{sourceId ? 'No jobs match these filters.' : 'No sources are available.'}</Empty> : null}<div className="pagination"><button onClick={previous} disabled={loading || !history.length}>Previous</button><button onClick={next} disabled={loading || !nextCursor}>Next</button></div></div>
    <aside className="cycle-panel"><p className="eyebrow">Submit cycle</p><h2>Dream Cycle</h2><label>Profile<select value={profile} onChange={e => setProfile(e.target.value)}>{profiles.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}<option value="custom">custom · advanced</option></select></label>{profile === 'custom' ? <details className="advanced-phases" open><summary>Advanced phases</summary><div>{safePhases.map(phase => <label className="check" key={phase}><input type="checkbox" checked={customPhases.includes(phase)} onChange={e => setCustomPhases(items => e.target.checked ? [...items, phase] : items.filter(item => item !== phase))} /> {phase}</label>)}</div></details> : <div className="phase-list">{profiles.find(p => p.id === profile)?.phases.map(p => <span key={p}>{p}</span>)}</div>}<label className="check"><input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} /> Dry run</label><button className="primary-button" onClick={submit} disabled={!sourceId || (profile === 'custom' && !customPhases.length)}>Submit cycle</button><small>Purge is never offered. Custom phases are sent only from this explicit Advanced selection.</small></aside></div>{selected && <JobModal initial={selected} onClose={() => setSelected(null)} onChanged={load} />}</section>;
}

function JobModal({ initial, onClose, onChanged }: { initial: AdminJob; onClose: () => void; onChanged: () => void }) {
  const [job, setJob] = useState(initial); const [error, setError] = useState('');
  const refresh = useCallback(async () => { try { setJob((await api.job(job.id)).data); } catch (cause) { setError(errorText(cause)); } }, [job.id]);
  useEffect(() => { if (terminalStatuses.has(job.status)) return; const timer = window.setInterval(() => void refresh(), 4000); return () => window.clearInterval(timer); }, [job.status, refresh]);
  const act = async (action: 'cancel' | 'retry') => { try { setJob((await (action === 'cancel' ? api.cancelJob(job.id) : api.retryJob(job.id))).data); onChanged(); } catch (cause) { setError(errorText(cause)); } };
  return <Modal title={`Job #${job.id}`} onClose={onClose}>{error && <ErrorBanner error={error} />}<div className="job-heading"><div><h3>{job.name}</h3><code>{job.queue}</code></div><StatusBadge value={job.status} /></div><dl className="fact-list two-col"><div><dt>Source</dt><dd>{job.source_id ?? '—'}</dd></div><div><dt>Attempts</dt><dd>{job.attempts_made}/{job.max_attempts}</dd></div><div><dt>Started</dt><dd>{formatTime(job.started_at)}</dd></div><div><dt>Finished</dt><dd>{formatTime(job.finished_at)}</dd></div></dl>{job.error_text && <pre className="error-detail">{job.error_text}</pre>}<JsonViewer title="Progress" value={job.progress} /><JsonViewer title="Result" value={job.result} /><div className="modal-actions"><button className="secondary-button" onClick={refresh}>Refresh</button>{cancellableStatuses.has(job.status) && <button className="danger-button" onClick={() => act('cancel')}>Cancel job</button>}{retryableStatuses.has(job.status) && <button className="primary-button" onClick={() => act('retry')}>Retry job</button>}</div></Modal>;
}

function JsonViewer({ title, value }: { title: string; value: unknown }) { return <details className="json-viewer" open={value != null}><summary>{title}</summary><pre>{value == null ? 'No data' : JSON.stringify(value, null, 2)}</pre></details>; }

function AutopilotPage() {
  const [status, setStatus] = useState<AutopilotStatus | null>(null); const [error, setError] = useState('');
  const load = useCallback(async () => { try { setStatus((await api.autopilot()).data); setError(''); } catch (cause) { setError(errorText(cause)); } }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10000); return () => window.clearInterval(timer); }, [load]);
  return <section className="page"><PageHeader eyebrow="Read-only runtime" title="Autopilot" description="Heartbeat and supervisor diagnostics. Daemon controls remain on the Ubuntu Host." action={<button className="secondary-button" onClick={load}>Refresh</button>} />{error && <ErrorBanner error={error} onRetry={load} />}{!status ? <Loading /> : <><div className="hero-status"><div><span>Current state</span><h2>{status.state.split('_').join(' ')}</h2></div><StatusBadge value={status.heartbeat_stale ? 'heartbeat stale' : status.state} /></div><div className="overview-panels"><article className="panel"><h2>Runtime</h2><dl className="fact-list"><div><dt>Configured</dt><dd>{status.configured ? 'Yes' : 'No'}</dd></div><div><dt>Engine</dt><dd>{status.engine ?? '—'}</dd></div><div><dt>Started</dt><dd>{formatTime(status.started_at)}</dd></div><div><dt>Heartbeat</dt><dd>{formatTime(status.heartbeat_at)}</dd></div></dl></article><article className="panel"><h2>Dependencies</h2><dl className="fact-list"><div><dt>Database</dt><dd>{status.database?.state ?? '—'}</dd></div><div><dt>Last connected</dt><dd>{formatTime(status.database?.last_connected_at)}</dd></div><div><dt>Supervisor</dt><dd>{status.supervisor?.state ?? '—'}</dd></div><div><dt>Restart count</dt><dd>{status.supervisor?.restart_count ?? '—'}</dd></div></dl></article></div><div className="info-banner">Start, stop, and restart controls are intentionally not exposed by the Admin API.</div></>}</section>;
}

function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]); const [limit, setLimit] = useState(50); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { setEntries((await api.audit(limit)).data); setError(''); setLoaded(true); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); } }, [limit]);
  useEffect(() => { void load(); }, [load]);
  return <section className="page"><PageHeader eyebrow="Redacted operations" title="Audit Log" description="Request metadata and outcomes without tokens, secrets, passwords, or raw request bodies." action={<button className="secondary-button" onClick={load} disabled={loading}>Refresh</button>} /><div className="toolbar"><label>Rows <select value={limit} onChange={e => setLimit(Number(e.target.value))}><option>25</option><option>50</option><option>100</option><option>200</option></select></label></div>{error && <ErrorBanner error={error} onRetry={load} />}{loading && !loaded ? <Loading /> : loaded ? entries.length ? <div className="table-card"><table><thead><tr><th>Time</th><th>Action</th><th>Status</th><th>Source / Client / Job</th><th>Duration</th><th>Request ID</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}><td>{formatTime(entry.created_at)}</td><td><strong>{entry.action}</strong>{entry.error_code && <code>{entry.error_code}</code>}</td><td><StatusBadge value={entry.status} /></td><td><code>{entry.source_id ?? entry.client_id ?? (entry.job_id ? `job:${entry.job_id}` : '—')}</code></td><td>{entry.params_summary?.duration_ms != null ? `${entry.params_summary.duration_ms} ms` : '—'}</td><td><code title={entry.request_id}>{shortId(entry.request_id)}</code></td></tr>)}</tbody></table></div> : <Empty>No audit entries yet.</Empty> : null}</section>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose?: () => void }) {
  const dialogRef = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef(onClose);
  const titleId = React.useId();

  React.useEffect(() => { closeRef.current = onClose; }, [onClose]);
  React.useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR) ?? []).filter(element => !element.hidden);
    (focusable()[0] ?? dialog)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = focusable();
      const target = trappedFocusTarget(items, document.activeElement as HTMLElement | null, event.shiftKey);
      if (target !== undefined) {
        event.preventDefault();
        (target ?? dialog).focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  return <div className="modal-backdrop" role="presentation"><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="modal-header"><h2 id={titleId}>{title}</h2>{onClose && <button aria-label="Close" onClick={onClose}>×</button>}</div>{children}</section></div>;
}

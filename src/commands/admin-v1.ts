import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import type { SqlQuery } from '../core/oauth-provider.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import {
  VoltMindOAuthProvider,
  pgArray,
  validateTokenEndpointAuthMethod,
} from '../core/oauth-provider.ts';
import { assertAllowedScopes, normalizeScopesInput, parseScopeString } from '../core/scope.ts';
import { generateToken, hashToken } from '../core/utils.ts';
import { addSource, getSourceStatus } from '../core/sources-ops.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { ALL_PHASES, type CyclePhase } from '../core/cycle.ts';
import { GOGS_SSH_HOST, GOGS_API_URL, gogsRepoRef } from '../core/personal-provision.ts';
import type { MinionJobStatus } from '../core/minions/types.ts';

export interface AdminV1Session {
  sessionId: string;
  csrfToken: string;
  expiresAt: number;
}

export interface AdminV1Options {
  engine: BrainEngine;
  sql: SqlQuery;
  oauthProvider: VoltMindOAuthProvider;
  adminOrigin: string;
  getSession(req: express.Request): AdminV1Session | null;
}

const SAFE_PROFILES: Record<string, CyclePhase[]> = {
  sync_only: ['sync'],
  quick: ['lint', 'backlinks', 'sync', 'extract', 'embed', 'orphans'],
  dream: ['lint', 'backlinks', 'sync', 'synthesize', 'extract', 'extract_facts', 'patterns',
    'recompute_emotional_weight', 'consolidate', 'embed', 'orphans'],
};
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JOB_STATUSES = new Set<MinionJobStatus>([
  'waiting', 'active', 'completed', 'failed', 'delayed', 'dead', 'cancelled',
  'waiting-children', 'paused',
]);
const ADMIN_OAUTH_SCOPES = new Set(['read', 'write']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function adminOAuthScopes(raw: unknown): string {
  if (raw === undefined || raw === null) throw new Error('scopes must be explicitly provided');
  const normalized = normalizeScopesInput(raw);
  const scopes = parseScopeString(normalized);
  if (scopes.length === 0 || scopes.some(scope => !ADMIN_OAUTH_SCOPES.has(scope))) {
    throw new Error('Admin OAuth clients only support read and write scopes');
  }
  return normalized;
}

function requiredClientName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('name is required');
  return raw.trim();
}

function requiredContactEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('contact_email is required');
  const email = raw.trim();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new Error('contact_email is invalid');
  return email;
}

function ok(res: express.Response, data: unknown, meta: Record<string, unknown> = {}) {
  res.json({ data, meta: { request_id: res.locals.requestId, ...meta } });
}

function fail(res: express.Response, status: number, code: string, message: string, details?: unknown) {
  res.locals.errorCode = code;
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) }, request_id: res.locals.requestId });
}

function sourceId(value: unknown): string {
  if (typeof value !== 'string' || !isValidSourceId(value)) throw new Error('invalid_source_id');
  return value;
}

function numberParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('invalid_id');
  return n;
}

function encodeCursor(id: number): string { return Buffer.from(String(id)).toString('base64url'); }
function decodeCursor(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const id = Number(Buffer.from(value, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid_cursor');
  return id;
}
function redactedRemote(value: string | null): string | null {
  if (!value) return null;
  if (/^[^@\/\s]+@[^:\s]+:/.test(value)) return value;
  const url = new URL(value);
  url.username = ''; url.password = '';
  return url.toString();
}
function remoteHost(value: string): string {
  const scp = value.match(/^[^@\/\s]+@([^:\s]+):/);
  return scp?.[1] ?? new URL(value).hostname;
}

function presentJob(job: any) {
  return {
    id: job.id, source_id: job.source_id, name: job.name, queue: job.queue, status: job.status,
    priority: job.priority, attempts_made: job.attempts_made, max_attempts: job.max_attempts,
    progress: job.progress, result: job.result, error_text: job.error_text,
    created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
    updated_at: job.updated_at,
  };
}

export async function rotateOAuthClient(engine: BrainEngine, oldId: string) {
  return engine.transaction(async tx => {
    const rows = await tx.executeRaw<any>(
      `SELECT client_name,contact_email,source_id,federated_read,grant_types,scope,token_endpoint_auth_method FROM oauth_clients WHERE client_id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [oldId],
    );
    const old = rows[0];
    if (!old) return null;
    const grantTypes = Array.isArray(old.grant_types) ? old.grant_types.map(String) : [];
    const federatedRead = Array.isArray(old.federated_read) ? old.federated_read.map(String) : [String(old.source_id)];
    const scopes = String(old.scope);
    assertAllowedScopes(parseScopeString(scopes));
    const authMethod = validateTokenEndpointAuthMethod(old.token_endpoint_auth_method);
    const clientId = generateToken("voltmind_cl_");
    const clientSecret = authMethod === "none" ? undefined : generateToken("voltmind_cs_");
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    await tx.executeRaw(
      `INSERT INTO oauth_clients (client_id,client_secret_hash,client_name,contact_email,redirect_uris,grant_types,scope,token_endpoint_auth_method,client_id_issued_at,source_id,federated_read) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [clientId, secretHash, String(old.client_name), old.contact_email ?? null, pgArray([]), pgArray(grantTypes), scopes, authMethod, Math.floor(Date.now() / 1000), String(old.source_id), pgArray(federatedRead)],
    );
    await tx.executeRaw("DELETE FROM oauth_tokens WHERE client_id=$1", [oldId]);
    await tx.executeRaw("DELETE FROM oauth_codes WHERE client_id=$1", [oldId]);
    await tx.executeRaw("UPDATE oauth_clients SET deleted_at=now() WHERE client_id=$1", [oldId]);
    return { replacedClientId: oldId, clientId, clientSecret, sourceId: String(old.source_id) };
  });
}

export function adminV1OpenApi() {
  return {
    openapi: '3.1.0',
    info: { title: 'VoltMind Host Admin API', version: '1.0.0' },
    servers: [{ url: '/admin/api/v1' }],
    security: [{ adminCookie: [] }],
    components: {
      securitySchemes: {
        adminCookie: { type: 'apiKey', in: 'cookie', name: 'voltmind_admin' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-VoltMind-CSRF' },
      },
      schemas: {
        OAuthClient: {
          type: 'object',
          properties: {
            client_id: { type: 'string' }, client_name: { type: 'string' },
            contact_email: { type: ['string', 'null'], format: 'email' },
            source_id: { type: ['string', 'null'] }, federated_read: { type: 'array', items: { type: 'string' } },
            grant_types: { type: 'array', items: { type: 'string' } }, scope: { type: ['string', 'null'] },
            token_endpoint_auth_method: { type: ['string', 'null'] }, created_at: { type: 'string', format: 'date-time' },
            deleted_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        OAuthClientCreateRequest: {
          type: 'object', required: ['name', 'contact_email', 'source_id', 'scopes'], additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 }, contact_email: { type: 'string', format: 'email' },
            source_id: { type: 'string' }, scopes: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['read', 'write'] } },
          },
        },
        OAuthClientCreateResult: {
          type: 'object', required: ['client_id', 'client_secret', 'source_id', 'client_name', 'contact_email', 'scope', 'secret_shown_once'],
          properties: {
            client_id: { type: 'string' }, client_secret: { type: 'string', writeOnly: true, description: 'Shown once in this create response and never returned by GET.' },
            source_id: { type: 'string' }, client_name: { type: 'string' }, contact_email: { type: 'string', format: 'email' },
            scope: { type: 'string' }, secret_shown_once: { type: 'boolean', const: true },
          },
        },
        OAuthClientScopePatchRequest: {
          type: 'object', required: ['scopes'], additionalProperties: false,
          properties: { scopes: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['read', 'write'] } } },
        },
        OAuthClientScopePatchResult: {
          type: 'object', required: ['client_id', 'scope', 'tokens_revoked', 'codes_revoked', 'updated'],
          properties: {
            client_id: { type: 'string' }, scope: { type: 'string' }, tokens_revoked: { type: 'integer', minimum: 0 },
            codes_revoked: { type: 'integer', minimum: 0 }, updated: { type: 'boolean', const: true },
          },
        },
      },
    },
    paths: {
      '/session': { get: { summary: 'Get session and CSRF token' } },
      '/autopilot': { get: { summary: 'Get redacted daemon runtime status' } },
      '/overview': { get: { summary: 'Host overview' } },
      '/sources': { get: { summary: 'List sources' }, post: { summary: 'Create source', security: [{ adminCookie: [], csrfToken: [] }] } },
      '/sources/{sourceId}': { get: { summary: 'Source detail' } },
      '/sources/{sourceId}/archive': { post: { summary: 'Archive source and revoke its OAuth clients', security: [{ adminCookie: [], csrfToken: [] }] } },
      '/sources/{sourceId}/restore': { post: { summary: 'Restore source; OAuth clients stay revoked', security: [{ adminCookie: [], csrfToken: [] }] } },
      '/oauth-clients': {
        get: {
          summary: 'List OAuth clients',
          parameters: [
            { name: 'source_id', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['active', 'revoked', 'all'], default: 'active' } },
          ],
          responses: { '200': { description: 'OAuth clients without secrets, hashes, tokens, or host paths', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/OAuthClient' } } } } } } } },
        },
        post: {
          summary: 'Create source-bound OAuth client and show its secret once',
          description: 'Requires the Admin cookie and X-VoltMind-CSRF. The client secret appears only in the 201 response.',
          security: [{ adminCookie: [], csrfToken: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/OAuthClientCreateRequest' } } } },
          responses: {
            '201': { description: 'Created; secret shown once', content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/OAuthClientCreateResult' } } } } } },
            '400': { description: 'Invalid name, email, source ID, or scopes' }, '409': { description: 'Source missing or archived' },
          },
        },
      },
      '/oauth-clients/{clientId}': {
        patch: {
          summary: 'Update active client scopes and revoke all existing tokens and authorization codes',
          description: 'Requires the Admin cookie and X-VoltMind-CSRF. The client ID and secret remain unchanged; no secret is returned.',
          security: [{ adminCookie: [], csrfToken: [] }],
          parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/OAuthClientScopePatchRequest' } } } },
          responses: {
            '200': { description: 'Scopes updated and prior credentials revoked', content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/OAuthClientScopePatchResult' } } } } } },
            '400': { description: 'invalid_scopes' }, '404': { description: 'oauth_client_not_found' }, '409': { description: 'oauth_client_revoked' },
          },
        },
      },
      '/oauth-clients/{clientId}/rotate': { post: { summary: 'Rotate secret by replacing the client', security: [{ adminCookie: [], csrfToken: [] }] } },
      '/oauth-clients/{clientId}/revoke': { post: { summary: 'Revoke client and tokens', security: [{ adminCookie: [], csrfToken: [] }] } },
      '/sources/{sourceId}/gogs': { get: { summary: 'Repository health without credentials or local paths' } },
      '/sources/{sourceId}/jobs': { get: { summary: 'List source jobs' } },
      '/cycle-profiles': { get: { summary: 'List safe cycle profiles' } },
      '/sources/{sourceId}/cycles': { get: { summary: 'List cycles' }, post: { summary: 'Submit safe cycle profile', security: [{ adminCookie: [], csrfToken: [] }] } },
      '/jobs/{jobId}': { get: { summary: 'Get job details' } },
      '/jobs/{jobId}/cancel': { post: { summary: 'Cancel job', security: [{ adminCookie: [], csrfToken: [] }] } },
      '/jobs/{jobId}/retry': { post: { summary: 'Retry failed job', security: [{ adminCookie: [], csrfToken: [] }] } },
      '/audit': { get: { summary: 'Read redacted admin audit log' } },
    },
  };
}

function createAdminScopedEngine(rawEngine: BrainEngine, extraSourceIds: string[] = []): BrainEngine {
  if (rawEngine.kind !== 'postgres') return rawEngine;
  const scoped = Object.create(rawEngine) as BrainEngine;
  scoped.executeRaw = async <T = Record<string, unknown>>(
    query: string,
    params?: unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<T[]> => rawEngine.transaction(async tx => {
    await tx.setAdminSourceScope(extraSourceIds);
    return tx.executeRaw<T>(query, params, opts);
  });
  scoped.transaction = <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> =>
    rawEngine.transaction(async tx => {
      await tx.setAdminSourceScope(extraSourceIds);
      return fn(tx);
    });
  return scoped;
}

export function createAdminV1Router(options: AdminV1Options): express.Router {
  const { engine: rawEngine, sql: providedSql, oauthProvider, adminOrigin, getSession } = options;
  const engine = createAdminScopedEngine(rawEngine);
  const sql = rawEngine.kind === 'postgres' ? sqlQueryForEngine(engine) : providedSql;
  const queue = new MinionQueue(engine);
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.use((req, res, next) => {
    res.locals.requestId = String(req.headers['x-request-id'] || randomUUID()).slice(0, 128);
    res.setHeader('X-Request-ID', res.locals.requestId);
    const session = getSession(req);
    if (!session) return fail(res, 401, 'admin_auth_required', 'Admin authentication required');
    res.locals.adminSession = session;
    if (MUTATIONS.has(req.method)) {
      const origin = req.header('Origin');
      if (origin && origin !== adminOrigin) {
        return fail(res, 403, 'origin_failed', 'Request Origin does not match the configured Admin public URL');
      }
      const supplied = req.header('X-VoltMind-CSRF');
      if (!supplied || supplied !== session.csrfToken) {
        return fail(res, 403, 'csrf_failed', 'Missing or invalid X-VoltMind-CSRF token');
      }
    }
    next();
  });

  router.use((req, res, next) => {
    if (!MUTATIONS.has(req.method)) return next();
    const started = Date.now();
    res.on('finish', () => {
      const session = res.locals.adminSession as AdminV1Session;
      const audit = (res.locals.audit ?? {}) as Record<string, unknown>;
      const summary = { body_keys: Object.keys(req.body ?? {}).filter(k => !/secret|token|password/i.test(k)), duration_ms: Date.now() - started };
      void engine.executeRaw(
        `INSERT INTO admin_audit_log (request_id, session_hash, source_id, client_id, job_id, action, status, params_summary, ip, error_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9,$10)`,
        [res.locals.requestId, createHash('sha256').update(session.sessionId).digest('hex'), audit.source_id ?? null,
          audit.client_id ?? null, audit.job_id ?? null, audit.action ?? `${req.method} ${req.path}`,
          // IP addresses are personal data and add no operator value to the
          // source/client/job-scoped Admin audit. Do not persist them.
          res.statusCode < 400 ? 'ok' : 'error', JSON.stringify(summary), null, res.locals.errorCode ?? null],
      ).catch(err => console.error('[admin-v1] audit insert failed:', err instanceof Error ? err.message : err));
    });
    next();
  });

  router.get('/openapi.json', (_req, res) => ok(res, adminV1OpenApi()));
  router.get('/session', (req, res) => {
    const s = getSession(req)!;
    ok(res, { authenticated: true, csrf_token: s.csrfToken, expires_at: new Date(s.expiresAt).toISOString() });
  });

  router.get('/autopilot', async (_req, res) => {
    const { readRuntimeStatus, isHeartbeatStale } = await import('../core/autopilot/runtime-status.ts');
    const runtime = readRuntimeStatus();
    if (!runtime) return ok(res, { configured: false, state: 'stopped_or_unknown' });
    ok(res, { configured: true, state: runtime.state, engine: runtime.engine, started_at: runtime.startedAt,
      updated_at: runtime.updatedAt, heartbeat_at: runtime.heartbeatAt, heartbeat_stale: isHeartbeatStale(runtime.heartbeatAt, 120000),
      database: { state: runtime.database.state, last_connected_at: runtime.database.lastConnectedAt },
      supervisor: { state: runtime.supervisor.state, worker_expected: runtime.supervisor.workerExpected, restart_count: runtime.supervisor.restartCount } });
  });

  router.get('/overview', async (_req, res) => {
    try {
      const [sources, clients, jobs] = await Promise.all([
        sql`SELECT count(*)::int total, count(*) FILTER (WHERE archived IS TRUE)::int archived FROM sources`,
        sql`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int active, count(*) FILTER (WHERE deleted_at IS NOT NULL)::int revoked FROM oauth_clients`,
        sql`SELECT count(*) FILTER (WHERE status IN ('waiting','delayed','active','waiting-children'))::int open,
                   count(*) FILTER (WHERE status IN ('failed','dead'))::int failed FROM minion_jobs`,
      ]);
      ok(res, { sources: sources[0], oauth_clients: clients[0], jobs: jobs[0] });
    } catch (e) { fail(res, 500, 'overview_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.get('/sources', async (req, res) => {
    try {
      const includeArchived = req.query.include_archived === 'true';
      const rows = await engine.executeRaw<any>(
        `SELECT s.id, s.name, s.archived, s.archived_at, s.archive_expires_at, s.last_sync_at, s.last_commit,
                COALESCE((s.config->>'federated')::boolean, false) federated,
                s.config->>'owner_email' owner_email,
                (SELECT count(*)::int FROM pages p WHERE p.source_id=s.id) page_count,
                (SELECT count(*)::int FROM oauth_clients c WHERE c.source_id=s.id AND c.deleted_at IS NULL) oauth_client_count
           FROM sources s ${includeArchived ? '' : 'WHERE s.archived IS NOT TRUE'} ORDER BY s.id`,
      );
      ok(res, rows);
    } catch (e) { fail(res, 500, 'sources_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.post('/sources', async (req, res) => {
    try {
      const id = sourceId(req.body?.source_id);
      if (typeof req.body?.remote_url === 'string' && remoteHost(req.body.remote_url) !== GOGS_SSH_HOST) {
        return fail(res, 400, 'repository_host_denied', 'Repository host must be ' + GOGS_SSH_HOST);
      }
      res.locals.audit = { action: 'source.create', source_id: id };
      const row = await addSource(engine, {
        id, name: typeof req.body?.name === 'string' ? req.body.name : id,
        remoteUrl: typeof req.body?.remote_url === 'string' ? req.body.remote_url : undefined,
        federated: req.body?.federated === true,
        allowSsh: req.body?.allow_ssh === true,
        extraConfig: typeof req.body?.owner_email === 'string' ? { owner_email: req.body.owner_email } : undefined,
      });
      ok(res.status(201), { source_id: row.id, name: row.name });
    } catch (e) { fail(res, 400, 'source_create_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.get('/sources/:sourceId', async (req, res) => {
    try {
      const id = sourceId(req.params.sourceId);
      const status = await getSourceStatus(engine, id);
      const clients = await sql`SELECT client_id, client_name, contact_email, grant_types, scope, federated_read, deleted_at, created_at
                                  FROM oauth_clients WHERE source_id=${id} ORDER BY created_at DESC`;
      ok(res, { ...status, local_path: undefined, remote_url: redactedRemote(status.remote_url), oauth_clients: clients });
    } catch (e) { fail(res, 404, 'source_not_found', e instanceof Error ? e.message : String(e)); }
  });

  router.post('/sources/:sourceId/archive', async (req, res) => {
    try {
      const id = sourceId(req.params.sourceId);
      if (id === 'default') return fail(res, 409, 'protected_source', 'The default source cannot be archived from Admin API');
      res.locals.audit = { action: 'source.archive', source_id: id };
      const result = await engine.transaction(async tx => {
        const source = await tx.executeRaw<any>(`UPDATE sources SET archived=true, archived_at=now(), archive_expires_at=now()+interval '72 hours',
          config=COALESCE(config,'{}'::jsonb)||'{"federated":false}'::jsonb WHERE id=$1 AND archived IS NOT TRUE RETURNING id,archive_expires_at`, [id]);
        if (!source[0]) return null;
        await tx.executeRaw(`DELETE FROM oauth_tokens WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE source_id=$1)`, [id]);
        await tx.executeRaw(`DELETE FROM oauth_codes WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE source_id=$1)`, [id]);
        const revoked = await tx.executeRaw<any>(`UPDATE oauth_clients SET deleted_at=now() WHERE source_id=$1 AND deleted_at IS NULL RETURNING client_id`, [id]);
        return { source_id: id, archive_expires_at: source[0].archive_expires_at, revoked_client_count: revoked.length };
      });
      if (!result) return fail(res, 404, 'source_not_found_or_archived', 'Source not found or already archived');
      ok(res, result);
    } catch (e) { fail(res, 400, 'source_archive_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.post('/sources/:sourceId/restore', async (req, res) => {
    try {
      const id = sourceId(req.params.sourceId);
      res.locals.audit = { action: 'source.restore', source_id: id };
      const rows = await engine.executeRaw<any>(`UPDATE sources SET archived=false, archived_at=NULL, archive_expires_at=NULL,
        config=COALESCE(config,'{}'::jsonb)||$1::text::jsonb WHERE id=$2 AND archived IS TRUE RETURNING id`,
        [JSON.stringify({ federated: req.body?.federated !== false }), id]);
      if (!rows[0]) return fail(res, 404, 'source_not_found_or_active', 'Source not found or already active');
      ok(res, { source_id: id, restored: true, oauth_clients_restored: false });
    } catch (e) { fail(res, 400, 'source_restore_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.get('/oauth-clients', async (req, res) => {
    try {
      const sid = typeof req.query.source_id === 'string' ? sourceId(req.query.source_id) : null;
      const status = typeof req.query.status === 'string' ? req.query.status : 'active';
      if (!['active', 'revoked', 'all'].includes(status)) {
        return fail(res, 400, 'invalid_status', 'status must be active, revoked, or all');
      }
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (sid) { params.push(sid); conditions.push(`source_id=$${params.length}`); }
      if (status === 'active') conditions.push('deleted_at IS NULL');
      else if (status === 'revoked') conditions.push('deleted_at IS NOT NULL');
      const rows = await engine.executeRaw<any>(
        `SELECT client_id,client_name,contact_email,source_id,federated_read,grant_types,scope,token_endpoint_auth_method,created_at,deleted_at
           FROM oauth_clients ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY created_at DESC`,
        params,
      );
      ok(res, rows);
    } catch (e) { fail(res, 400, 'oauth_clients_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.post('/oauth-clients', async (req, res) => {
    try {
      const name = requiredClientName(req.body?.name);
      const contactEmail = requiredContactEmail(req.body?.contact_email);
      const sid = sourceId(req.body?.source_id);
      let scopes: string;
      try { scopes = adminOAuthScopes(req.body?.scopes); }
      catch (e) { return fail(res, 400, 'invalid_scopes', e instanceof Error ? e.message : String(e)); }
      const source = await engine.executeRaw<any>('SELECT archived FROM sources WHERE id=$1', [sid]);
      if (!source[0] || source[0].archived) return fail(res, 409, 'source_unavailable', 'Source is missing or archived');
      const result = await oauthProvider.registerClientManual(
        name, ['client_credentials'], scopes, [], sid, [sid], 'client_secret_post', contactEmail,
      );
      res.locals.audit = { action: 'oauth_client.create', source_id: sid, client_id: result.clientId };
      ok(res.status(201), {
        client_id: result.clientId, client_secret: result.clientSecret, source_id: sid,
        client_name: name, contact_email: contactEmail, scope: scopes, secret_shown_once: true,
      });
    } catch (e) { fail(res, 400, 'oauth_client_create_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.patch('/oauth-clients/:clientId', async (req, res) => {
    const clientId = String(req.params.clientId);
    let scopes: string;
    try { scopes = adminOAuthScopes(req.body?.scopes); }
    catch (e) { return fail(res, 400, 'invalid_scopes', e instanceof Error ? e.message : String(e)); }

    try {
      const result = await engine.transaction(async tx => {
        const active = await tx.executeRaw<{ source_id: string | null }>(
          'SELECT source_id FROM oauth_clients WHERE client_id=$1 AND deleted_at IS NULL FOR UPDATE',
          [clientId],
        );
        if (!active[0]) {
          const existing = await tx.executeRaw<{ deleted_at: Date | string | null }>(
            'SELECT deleted_at FROM oauth_clients WHERE client_id=$1',
            [clientId],
          );
          return existing[0] ? { state: 'revoked' as const } : { state: 'missing' as const };
        }
        await tx.executeRaw('UPDATE oauth_clients SET scope=$1 WHERE client_id=$2', [scopes, clientId]);
        const tokens = await tx.executeRaw('DELETE FROM oauth_tokens WHERE client_id=$1 RETURNING 1', [clientId]);
        const codes = await tx.executeRaw('DELETE FROM oauth_codes WHERE client_id=$1 RETURNING 1', [clientId]);
        return {
          state: 'updated' as const,
          sourceId: active[0].source_id,
          tokensRevoked: tokens.length,
          codesRevoked: codes.length,
        };
      });
      if (result.state === 'missing') return fail(res, 404, 'oauth_client_not_found', 'OAuth client not found');
      if (result.state === 'revoked') return fail(res, 409, 'oauth_client_revoked', 'OAuth client is revoked');
      res.locals.audit = { action: 'oauth_client.scope_update', source_id: result.sourceId, client_id: clientId };
      ok(res, {
        client_id: clientId, scope: scopes, tokens_revoked: result.tokensRevoked,
        codes_revoked: result.codesRevoked, updated: true,
      });
    } catch (e) { fail(res, 400, 'oauth_client_scope_update_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.post('/oauth-clients/:clientId/revoke', async (req, res) => {
    try {
      const clientId = String(req.params.clientId);
      res.locals.audit = { action: 'oauth_client.revoke', client_id: clientId };
      const rows = await engine.transaction(async tx => {
        await tx.executeRaw('DELETE FROM oauth_tokens WHERE client_id=$1', [clientId]);
        await tx.executeRaw('DELETE FROM oauth_codes WHERE client_id=$1', [clientId]);
        return tx.executeRaw<any>('UPDATE oauth_clients SET deleted_at=COALESCE(deleted_at,now()) WHERE client_id=$1 RETURNING source_id', [clientId]);
      });
      if (!rows[0]) return fail(res, 404, 'oauth_client_not_found', 'OAuth client not found');
      res.locals.audit.source_id = rows[0].source_id;
      ok(res, { client_id: clientId, revoked: true });
    } catch (e) { fail(res, 400, 'oauth_client_revoke_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.post('/oauth-clients/:clientId/rotate', async (req, res) => {
    try {
      const oldId = String(req.params.clientId);
      const replacement = await rotateOAuthClient(engine, oldId);
      if (!replacement) return fail(res, 404, 'oauth_client_not_found', 'Active OAuth client not found');
      res.locals.audit = { action: 'oauth_client.rotate', source_id: replacement.sourceId, client_id: oldId };
      ok(res, { replaced_client_id: oldId, client_id: replacement.clientId, client_secret: replacement.clientSecret, secret_shown_once: replacement.clientSecret !== undefined });
    } catch (e) { fail(res, 400, 'oauth_client_rotate_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.get('/sources/:sourceId/gogs', async (req, res) => {
    try {
      const id = sourceId(req.params.sourceId);
      const status = await getSourceStatus(engine, id);
      const ref = status.remote_url ? gogsRepoRef(status.remote_url) : null;
      const adminToken = process.env.VOLTMIND_GOGS_ADMIN_TOKEN;
      let apiState: 'unconfigured' | 'healthy' | 'unreachable' | 'denied' = adminToken ? 'unreachable' : 'unconfigured';
      if (adminToken && ref) {
        try {
          const apiUrl = GOGS_API_URL + '/repos/' + encodeURIComponent(ref.owner) + '/' + encodeURIComponent(ref.repo);
          const response = await fetch(apiUrl, { headers: { Authorization: 'token ' + adminToken }, signal: AbortSignal.timeout(5000) });
          apiState = response.ok ? 'healthy' : (response.status === 401 || response.status === 403 ? 'denied' : 'unreachable');
        } catch { apiState = 'unreachable'; }
      }
      ok(res, { source_id: id, configured: !!status.remote_url, repository_host: status.remote_url ? remoteHost(status.remote_url) : null,
        repository_owner: ref?.owner ?? null, repository_name: ref?.repo ?? null, api_state: apiState,
        clone_state: status.clone_state, last_sync_at: status.last_sync_at, last_commit: status.last_commit });
    } catch (e) { fail(res, 404, 'repository_check_failed', e instanceof Error ? e.message : String(e)); }
  });
  router.get('/sources/:sourceId/jobs', async (req, res) => {
    try {
      const sid = sourceId(req.params.sourceId);
      const status = typeof req.query.status === 'string' && JOB_STATUSES.has(req.query.status as MinionJobStatus) ? req.query.status as MinionJobStatus : undefined;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const jobs = await queue.getJobs({ sourceId: sid, status, limit , beforeId: decodeCursor(req.query.cursor) });
      ok(res, jobs.map(presentJob), { next_cursor: jobs.length === limit ? encodeCursor(jobs[jobs.length - 1]!.id) : null });
    } catch (e) { fail(res, 400, 'jobs_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.get('/jobs/:jobId', async (req, res) => {
    try { const job = await queue.getJob(numberParam(req.params.jobId)); if (!job) return fail(res, 404, 'job_not_found', 'Job not found'); ok(res, presentJob(job)); }
    catch (e) { fail(res, 400, 'job_failed', e instanceof Error ? e.message : String(e)); }
  });

  for (const action of ['cancel', 'retry'] as const) router.post(`/jobs/:jobId/${action}`, async (req, res) => {
    try {
      const id = numberParam(req.params.jobId);
      const job = action === 'cancel' ? await queue.cancelJob(id) : await queue.retryJob(id);
      res.locals.audit = { action: `job.${action}`, job_id: id, source_id: job?.source_id ?? null };
      if (!job) return fail(res, 409, `job_${action}_rejected`, `Job cannot be ${action}ed from its current state`);
      ok(res, presentJob(job));
    } catch (e) { fail(res, 400, `job_${action}_failed`, e instanceof Error ? e.message : String(e)); }
  });

  router.get('/cycle-profiles', (_req, res) => ok(res, Object.entries(SAFE_PROFILES).map(([id, phases]) => ({ id, phases }))));
  router.get('/sources/:sourceId/cycles', async (req, res) => {
    try { const sid = sourceId(req.params.sourceId); const limit = Math.min(100, Number(req.query.limit) || 30); const jobs = await queue.getJobs({ sourceId: sid, name: 'autopilot-cycle', limit, beforeId: decodeCursor(req.query.cursor) }); ok(res, jobs.map(presentJob), { next_cursor: jobs.length === limit ? encodeCursor(jobs[jobs.length - 1]!.id) : null }); }
    catch (e) { fail(res, 400, 'cycles_failed', e instanceof Error ? e.message : String(e)); }
  });
  router.post('/sources/:sourceId/cycles', async (req, res) => {
    try {
      const sid = sourceId(req.params.sourceId);
      const src = await engine.executeRaw<any>('SELECT local_path,config,archived FROM sources WHERE id=$1', [sid]);
      if (!src[0] || src[0].archived) return fail(res, 409, 'source_unavailable', 'Source is missing or archived');
      if (typeof src[0].local_path !== 'string' || src[0].local_path.length === 0) {
        return fail(res, 409, 'source_not_syncable', 'Source has no local repository path');
      }
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : 'quick';
      let phases = SAFE_PROFILES[profile];
      if (profile === 'custom') {
        if (!Array.isArray(req.body?.phases) || req.body.phases.length === 0) return fail(res, 400, 'phases_required', 'Custom profile requires phases');
        phases = req.body.phases.filter((p: unknown): p is CyclePhase => typeof p === 'string' && ALL_PHASES.includes(p as CyclePhase) && p !== 'purge');
        if (phases.length !== req.body.phases.length) return fail(res, 400, 'unsafe_phase', 'One or more phases are not allowed');
      }
      if (!phases) return fail(res, 400, 'invalid_profile', 'Unknown cycle profile');
      const cfg = typeof src[0].config === 'string' ? JSON.parse(src[0].config) : src[0].config ?? {};
      const job = await queue.add('autopilot-cycle', { repoPath: src[0].local_path, source_id: sid, pull: !!cfg.remote_url, phases, dryRun: req.body?.dry_run === true },
        { timeout_ms: 45 * 60 * 1000, max_attempts: 2 });
      res.locals.audit = { action: 'cycle.submit', source_id: sid, job_id: job.id };
      ok(res.status(202), { job_id: job.id, source_id: sid, profile, phases, dry_run: req.body?.dry_run === true });
    } catch (e) { fail(res, 400, 'cycle_submit_failed', e instanceof Error ? e.message : String(e)); }
  });

  router.get('/audit', async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const rows = await engine.executeRaw<any>(`SELECT id,request_id,source_id,client_id,job_id,action,status,params_summary,error_code,created_at FROM admin_audit_log ORDER BY id DESC LIMIT $1`, [limit]);
      ok(res, rows);
    } catch (e) { fail(res, 500, 'audit_failed', e instanceof Error ? e.message : String(e)); }
  });

  return router;
}

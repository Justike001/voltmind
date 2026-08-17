import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { adminV1OpenApi, createAdminV1Router, rotateOAuthClient } from '../src/commands/admin-v1.ts';
import { VoltMindOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let provider: VoltMindOAuthProvider;
let server: Server;
let baseUrl: string;

const session = { sessionId: 'admin-session-fixture', csrfToken: 'csrf-fixture', expiresAt: Date.now() + 60_000 };
const activeSource = 'personal-example';
const archivedSource = 'archived-example';
const contactEmail = 'operator@example.com';

async function request(path: string, init: { method?: string; body?: unknown; csrf?: boolean; authenticated?: boolean } = {}) {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.authenticated !== false) headers.Cookie = 'voltmind_admin=session-fixture';
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && init.csrf !== false) headers['X-VoltMind-CSRF'] = session.csrfToken;
  const response = await fetch(baseUrl + path, {
    method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { response, json: await response.json() as any };
}

async function createClient(overrides: Record<string, unknown> = {}) {
  return request('/oauth-clients', {
    method: 'POST',
    body: { name: 'Windows Admin Agent', contact_email: contactEmail, source_id: activeSource, scopes: ['read', 'write'], ...overrides },
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
  provider = new VoltMindOAuthProvider({ sql: sqlQueryForEngine(engine) });
  const app = express();
  app.use('/admin/api/v1', createAdminV1Router({
    engine, sql: sqlQueryForEngine(engine), oauthProvider: provider, adminOrigin: 'https://localhost',
    getSession: req => req.headers.cookie?.includes('voltmind_admin=session-fixture') ? session : null,
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Admin v1 test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/admin/api/v1`;
}, 30000);

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM admin_audit_log');
  await engine.executeRaw('DELETE FROM oauth_codes');
  await engine.executeRaw('DELETE FROM oauth_tokens');
  await engine.executeRaw('DELETE FROM oauth_clients');
  await engine.executeRaw('DELETE FROM sources WHERE id IN ($1,$2)', [activeSource, archivedSource]);
  await engine.executeRaw('INSERT INTO sources (id,name,config,archived) VALUES ($1,$2,$3::text::jsonb,false),($4,$5,$6::text::jsonb,true)',
    [activeSource, 'Personal Example', '{}', archivedSource, 'Archived Example', '{}']);
});

describe('Admin API v1 schema and queue projection', () => {
  test('migration v123 is canonical and an existing brain upgrades contact_email', async () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(123);
    expect(MIGRATIONS.find(m => m.version === 123)?.name).toBe('oauth_clients_contact_email');
    await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN contact_email');
    await engine.setConfig('version', '122');
    const result = await runMigrations(engine);
    expect(result.current).toBe(LATEST_VERSION);
    const columns = await engine.executeRaw<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='oauth_clients' AND column_name='contact_email'",
    );
    expect(columns).toHaveLength(1);
  });

  test('fresh PostgreSQL, PGLite, and embedded schemas include contact_email', async () => {
    for (const path of ['src/schema.sql', 'src/core/pglite-schema.ts', 'src/core/schema-embedded.ts']) {
      const schema = readFileSync(path, 'utf8');
      expect(schema, path).toContain('contact_email           TEXT');
    }
    const columns = await engine.executeRaw<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='oauth_clients' AND column_name='contact_email'",
    );
    expect(columns).toHaveLength(1);
  });

  test('bootstrap adds the source projection before creating its index on existing brains', () => {
    for (const path of ['src/schema.sql', 'src/core/pglite-schema.ts', 'src/core/schema-embedded.ts']) {
      const schema = readFileSync(path, 'utf8');
      const alter = schema.indexOf('ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS source_id TEXT');
      const index = schema.indexOf('CREATE INDEX IF NOT EXISTS idx_minion_jobs_source_id');
      expect(alter, path).toBeGreaterThan(-1);
      expect(index, path).toBeGreaterThan(alter);
    }
  });

  test('projects snake_case and camelCase job source IDs and filters on the column', async () => {
    const a = await queue.add('sync', { source_id: 'source-a' });
    const b = await queue.add('extract', { sourceId: 'source-b' });
    await queue.add('lint', {});
    expect(a.source_id).toBe('source-a');
    expect(b.source_id).toBe('source-b');
    expect((await queue.getJobs({ sourceId: 'source-a' })).map(j => j.id)).toEqual([a.id]);
    expect((await queue.getJobs({ sourceId: 'source-b' })).map(j => j.id)).toEqual([b.id]);
  });
});

describe('Admin API v1 OAuth clients', () => {
  test('create requires explicit non-empty read/write scopes', async () => {
    const missing = await createClient({ scopes: undefined });
    expect(missing.response.status).toBe(400);
    expect(missing.json.error.code).toBe('invalid_scopes');
    for (const scopes of [[], ['admin'], ['sources_admin']]) {
      const invalid = await createClient({ scopes });
      expect(invalid.response.status).toBe(400);
      expect(invalid.json.error.code).toBe('invalid_scopes');
    }
  });

  test('create rejects invalid email, missing source, and archived source', async () => {
    const missingName = await createClient({ name: undefined });
    expect(missingName.response.status).toBe(400);
    const blankName = await createClient({ name: '   ' });
    expect(blankName.response.status).toBe(400);
    const missingEmail = await createClient({ contact_email: undefined });
    expect(missingEmail.response.status).toBe(400);
    const invalidEmail = await createClient({ contact_email: 'not-an-email' });
    expect(invalidEmail.response.status).toBe(400);
    const missing = await createClient({ source_id: 'missing-example' });
    expect(missing.response.status).toBe(409);
    expect(missing.json.error.code).toBe('source_unavailable');
    const archived = await createClient({ source_id: archivedSource });
    expect(archived.response.status).toBe(409);
    expect(archived.json.error.code).toBe('source_unavailable');
  });

  test('create saves contact/source/scope and exposes the secret only once', async () => {
    const created = await createClient({ scopes: ['write', 'read'] });
    expect(created.response.status).toBe(201);
    expect(created.json.data).toMatchObject({
      source_id: activeSource, client_name: 'Windows Admin Agent', contact_email: contactEmail,
      scope: 'read write', secret_shown_once: true,
    });
    expect(typeof created.json.data.client_secret).toBe('string');
    const row = await engine.executeRaw<any>(
      'SELECT client_name,contact_email,source_id,scope,client_secret_hash FROM oauth_clients WHERE client_id=$1',
      [created.json.data.client_id],
    );
    expect(row[0]).toMatchObject({ client_name: 'Windows Admin Agent', contact_email: contactEmail, source_id: activeSource, scope: 'read write' });
    expect(row[0].client_secret_hash).not.toBe(created.json.data.client_secret);

    const listed = await request('/oauth-clients');
    expect(listed.response.status).toBe(200);
    expect(Object.keys(listed.json.data[0])).not.toContain('client_secret');
    expect(JSON.stringify(listed.json)).not.toContain('client_secret_hash');
    expect(JSON.stringify(listed.json)).not.toContain(created.json.data.client_secret);
  });

  test('GET defaults to active and supports revoked/all plus source_id', async () => {
    const active = await createClient({ name: 'Active Example' });
    const revoked = await createClient({ name: 'Revoked Example' });
    await engine.executeRaw('UPDATE oauth_clients SET deleted_at=now() WHERE client_id=$1', [revoked.json.data.client_id]);
    const defaultList = await request('/oauth-clients');
    expect(defaultList.json.data.map((row: any) => row.client_id)).toEqual([active.json.data.client_id]);
    const revokedList = await request('/oauth-clients?status=revoked');
    expect(revokedList.json.data.map((row: any) => row.client_id)).toEqual([revoked.json.data.client_id]);
    const all = await request(`/oauth-clients?status=all&source_id=${activeSource}`);
    expect(new Set(all.json.data.map((row: any) => row.client_id))).toEqual(new Set([active.json.data.client_id, revoked.json.data.client_id]));
  });

  test('PATCH requires CSRF, updates scopes, preserves the secret hash, and revokes tokens/codes', async () => {
    const created = await createClient();
    const clientId = created.json.data.client_id;
    const before = await engine.executeRaw<{ client_secret_hash: string }>('SELECT client_secret_hash FROM oauth_clients WHERE client_id=$1', [clientId]);
    await engine.executeRaw("INSERT INTO oauth_tokens (token_hash,token_type,client_id,scopes,expires_at) VALUES ('hash-a','access',$1,ARRAY['read'],9999999999),('hash-b','refresh',$1,ARRAY['read'],9999999999)", [clientId]);
    await engine.executeRaw("INSERT INTO oauth_codes (code_hash,client_id,scopes,code_challenge,redirect_uri,expires_at) VALUES ('hash-c',$1,ARRAY['read'],'challenge','https://localhost/callback',9999999999)", [clientId]);

    const noCsrf = await request(`/oauth-clients/${clientId}`, { method: 'PATCH', csrf: false, body: { scopes: ['read'] } });
    expect(noCsrf.response.status).toBe(403);
    const patched = await request(`/oauth-clients/${clientId}`, { method: 'PATCH', body: { scopes: ['read'] } });
    expect(patched.response.status).toBe(200);
    expect(patched.json.data).toEqual({ client_id: clientId, scope: 'read', tokens_revoked: 2, codes_revoked: 1, updated: true });
    expect(JSON.stringify(patched.json)).not.toContain('secret');
    const after = await engine.executeRaw<any>('SELECT scope,client_secret_hash FROM oauth_clients WHERE client_id=$1', [clientId]);
    expect(after[0].scope).toBe('read');
    expect(after[0].client_secret_hash).toBe(before[0].client_secret_hash);
    expect((await engine.executeRaw<any>('SELECT 1 FROM oauth_tokens WHERE client_id=$1', [clientId]))).toHaveLength(0);
    expect((await engine.executeRaw<any>('SELECT 1 FROM oauth_codes WHERE client_id=$1', [clientId]))).toHaveLength(0);
  });

  test('PATCH rejects revoked, missing, empty, and non-admin-safe scopes', async () => {
    const created = await createClient();
    const clientId = created.json.data.client_id;
    await engine.executeRaw('UPDATE oauth_clients SET deleted_at=now() WHERE client_id=$1', [clientId]);
    const revoked = await request(`/oauth-clients/${clientId}`, { method: 'PATCH', body: { scopes: ['read'] } });
    expect(revoked.response.status).toBe(409);
    expect(revoked.json.error.code).toBe('oauth_client_revoked');
    const missing = await request('/oauth-clients/missing-client', { method: 'PATCH', body: { scopes: ['read'] } });
    expect(missing.response.status).toBe(404);
    expect(missing.json.error.code).toBe('oauth_client_not_found');
    for (const scopes of [undefined, [], ['admin'], ['sources_admin']]) {
      const invalid = await request(`/oauth-clients/${clientId}`, { method: 'PATCH', body: { scopes } });
      expect(invalid.response.status).toBe(400);
      expect(invalid.json.error.code).toBe('invalid_scopes');
    }
  });

  test('rotate preserves client metadata and scopes', async () => {
    const old = await provider.registerClientManual(
      'Rotate Example', ['client_credentials'], 'read', [], activeSource, [activeSource], 'client_secret_post', contactEmail,
    );
    await engine.executeRaw(
      "INSERT INTO oauth_tokens (token_hash,token_type,client_id,scopes,expires_at) VALUES ('rotate-token','access',$1,ARRAY['read'],9999999999)",
      [old.clientId],
    );
    await engine.executeRaw(
      "INSERT INTO oauth_codes (code_hash,client_id,scopes,code_challenge,redirect_uri,expires_at) VALUES ('rotate-code',$1,ARRAY['read'],'challenge','https://localhost/callback',9999999999)",
      [old.clientId],
    );
    const replacement = await rotateOAuthClient(engine, old.clientId);
    expect(replacement?.clientId).not.toBe(old.clientId);
    expect(replacement?.clientSecret).toStartWith('voltmind_cs_');
    expect((await engine.executeRaw<any>('SELECT 1 FROM oauth_tokens WHERE client_id=$1', [old.clientId]))).toHaveLength(0);
    expect((await engine.executeRaw<any>('SELECT 1 FROM oauth_codes WHERE client_id=$1', [old.clientId]))).toHaveLength(0);
    const row = await engine.executeRaw<any>(
      'SELECT client_name,contact_email,source_id,federated_read,grant_types,scope,token_endpoint_auth_method FROM oauth_clients WHERE client_id=$1',
      [replacement?.clientId],
    );
    expect(row[0]).toMatchObject({
      client_name: 'Rotate Example', contact_email: contactEmail, source_id: activeSource,
      federated_read: [activeSource], grant_types: ['client_credentials'], scope: 'read', token_endpoint_auth_method: 'client_secret_post',
    });
  });

  test('revoke clears tokens and pending authorization codes', async () => {
    const created = await createClient();
    const clientId = created.json.data.client_id;
    await engine.executeRaw(
      "INSERT INTO oauth_tokens (token_hash,token_type,client_id,scopes,expires_at) VALUES ('revoke-token','access',$1,ARRAY['read'],9999999999)",
      [clientId],
    );
    await engine.executeRaw(
      "INSERT INTO oauth_codes (code_hash,client_id,scopes,code_challenge,redirect_uri,expires_at) VALUES ('revoke-code',$1,ARRAY['read'],'challenge','https://localhost/callback',9999999999)",
      [clientId],
    );
    const revoked = await request(`/oauth-clients/${clientId}/revoke`, { method: 'POST' });
    expect(revoked.response.status).toBe(200);
    expect((await engine.executeRaw<any>('SELECT 1 FROM oauth_tokens WHERE client_id=$1', [clientId]))).toHaveLength(0);
    expect((await engine.executeRaw<any>('SELECT 1 FROM oauth_codes WHERE client_id=$1', [clientId]))).toHaveLength(0);
  });

  test('PATCH writes oauth_client.scope_update audit action', async () => {
    const created = await createClient();
    const clientId = created.json.data.client_id;
    const patched = await request(`/oauth-clients/${clientId}`, { method: 'PATCH', body: { scopes: ['read'] } });
    expect(patched.response.status).toBe(200);
    let rows: any[] = [];
    for (let attempt = 0; attempt < 20 && rows.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      rows = await engine.executeRaw<any>("SELECT action,client_id,source_id FROM admin_audit_log WHERE action='oauth_client.scope_update'");
    }
    expect(rows).toEqual([{ action: 'oauth_client.scope_update', client_id: clientId, source_id: activeSource }]);
  });

  test('OpenAPI exposes filters, contact email, create/PATCH contracts, and Cookie+CSRF security', () => {
    const spec = adminV1OpenApi() as any;
    expect(spec.paths['/sources']).toBeDefined();
    expect(spec.paths['/sources/{sourceId}/cycles']).toBeDefined();
    expect(spec.paths['/audit']).toBeDefined();
    expect(spec.paths['/autopilot']).toBeDefined();
    expect(spec.paths['/cycle-profiles']).toBeDefined();
    expect(spec.paths['/jobs/{jobId}']).toBeDefined();
    expect(spec.paths['/sources'].post.security).toEqual([{ adminCookie: [], csrfToken: [] }]);
    expect(spec.paths['/oauth-clients'].get.parameters.map((p: any) => p.name)).toEqual(['source_id', 'status']);
    expect(spec.paths['/oauth-clients'].post.requestBody.required).toBe(true);
    expect(spec.paths['/oauth-clients/{clientId}'].patch.security).toEqual([{ adminCookie: [], csrfToken: [] }]);
    expect(spec.components.schemas.OAuthClient.properties.contact_email.format).toBe('email');
    expect(spec.components.schemas.OAuthClientCreateRequest.required).toEqual(['name', 'contact_email', 'source_id', 'scopes']);
    expect(spec.components.schemas.OAuthClientCreateResult.properties.client_secret.writeOnly).toBe(true);
    expect(spec.security).toEqual([{ adminCookie: [] }]);
    expect(JSON.stringify(spec)).not.toContain('client_secret_hash');
    const docs = readFileSync('docs/admin/openapi-v1.yaml', 'utf8');
    expect(docs).toContain('/oauth-clients/{clientId}:');
    expect(docs).toContain('contact_email');
    expect(docs).toContain('X-VoltMind-CSRF');
    expect(docs).not.toContain('client_secret_hash');
  });
});

/**
 * v0.42 #6 + #7 regression tests.
 *
 * #6 — RLS source-isolation policies now exist (previously only
 * `ENABLE ROW LEVEL SECURITY` with zero `CREATE POLICY`). The policies are
 * Postgres-only (PGLite has no RLS engine), so on PGLite we assert the
 * schema-level preconditions: the source_id columns exist on access_tokens
 * (mcp_request_log already had it) and the v112 migration's PGLite branch
 * is a no-op that still bumps the schema version. We also assert
 * `setSourceScope` validates source ids and otherwise no-ops on PGLite.
 *
 * #7 — legacy bearer tokens now carry an explicit scope set. `auth create`
 * no longer mints unconditional admin tokens; the default is read+write.
 * verifyAccessToken reads the persisted `scopes` column instead of
 * hardcoding ['read','write','admin']. The companion oauth.test.ts covers
 * the verify path; here we assert the migration + schema defaults so the
 * "unconditional admin" hole can't silently regress.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS as MIGRATIONS_REAL, LATEST_VERSION as LATEST_REAL } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('v0.42 #6 — RLS source-isolation policies (schema + migration)', () => {
  test('migrate.ts ships v112 (rls_source_isolation_policies)', () => {
    const v112 = MIGRATIONS_REAL.find((m) => m.version === 112);
    expect(v112).toBeDefined();
    expect(v112!.name).toBe('rls_source_isolation_policies');
    // Postgres branch creates the 5 policies; PGLite branch is a no-op
    // (no RLS engine) that still lands access_tokens.source_id.
    expect(v112!.sqlFor?.postgres).toBeTruthy();
    expect(v112!.sqlFor?.postgres).toContain('CREATE POLICY pages_source_isolation');
    expect(v112!.sqlFor?.postgres).toContain('CREATE POLICY content_chunks_source_isolation');
    expect(v112!.sqlFor?.postgres).toContain('CREATE POLICY files_source_isolation');
    expect(v112!.sqlFor?.postgres).toContain('CREATE POLICY access_tokens_source_isolation');
    expect(v112!.sqlFor?.postgres).toContain('CREATE POLICY mcp_request_log_source_isolation');
    // Every policy gates on the session GUC, fail-closed when unset.
    expect(v112!.sqlFor?.postgres).toContain("current_setting('app.source_id', true)");
  });

  test('LATEST_VERSION >= 113 (v112 + v113 landed)', () => {
    expect(LATEST_REAL).toBeGreaterThanOrEqual(113);
  });

  test('migrate.ts ships v124 federated-read RLS with scalar write checks', () => {
    const v124 = MIGRATIONS_REAL.find((m) => m.version === 124);
    expect(v124).toBeDefined();
    expect(v124!.name).toBe('rls_federated_read_scope');
    expect(v124!.sql).toContain("current_setting('app.source_ids', true)");
    for (const table of [
      'pages', 'content_chunks', 'files', 'access_tokens',
      'mcp_request_log', 'external_file_refs',
      'page_external_file_refs', 'ingestion_event_state',
    ]) {
      expect(v124!.sql).toContain(`CREATE POLICY ${table}_source_read ON ${table}`);
      expect(v124!.sql).toContain(`CREATE POLICY ${table}_source_insert ON ${table}`);
      expect(v124!.sql).toContain(`CREATE POLICY ${table}_source_update ON ${table}`);
      expect(v124!.sql).toContain(`CREATE POLICY ${table}_source_delete ON ${table}`);
    }
    expect(v124!.sql).not.toContain('CREATE POLICY pages_source_isolation');
    expect(v124!.sql).toContain('FOR SELECT');
    expect(v124!.sql).toContain('FOR INSERT');
    expect(v124!.sql).toContain('FOR UPDATE');
    expect(v124!.sql).toContain('FOR DELETE');
    expect(v124!.sql).toContain("WITH CHECK (source_id = current_setting('app.source_id', true))");
    expect(v124!.sqlFor?.pglite).toBe('');
  });

  test('access_tokens.source_id column exists (PGLite parity)', async () => {
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'access_tokens' AND column_name = 'source_id'`,
    );
    expect(cols.length).toBe(1);
  });

  test('schema.sql fresh-install RLS block installs scoped read/write policies (Postgres source)', async () => {
    // Read the canonical schema source and assert the policy CREATE
    // statements are present for every reviewed table. This pins the
    // "RLS is decorative" regression: if a future edit drops the policies
    // back to bare ENABLE statements, this fails.
    const { readFileSync } = await import('fs');
    const schema = readFileSync('src/schema.sql', 'utf8');
    for (const table of [
      'pages', 'content_chunks', 'files', 'access_tokens',
      'mcp_request_log', 'external_file_refs',
      'page_external_file_refs', 'ingestion_event_state',
    ]) {
      for (const command of ['read', 'insert', 'update', 'delete']) {
        expect(schema).toContain(`CREATE POLICY ${table}_source_${command} ON ${table}`);
        expect(schema).toContain(`DROP POLICY IF EXISTS ${table}_source_${command} ON ${table}`);
      }
    }
    expect(schema).not.toContain('CREATE POLICY pages_source_isolation');
    expect(schema).toContain("current_setting('app.source_id', true)");
  });

  test('setSourceScope accepts valid ids and otherwise no-ops on PGLite', async () => {
    // PGLite has no RLS engine, but the method must exist + not throw so
    // dispatch code can call it unconditionally without branching.
    await expect(engine.setSourceScope('default')).resolves.toBeUndefined();
    await expect(engine.setSourceScope('any-source')).resolves.toBeUndefined();
  });

  test('setSourceScope inside a transaction is a no-op too (PGLite)', async () => {
    await engine.transaction(async (tx) => {
      await expect(tx.setSourceScope('default')).resolves.toBeUndefined();
    });
  });

  test('setSourceScope rejects invalid source ids on PGLite just like Postgres', async () => {
    await expect(engine.setSourceScope('../escape')).rejects.toThrow('Invalid source_id');
  });

  test('setSourceReadScope validates federated ids and is a no-op on PGLite', async () => {
    await expect(engine.setSourceReadScope?.(['default', 'any-source'])).resolves.toBeUndefined();
    await expect(engine.setSourceReadScope?.(['../escape'])).rejects.toThrow('Invalid source_id');
  });
});

describe('v0.42 #7 — legacy token scopes default + migration', () => {
  test('migrate.ts ships v113 (access_tokens_scopes_default)', () => {
    const v113 = MIGRATIONS_REAL.find((m) => m.version === 113);
    expect(v113).toBeDefined();
    expect(v113!.name).toBe('access_tokens_scopes_default');
    // Backfills existing NULL rows to admin (preserve behavior) and sets
    // the column DEFAULT + NOT NULL so new inserts are read+write.
    expect(v113!.sql).toContain("ARRAY['read','write','admin']");
    expect(v113!.sql).toContain("SET DEFAULT '{\"read\",\"write\"}'");
    expect(v113!.sql).toContain("SET NOT NULL");
  });

  test('access_tokens.scopes column is NOT NULL with read+write default (PGLite)', async () => {
    // Insert WITHOUT explicit scopes → gets the column default read+write,
    // NOT admin. This is the closed hole: a fresh legacy token is no longer
    // unconditional admin.
    await engine.executeRaw(
      `INSERT INTO access_tokens (id, name, token_hash)
       VALUES ($1, $2, $3)`,
      ['00000000-0000-0000-0000-000000000042', 'rw-default-probe', 'hash-rw-probe'],
    );
    const rows = await engine.executeRaw<{ scopes: string[] }>(
      `SELECT scopes FROM access_tokens WHERE name = $1`,
      ['rw-default-probe'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.scopes).toEqual(['read', 'write']);
  });

  test('auth create INSERT shape (pgArray + ::text[]) round-trips scopes', async () => {
    // Mirrors the exact INSERT `create()` in src/commands/auth.ts builds:
    // executeRawJsonb(..., [name, hash, pgArray(scopes)], [permissions]) with
    // `$3::text[]` cast. Asserts the array survives the positional binding
    // (the bug class would be a single-element string or a Postgres
    // array-parse error). Uses the same executeRawJsonb helper create() does.
    const { executeRawJsonb } = await import('../src/core/sql-query.ts');
    const { pgArray } = await import('../src/core/oauth-provider.ts');
    const scopes = ['read', 'write', 'admin'];
    await executeRawJsonb(
      engine,
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions)
       VALUES ($1, $2, $3::text[], $4::jsonb)`,
      ['admin-roundtrip-probe', 'hash-admin-roundtrip', pgArray(scopes)],
      [{ takes_holders: ['world'] }],
    );
    const rows = await engine.executeRaw<{ scopes: string[] }>(
      `SELECT scopes FROM access_tokens WHERE name = $1`,
      ['admin-roundtrip-probe'],
    );
    expect(rows[0]!.scopes).toEqual(['read', 'write', 'admin']);
  });
});

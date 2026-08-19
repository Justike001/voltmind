import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from "express";
import type { Server } from "node:http";
import { createAdminV1Router } from "../../src/commands/admin-v1.ts";
import { VoltMindOAuthProvider } from "../../src/core/oauth-provider.ts";
import { sqlQueryForEngine } from "../../src/core/sql-query.ts";
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from "../../src/mcp/dispatch.ts";

const restrictedUrl = process.env.VOLTMIND_RESTRICTED_DATABASE_URL;
const setupUrl = process.env.VOLTMIND_RLS_SETUP_DATABASE_URL || process.env.DATABASE_URL;
const restrictedPassword = process.env.VOLTMIND_RLS_RESTRICTED_PASSWORD || 'restricted';
const run = restrictedUrl && setupUrl ? describe : describe.skip;
let engine: PostgresEngine;
let setupEngine: PostgresEngine;
let setupCanManageRoles = false;
let restrictedRoleCreatedByTest = false;
const suffix = String(process.pid) + '-' + String(Date.now());
const slug = 'test/restricted-scope-' + suffix;
const sourceA = 'scope-a-' + suffix;
const sourceB = 'scope-b-' + suffix;
let pageIdA = 0;
let pageIdB = 0;
let takeIdA = 0;
let takeIdB = 0;
let adminServer: Server;
let adminBaseUrl = "";

run('restricted Postgres source scope (VOLTMIND_RESTRICTED_DATABASE_URL)', () => {
  beforeAll(async () => {
    // RLS intentionally denies creating a new source with no scope. Seed the
    // fixture through the privileged schema/setup connection, then exercise
    // every read through the non-BYPASSRLS application role.
    setupEngine = new PostgresEngine();
    await setupEngine.connect({ database_url: setupUrl!, poolSize: 1 });
    const setupRole = await setupEngine.executeRaw<{ rolcreaterole: boolean }>(
      'SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user',
    );
    setupCanManageRoles = setupRole[0]?.rolcreaterole === true;
    if (setupCanManageRoles) {
      await setupEngine.initSchema();
    }
    if (setupCanManageRoles) {
      const restrictedRole = await setupEngine.executeRaw<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltmind_restricted') AS exists",
      );
      restrictedRoleCreatedByTest = restrictedRole[0]?.exists !== true;
      const quotedPassword = restrictedPassword.replaceAll("'", "''");
      await setupEngine.executeRaw(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltmind_restricted') THEN CREATE ROLE voltmind_restricted LOGIN PASSWORD '${quotedPassword}' NOSUPERUSER NOBYPASSRLS; ELSE ALTER ROLE voltmind_restricted LOGIN PASSWORD '${quotedPassword}' NOSUPERUSER NOBYPASSRLS; END IF; END $$;`,
      );
      if (restrictedRoleCreatedByTest) {
        await setupEngine.executeRaw('GRANT EXECUTE ON FUNCTION public.voltmind_admin_source_ids() TO voltmind_restricted');
      }
    } else {
      const restrictedRole = await setupEngine.executeRaw<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        "SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'voltmind_restricted'",
      );
      expect(restrictedRole).toHaveLength(1);
      expect(restrictedRole[0]?.rolcanlogin).toBe(true);
      expect(restrictedRole[0]?.rolsuper).toBe(false);
      expect(restrictedRole[0]?.rolbypassrls).toBe(false);
    }
    await setupEngine.executeRaw('GRANT USAGE ON SCHEMA public TO voltmind_restricted');
    await setupEngine.executeRaw('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voltmind_restricted');
    await setupEngine.executeRaw('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO voltmind_restricted');
    await setupEngine.executeRaw('REVOKE EXECUTE ON FUNCTION public.voltmind_admin_source_ids() FROM PUBLIC');
    await setupEngine.executeRaw('GRANT EXECUTE ON FUNCTION public.voltmind_admin_source_ids() TO voltmind_restricted');
    const helperPrivileges = await setupEngine.executeRaw<{ public_execute: boolean; restricted_execute: boolean }>(
      `SELECT has_function_privilege('public', 'public.voltmind_admin_source_ids()', 'EXECUTE') AS public_execute,
              has_function_privilege('voltmind_restricted', 'public.voltmind_admin_source_ids()', 'EXECUTE') AS restricted_execute`,
    );
    expect(helperPrivileges[0]?.public_execute).toBe(false);
    expect(helperPrivileges[0]?.restricted_execute).toBe(true);
    for (const sourceId of [sourceA, sourceB]) {
      await setupEngine.transaction(async (tx) => {
        await tx.setSourceScope(sourceId);
        await tx.executeRaw(
          "INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)",
          [sourceId],
        );
      });
    }
    await setupEngine.transaction(async (tx) => {
      for (const sourceId of [sourceA, sourceB]) {
        await tx.setSourceScope(sourceId);
        await tx.putPage(slug, {
          type: 'note',
          title: sourceId,
          compiled_truth: 'content-' + sourceId,
        }, { sourceId });
      }
      await tx.setSourceReadScope([sourceA, sourceB]);
      const pageA = (await tx.executeRaw<{ id: number }>(
        'SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceA, slug]
      ))[0];
      const pageB = (await tx.executeRaw<{ id: number }>(
        'SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceB, slug]
      ))[0];
      pageIdA = Number(pageA?.id);
      pageIdB = Number(pageB?.id);
      await tx.setSourceScope(sourceA);
      await tx.executeRaw(
        "INSERT INTO takes (page_id, row_num, claim, kind, holder, weight) VALUES ($1, 1, $2, 'bet', 'world', 0.8)",
        [pageIdA, 'take-' + sourceA],
      );
      const takeA = (await tx.executeRaw<{ id: number }>(
        'SELECT id FROM takes WHERE page_id=$1', [pageIdA]
      ))[0];
      takeIdA = Number(takeA?.id);
      await tx.executeRaw(
        "INSERT INTO take_domain_assignments (take_id, domain, pack) VALUES ($1, 'scope-test', 'scope-pack')",
        [takeIdA],
      );
      await tx.executeRaw(
        "UPDATE takes SET resolved_quality = 'correct', resolved_at = now() WHERE id = $1",
        [takeIdA],
      );
      await tx.setSourceScope(sourceB);
      await tx.executeRaw(
        "INSERT INTO takes (page_id, row_num, claim, kind, holder, weight) VALUES ($1, 1, $2, 'bet', 'world', 0.8)",
        [pageIdB, 'take-' + sourceB],
      );
      const takeB = (await tx.executeRaw<{ id: number }>(
        'SELECT id FROM takes WHERE page_id=$1', [pageIdB]
      ))[0];
      takeIdB = Number(takeB?.id);
      await tx.executeRaw(
        "INSERT INTO take_domain_assignments (take_id, domain, pack) VALUES ($1, 'scope-test', 'scope-pack')",
        [takeIdB],
      );
      await tx.executeRaw(
        "UPDATE takes SET resolved_quality = 'correct', resolved_at = now() WHERE id = $1",
        [takeIdB],
      );
    });
    const policyRows = await setupEngine.executeRaw<{ relname: string; relforcerowsecurity: boolean; has_policy: boolean }>(`
      SELECT c.relname, c.relforcerowsecurity,
             EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS has_policy
        FROM pg_class c
       WHERE c.relname IN ('pages', 'takes', 'take_domain_assignments', 'file_migration_ledger', 'admin_audit_log')
       ORDER BY c.relname
    `);
    expect(policyRows).toHaveLength(5);
    expect(policyRows.every(row => row.relforcerowsecurity && row.has_policy)).toBe(true);

    const completedRlsRows = await setupEngine.executeRaw<{ relname: string; relforcerowsecurity: boolean; policy_count: number }>(`
      SELECT c.relname, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
        FROM pg_class c
       WHERE c.relname IN (
         'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions',
         'ingest_log', 'minion_jobs', 'query_cache', 'facts',
         'code_edges_chunk', 'code_edges_symbol', 'migration_impact_log',
         'action_index', 'action_runs',
         'project_tracking_receipts', 'project_tracking_receipt_history',
         'synthesis_evidence'
       )
       ORDER BY c.relname
    `);
    expect(completedRlsRows).toHaveLength(17);
    expect(completedRlsRows.every(row => row.relforcerowsecurity && row.policy_count >= 4)).toBe(true);

    engine = new PostgresEngine();
    await engine.connect({ database_url: restrictedUrl!, poolSize: 1 });
    const roles = await engine.executeRaw<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(roles[0]?.rolbypassrls).toBe(false);
    expect(roles[0]?.rolsuper).toBe(false);
    const app = express();
    const adminSession = { sessionId: "restricted-admin-session", csrfToken: "restricted-admin-csrf", expiresAt: Date.now() + 60000 };
    app.use("/admin/api/v1", createAdminV1Router({
      engine,
      sql: sqlQueryForEngine(engine),
      oauthProvider: new VoltMindOAuthProvider({ sql: sqlQueryForEngine(engine) }),
      adminOrigin: "https://admin.example.test",
      getSession: req => req.headers.cookie?.includes("voltmind_admin=restricted-session") ? adminSession : null,
    }));
    adminServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { adminServer.once("listening", resolve); adminServer.once("error", reject); });
    const address = adminServer.address();
    if (!address || typeof address === "string") throw new Error("restricted Admin server did not bind");
    adminBaseUrl = "http://127.0.0.1:" + address.port + "/admin/api/v1";
  });

  afterAll(async () => {
    if (adminServer) await new Promise<void>(resolve => adminServer.close(() => resolve()));
    if (engine) await engine.disconnect();
    if (!setupEngine) return;
    for (const sourceId of [sourceA, sourceB]) {
      await setupEngine.transaction(async (tx) => {
        await tx.setSourceScope(sourceId);
        await tx.deletePage(slug, { sourceId });
        await tx.executeRaw('DELETE FROM sources WHERE id = $1', [sourceId]);
      });
    }
    if (setupCanManageRoles) {
      await setupEngine.executeRaw('DROP OWNED BY voltmind_restricted');
      await setupEngine.executeRaw('DROP ROLE IF EXISTS voltmind_restricted');
    }
    await setupEngine.disconnect();
  });

  test('positive and negative isolation match the scoped source', async () => {
    await engine.transaction(async (tx) => {
      await tx.setSourceScope(sourceA);
      expect((await tx.getPage(slug, { sourceId: sourceA }))?.title).toBe(sourceA);
      expect(await tx.getPage(slug, { sourceId: sourceB })).toBeNull();
    });
    await engine.transaction(async (tx) => {
      await tx.setSourceScope(sourceB);
      expect((await tx.getPage(slug, { sourceId: sourceB }))?.title).toBe(sourceB);
      expect(await tx.getPage(slug, { sourceId: sourceA })).toBeNull();
    });
  });

  test('missing transaction-local scope fails closed and does not leak across pooled requests', async () => {
    const rows = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM pages WHERE slug = $1',
      [slug],
    );
    expect(rows[0]?.count).toBe(0);
  });

  test('federated read returns only the explicitly allowed source set', async () => {
    await engine.transaction(async (tx) => {
      await tx.setSourceReadScope([sourceA, sourceB]);
      expect((await tx.getPage(slug, { sourceId: sourceA }))?.title).toBe(sourceA);
      expect((await tx.getPage(slug, { sourceId: sourceB }))?.title).toBe(sourceB);
    });
    await engine.transaction(async (tx) => {
      await tx.setSourceReadScope([sourceA]);
      expect((await tx.getPage(slug, { sourceId: sourceA }))?.title).toBe(sourceA);
      expect(await tx.getPage(slug, { sourceId: sourceB })).toBeNull();
    });
  });

  test("takes, scorecard, and calibration honor source scope through MCP dispatch", async () => {
    const auth = (allowedSources?: string[]) => ({
      token: "voltmind_at_restricted", clientId: "voltmind_cl_restricted", clientName: "restricted",
      scopes: ["read"], expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...(allowedSources ? { allowedSources } : {}),
    });
    const dispatch = (name: string, params: Record<string, unknown>, allowedSources?: string[]) =>
      dispatchToolCall(engine, name, params, { remote: true, sourceId: sourceA, auth: auth(allowedSources) });
    const listA = await dispatch("takes_list", { active: true });
    const rowsA = JSON.parse(listA.content[0]!.text) as Array<{ source_id: string; provenance?: { source_id?: string } }>;
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.source_id).toBe(sourceA);
    expect(rowsA[0]?.provenance?.source_id).toBe(sourceA);
    const searchA = await dispatch("takes_search", { query: "take-" + sourceA });
    const hitsA = JSON.parse(searchA.content[0]!.text) as Array<{ source_id: string }>;
    expect(hitsA.every(hit => hit.source_id === sourceA)).toBe(true);
    const scoreA = await dispatch("takes_scorecard", {});
    expect(JSON.parse(scoreA.content[0]!.text).total_bets).toBe(1);
    const curveA = await dispatch("takes_calibration", {});
    expect(JSON.parse(curveA.content[0]!.text).reduce((sum: number, bucket: { n: number }) => sum + bucket.n, 0)).toBe(1);
    const federated = await dispatch("takes_scorecard", {}, [sourceA, sourceB]);
    expect(JSON.parse(federated.content[0]!.text).total_bets).toBe(2);
  });

  test("sources_status enforces source scope through MCP dispatch", async () => {
    const auth = (allowedSources?: string[]) => ({
      token: "voltmind_at_restricted", clientId: "voltmind_cl_restricted", clientName: "restricted",
      scopes: ["read"], expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...(allowedSources ? { allowedSources } : {}),
    });
    const denied = await dispatchToolCall(engine, "sources_status", { id: sourceB }, {
      remote: true, sourceId: sourceA, auth: auth(),
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]!.text).error).toBe("permission_denied");
    const missing = await dispatchToolCall(engine, "sources_status", { id: "missing-status-source" }, {
      remote: true, sourceId: sourceA, auth: auth(),
    });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0]!.text).error).toBe("permission_denied");
    const federated = await dispatchToolCall(engine, "sources_status", { id: sourceB }, {
      remote: true, sourceId: sourceA, auth: auth([sourceA, sourceB]),
    });
    expect(federated.isError).not.toBe(true);
    const status = JSON.parse(federated.content[0]!.text);
    expect(status.id).toBe(sourceB);
    expect(status.local_path).toBeNull();
    expect(status.remote_url).toBeNull();
  });

  test("Admin v1 source listing works through the restricted role", async () => {
    const response = await fetch(adminBaseUrl + "/sources", { headers: { Cookie: "voltmind_admin=restricted-session" } });
    const body = await response.json() as { data?: Array<{ id: string }> };
    expect(response.status).toBe(200);
    const ids = body.data?.map(row => row.id) ?? [];
    expect(ids).toContain(sourceA);
    expect(ids).toContain(sourceB);
  });

  test('authenticated Admin scope enumerates sources but still relies on ordinary RLS', async () => {
    await engine.transaction(async (tx) => {
      await tx.setAdminSourceScope();
      const sourceRows = await tx.executeRaw<{ id: string }>(
        'SELECT id FROM sources WHERE id IN ($1, $2) ORDER BY id', [sourceA, sourceB],
      );
      expect(sourceRows.map(row => row.id)).toEqual([sourceA, sourceB].sort());
      const pageRows = await tx.executeRaw<{ count: number }>(
        'SELECT count(*)::int AS count FROM pages WHERE source_id IN ($1, $2)', [sourceA, sourceB],
      );
      expect(Number(pageRows[0]?.count ?? 0)).toBe(2);
    });
  });

  test('take-owned rows and domain assignments inherit source RLS', async () => {
    const countFor = async (tx: BrainEngine, table: 'takes' | 'take_domain_assignments', id: number) => {
      const rows = await tx.executeRaw<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE ${table === 'takes' ? 'page_id' : 'take_id'}=$1`, [id]);
      return Number(rows[0]?.count ?? 0);
    };
    await engine.transaction(async (tx) => {
      await tx.setSourceScope(sourceA);
      expect(await countFor(tx, 'takes', pageIdA)).toBe(1);
      expect(await countFor(tx, 'takes', pageIdB)).toBe(0);
      expect(await countFor(tx, 'take_domain_assignments', takeIdA)).toBe(1);
      expect(await countFor(tx, 'take_domain_assignments', takeIdB)).toBe(0);
    });
    await engine.transaction(async (tx) => {
      await tx.setSourceScope(sourceB);
      expect(await countFor(tx, 'takes', pageIdA)).toBe(0);
      expect(await countFor(tx, 'takes', pageIdB)).toBe(1);
      expect(await countFor(tx, 'take_domain_assignments', takeIdA)).toBe(0);
      expect(await countFor(tx, 'take_domain_assignments', takeIdB)).toBe(1);
    });
    const unscopedTakes = await engine.executeRaw<{ count: number }>(
      'SELECT count(*)::int AS count FROM takes WHERE page_id IN ($1, $2)', [pageIdA, pageIdB],
    );
    expect(Number(unscopedTakes[0]?.count ?? 0)).toBe(0);
  });
});

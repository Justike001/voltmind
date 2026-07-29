/**
 * v0.41.x stdio MCP hardening regression tests (security-review fixes #1 + #2).
 *
 * Fix #1 — stdio MCP now enforces `op.scope`. Pre-fix the stdio path
 * (server.ts → dispatchToolCall with `stdio: true`) exposed every
 * non-localOnly op to any local stdio client, including 40+ admin-scope
 * ops (submit_job, action_run, schema_apply_mutations, get_ingest_log,
 * get_recent_transcripts, …) because stdio has no OAuth token to gate on
 * and dispatch never checked `op.scope`. The HTTP path enforced scope via
 * `hasScope(authInfo.scopes, …)`; stdio did not. Now dispatch gates the
 * stdio path against the configurable stdio default scope set (read+write;
 * admin/sources_admin/users_admin/agent denied by default).
 *
 * Fix #2 — stdio MCP now writes one `mcp_request_log` row per tool call
 * (success + every error path) with `token_name = NULL`, `agent_name =
 * 'stdio'`. Pre-fix stdio had ZERO audit coverage (only the HTTP transport
 * wrote mcp_request_log).
 *
 * These tests use a PGLite engine so the audit row lands in a real
 * `mcp_request_log` table and we can assert its shape. The scope gate is
 * asserted via dispatchToolCall directly with `stdio: true`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall, resolveStdioScopes } from '../src/mcp/dispatch.ts';
import { STDIO_DEFAULT_SCOPES } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Read mcp_request_log rows (newest first). */
async function auditRows(): Promise<Record<string, unknown>[]> {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT token_name, agent_name, operation, status, error_message
       FROM mcp_request_log
      ORDER BY id DESC`,
    [],
  );
}

/** Parse the JSON envelope out of a ToolResult's content text. */
function envelope(result: Awaited<ReturnType<typeof dispatchToolCall>>): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text);
}

describe('stdio default scope set', () => {
  test('default is read+write (admin denied)', () => {
    expect([...STDIO_DEFAULT_SCOPES]).toEqual(['read', 'write']);
  });

  test('resolveStdioScopes honors VOLTMIND_MCP_STDIO_SCOPES override', () => {
    const prev = process.env.VOLTMIND_MCP_STDIO_SCOPES;
    try {
      process.env.VOLTMIND_MCP_STDIO_SCOPES = 'read write admin';
      expect(resolveStdioScopes()).toEqual(['read', 'write', 'admin']);
    } finally {
      if (prev === undefined) delete process.env.VOLTMIND_MCP_STDIO_SCOPES;
      else process.env.VOLTMIND_MCP_STDIO_SCOPES = prev;
    }
  });

  test('resolveStdioScopes falls back to default on garbage input', () => {
    const prev = process.env.VOLTMIND_MCP_STDIO_SCOPES;
    try {
      process.env.VOLTMIND_MCP_STDIO_SCOPES = '   ';
      expect(resolveStdioScopes()).toEqual(['read', 'write']);
    } finally {
      if (prev === undefined) delete process.env.VOLTMIND_MCP_STDIO_SCOPES;
      else process.env.VOLTMIND_MCP_STDIO_SCOPES = prev;
    }
  });
});

describe('dispatchToolCall stdio scope enforcement (fix #1)', () => {
  test('admin-scope op is DENIED on the stdio path with insufficient_scope', async () => {
    // get_stats is scope:'admin', not localOnly — pre-fix it was callable
    // over stdio MCP with no auth at all.
    const result = await dispatchToolCall(engine, 'get_stats', {}, { stdio: true });
    expect(result.isError).toBe(true);
    const env = envelope(result);
    expect(env.error).toBe('insufficient_scope');
    expect(String(env.message)).toContain("requires 'admin'");
    expect(env.your_scopes).toEqual(['read', 'write']);
  });

  test('read-scope op is ALLOWED on the stdio path', async () => {
    // search is scope:'read'. With default read+write it must pass.
    const result = await dispatchToolCall(
      engine,
      'search',
      { query: 'alice' },
      { stdio: true },
    );
    expect(result.isError).toBeUndefined();
  });

  test('admin op is ALLOWED when VOLTMIND_MCP_STDIO_SCOPES grants admin', async () => {
    const prev = process.env.VOLTMIND_MCP_STDIO_SCOPES;
    try {
      process.env.VOLTMIND_MCP_STDIO_SCOPES = 'read write admin';
      const result = await dispatchToolCall(engine, 'get_stats', {}, { stdio: true });
      // No insufficient_scope — get_stats handler runs (may return empty
      // stats on an empty brain, but it must NOT be a scope rejection).
      expect(result.isError).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.VOLTMIND_MCP_STDIO_SCOPES;
      else process.env.VOLTMIND_MCP_STDIO_SCOPES = prev;
    }
  });

  test('non-stdio dispatch is NOT scope-gated (legacy/http paths unchanged)', async () => {
    // Without stdio:true, dispatch must NOT enforce the stdio default scope.
    // This preserves serve-http (which gates via opts.auth itself) and the
    // legacy http-transport / local-daemon behavior. get_stats must reach
    // its handler, not be rejected by dispatch.
    const result = await dispatchToolCall(engine, 'get_stats', {}, {});
    expect(result.isError).toBeUndefined();
  });
});

describe('dispatchToolCall stdio audit log (fix #2)', () => {
  test('SUCCESS writes a row: token_name NULL, agent_name "stdio", status success', async () => {
    await dispatchToolCall(engine, 'search', { query: 'bob' }, { stdio: true });
    const rows = await auditRows();
    expect(rows.length).toBeGreaterThan(0);
    const r = rows[0]!;
    expect(r.operation).toBe('search');
    expect(r.status).toBe('success');
    expect(r.token_name).toBeNull();
    expect(r.agent_name).toBe('stdio');
    expect(r.error_message).toBeNull();
  });

  test('INSUFFICIENT_SCOPE writes an error row naming the required scope', async () => {
    await dispatchToolCall(engine, 'get_stats', {}, { stdio: true });
    const rows = await auditRows();
    expect(rows.length).toBeGreaterThan(0);
    const r = rows[0]!;
    expect(r.operation).toBe('get_stats');
    expect(r.status).toBe('error');
    expect(r.agent_name).toBe('stdio');
    expect(String(r.error_message)).toContain("insufficient_scope");
    expect(String(r.error_message)).toContain("admin");
  });

  test('UNKNOWN_TOOL writes an error row', async () => {
    await dispatchToolCall(engine, 'this_op_does_not_exist', {}, { stdio: true });
    const rows = await auditRows();
    const r = rows[0]!;
    expect(r.operation).toBe('this_op_does_not_exist');
    expect(r.status).toBe('error');
    expect(String(r.error_message)).toContain('unknown_tool');
  });

  test('non-stdio dispatch does NOT write a stdio audit row (no double-log)', async () => {
    // serve-http owns its own audit; dispatch must not also write when the
    // caller is not the stdio path. Run a non-stdio call, then assert the
    // newest row is NOT from this call (agent_name should not be 'stdio'
    // for a fresh non-stdio invocation — and on a freshly-reset brain there
    // should be no row at all for this op).
    await resetPgliteState(engine);
    await dispatchToolCall(engine, 'search', { query: 'carol' }, {});
    const rows = await auditRows();
    // No stdio row should have been written by the non-stdio call.
    expect(rows.length).toBe(0);
  });
});

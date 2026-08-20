/**
 * E2E test for thin-client mode (multi-topology v1).
 *
 * Spins up `voltmind serve --http` against a real Postgres, registers a
 * ordinary client with `read,write` scope, runs `voltmind init --mcp-only`
 * against it from a second tempdir HOME, and exercises the canonical
 * thin-client flows:
 *
 *   - `voltmind init --mcp-only` succeeds and writes remote_mcp config
 *   - `voltmind doctor` reports `mode: thin-client` with all checks green
 *   - `voltmind sync` is refused with the canonical thin-client error
 *   - re-running `voltmind init` refuses without --force
 *
 * Tier B flows (`voltmind remote ping` / `remote doctor`) are stubbed for now
 * and will be exercised when the Tier B commands ship.
 *
 * Skips when DATABASE_URL is unset (matches the e2e gate convention used
 * across the suite).
 */

import { describe, test as testRaw, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { setupDB, teardownDB, provisionHttpRuntimeDatabaseUrl } from './helpers.ts';
function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 120000);
}

const CLI = join(__dirname, '..', '..', 'src', 'cli.ts');
const DATABASE_URL = process.env.DATABASE_URL;

interface RunResult { exitCode: number; stdout: string; stderr: string; }

async function spawn(args: string[], home: string, extraEnv: Record<string, string | undefined> = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.VOLTMIND_HOME = home;
  delete env.VOLTMIND_REMOTE_CLIENT_SECRET;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn({
    cmd: ['bun', 'run', CLI, ...args],
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// Skip the entire suite when DATABASE_URL is unset. Same pattern as other
// E2E tests in this directory.
const describeWhen = DATABASE_URL ? describe : describe.skip;

describeWhen('thin-client end-to-end (requires DATABASE_URL)', () => {
  let hostHome: string;          // VOLTMIND_HOME for the host (with local engine)
  let clientHome: string;        // VOLTMIND_HOME for the thin client (no engine)
  let serverProc: ReturnType<typeof Bun.spawn> | null = null;
  let serverPort: number;
  let clientId: string;
  let runtimeDatabaseUrl: string;
  let clientSecret: string;

  beforeAll(async () => {
    await setupDB();
    runtimeDatabaseUrl = await provisionHttpRuntimeDatabaseUrl();
    hostHome = mkdtempSync(join(tmpdir(), 'voltmind-thin-host-'));
    clientHome = mkdtempSync(join(tmpdir(), 'voltmind-thin-client-'));

    // 1. Init host with a real Postgres. `--no-embedding` defers embedding
    //    setup (v0.37.10.0+ requires an explicit embedding provider OR the
    //    deferral flag); thin-client tests exercise the routing surface, not
    //    embedding, so no provider is needed.
    const init = await spawn(['init', '--non-interactive', '--no-embedding', '--url', DATABASE_URL!], hostHome);
    if (init.exitCode !== 0) throw new Error(`host init failed: ${init.stderr || init.stdout}`);

    // 2. Pick a random free port for serve --http.
    serverPort = 30000 + Math.floor(Math.random() * 30000);

    // 3. Spawn serve --http (background, async).
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    delete env.DATABASE_URL;
    env.VOLTMIND_DATABASE_URL = runtimeDatabaseUrl;
    env.VOLTMIND_HOME = hostHome;
    serverProc = Bun.spawn({
      cmd: ['bun', 'run', CLI, 'serve', '--http', '--port', String(serverPort), '--public-url', `http://127.0.0.1:${serverPort}`],
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Wait for the server to be ready (poll the discovery endpoint).
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/.well-known/oauth-authorization-server`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) break;
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 250));
    }

    // 4. Register an ordinary least-privilege client. Host operations use a
    // separate admin identity in the one operator-only test below.
    const reg = await spawn([
      'auth', 'register-client', 'thin-client-test',
      '--grant-types', 'client_credentials',
      '--scopes', 'read write',
    ], hostHome);
    if (reg.exitCode !== 0) throw new Error(`register-client failed: ${reg.stderr || reg.stdout}`);
    const parsed = parseRegisterClientOutput(reg.stdout);
    clientId = parsed.clientId;
    clientSecret = parsed.clientSecret;
    if (!clientId || !clientSecret) {
      throw new Error(`register-client returned unexpected output: ${reg.stdout}`);
    }
  });

  function parseRegisterClientOutput(out: string): { clientId: string; clientSecret: string } {
    // `voltmind auth register-client` doesn't have --json; parse human output:
    //   Client ID:     <id>
    //   Client Secret: <secret>
    const idMatch = out.match(/Client ID:\s*(\S+)/);
    const secretMatch = out.match(/Client Secret:\s*(\S+)/);
    return {
      clientId: idMatch?.[1] ?? '',
      clientSecret: secretMatch?.[1] ?? '',
    };
  }

  afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill(); } catch { /* best-effort */ }
      try { await serverProc.exited; } catch { /* ignore */ }
    }
    try { rmSync(hostHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(clientHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    await teardownDB();
  });

  test('init --mcp-only succeeds against the live host', async () => {
    const r = await spawn([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${serverPort}`,
      '--mcp-url', `http://127.0.0.1:${serverPort}/mcp`,
      '--oauth-client-id', clientId,
      '--oauth-client-secret', clientSecret,
    ], clientHome);
    expect(r.exitCode).toBe(0);
    const cfgPath = join(clientHome, '.voltmind', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.remote_mcp.oauth_client_id).toBe(clientId);
    // No PGLite file
    expect(existsSync(join(clientHome, '.voltmind', 'brain.pglite'))).toBe(false);
  });

  test('doctor reports mode: thin-client with all checks green', async () => {
    const r = await spawn(['doctor', '--json'], clientHome);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.mode).toBe('thin-client');
    expect(report.status).toBe('ok');
    const checkNames = report.checks.map((c: { name: string }) => c.name);
    expect(checkNames).toContain('config_integrity');
    expect(checkNames).toContain('oauth_discovery');
    expect(checkNames).toContain('oauth_token');
    expect(checkNames).toContain('mcp_smoke');
    expect(report.oauth_scope).not.toContain('admin');
    const scopeCheck = report.checks.find((c: { name: string }) => c.name === 'oauth_client_scopes_probe');
    expect(scopeCheck.status).toBe('ok');
    expect(scopeCheck.message).toContain('admin intentionally not granted');
  });

  test('sync is refused with canonical thin-client error', async () => {
    const r = await spawn(['sync'], clientHome);
    expect(r.exitCode).toBe(1);
    // refuseThinClient() emits "(thin-client of <mcp_url>)" with the hyphenated
    // form. Allow either spelling so a future format tweak doesn't false-fail.
    expect(r.stderr).toMatch(/thin[- ]client/);
    expect(r.stderr).toContain(`http://127.0.0.1:${serverPort}/mcp`);
  });

  test('re-running init refuses without --force', async () => {
    const r = await spawn(['init', '--non-interactive', '--pglite', '--json'], clientHome);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('thin_client_config_present');
  });

  // ─── Tier B: voltmind remote ping + remote doctor ───

  test('voltmind remote doctor returns the host DoctorReport', async () => {
    const reg = await spawn([
      'auth', 'register-client', 'host-operator-test',
      '--grant-types', 'client_credentials',
      '--scopes', 'read admin',
    ], hostHome);
    if (reg.exitCode !== 0) throw new Error(`operator register-client failed: ${reg.stderr || reg.stdout}`);
    const operator = parseRegisterClientOutput(reg.stdout);
    const operatorHome = mkdtempSync(join(tmpdir(), 'voltmind-host-operator-'));
    try {
      const init = await spawn([
        'init', '--mcp-only', '--json',
        '--issuer-url', `http://127.0.0.1:${serverPort}`,
        '--mcp-url', `http://127.0.0.1:${serverPort}/mcp`,
        '--oauth-client-id', operator.clientId,
        '--oauth-client-secret', operator.clientSecret,
      ], operatorHome);
      expect(init.exitCode).toBe(0);
      const r = await spawn(['remote', 'doctor', '--json'], operatorHome);
      // Exit code reflects the host brain's health. On an empty fresh brain
      // brain_score is 0, so status may be unhealthy; the JSON round-trip is
      // the contract under test.
      const report = JSON.parse(r.stdout.trim());
      expect(report.schema_version).toBe(2);
      expect(['healthy', 'warnings', 'unhealthy']).toContain(report.status);
      const names = report.checks.map((c: { name: string }) => c.name);
      expect(names).toContain('connection');
      expect(names).toContain('schema_version');
      expect(names).toContain('brain_score');
      expect(names).toContain('queue_health');
      const conn = report.checks.find((c: { name: string; status: string }) => c.name === 'connection');
      expect(conn.status).toBe('ok');
      const sv = report.checks.find((c: { name: string; status: string }) => c.name === 'schema_version');
      expect(sv.status).toBe('ok');
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
    }
  });

  // Skipped: the test fixture is structurally incompatible with what this
  // assertion needs. `voltmind serve --http` does NOT start a job worker
  // (workers run via the separate `voltmind jobs work` process). So a
  // submit_job(autopilot-cycle) call from this fixture leaves the job in
  // `waiting` forever — no worker to advance it. The test was supposed to
  // fall back to the self-imposed `--timeout` firing, but `voltmind remote
  // ping --timeout` doesn't actually honor the cap when callRemoteTool
  // hangs (the polling loop only checks elapsed time between iterations;
  // a single in-flight callTool with no AbortSignal blocks forever).
  //
  // Two real follow-ups would unblock this:
  //   1. Thread an AbortSignal through callRemoteTool's MCP `callTool`
  //      path so `--timeout` actually caps individual calls (not just
  //      the loop overhead).
  //   2. OR start a `voltmind jobs work` subprocess in this test's beforeAll
  //      so the autopilot-cycle job actually fails-fast on a no-repo
  //      fixture and reaches a real terminal state.
  //
  // Either fix is its own PR. The wire path (callRemoteTool, OAuth, MCP
  // dispatch) is exercised by the doctor + low-scope tests in this file
  // and by the entire serve-http-oauth.test.ts suite, so coverage of the
  // protocol is not lost while this test sits skipped.
  testRaw.skip('voltmind remote ping triggers autopilot-cycle and returns terminal state', async () => {
    const r = await spawn(['remote', 'ping', '--json', '--timeout', '5s'], clientHome);
    expect(r.stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toHaveProperty('job_id');
    expect(parsed.job_id).toBeGreaterThan(0);
    if (parsed.status === 'success') {
      expect(parsed.state).toBe('completed');
    } else {
      expect(['failed', 'dead', 'cancelled', 'timeout']).toContain(parsed.reason ?? parsed.state);
    }
  });

  test('ordinary client cannot call admin-only remote doctor', async () => {
    const r = await spawn(['remote', 'doctor', '--json'], clientHome);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout.trim());
    expect(err.status).toBe('error');
    expect(['auth', 'auth_after_refresh', 'tool_error']).toContain(err.reason);
  });
});

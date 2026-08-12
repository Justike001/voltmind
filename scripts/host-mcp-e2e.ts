/**
 * Release-gate probe for the real VoltMind Host.
 *
 * The CI runner is a thin client: it must never open a PostgreSQL connection.
 * PostgreSQL-backed assertions are made exclusively through the Host's
 * authenticated, read-scope MCP surface. Admin-only scheduler/job state is a
 * Host operations concern and is intentionally outside this client gate.
 */
import type { VoltMindConfig } from '../src/core/config.ts';
import { callRemoteTool, unpackToolResult } from '../src/core/mcp-client.ts';

type BrainIdentity = {
  version: string;
  engine: string;
  page_count: number;
  chunk_count: number;
};

type SchemaStats = {
  schema_version: number;
  aggregate: { total_pages: number; typed_pages: number };
  per_source: unknown[];
};

type RecallResult = {
  facts: unknown[];
  total: number;
  pending_consolidation_count?: number;
};

function configured(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required Host MCP setting: ${name}`);
  return value;
}

function hostConfig(): VoltMindConfig {
  // CI uses a dedicated read-scope client_credentials client. Deliberately do
  // not fall back to a workstation config: a developer's interactive client
  // may be broader than the public thin-client trust boundary and would mask a
  // scope regression in this gate.
  return {
    engine: 'pglite', // ignored by callRemoteTool; no local engine is opened
    remote_mcp: {
      issuer_url: configured('VOLTMIND_REMOTE_ISSUER_URL'),
      mcp_url: configured('VOLTMIND_REMOTE_MCP_URL'),
      oauth_client_id: configured('VOLTMIND_REMOTE_CLIENT_ID'),
      oauth_client_secret: configured('VOLTMIND_REMOTE_CLIENT_SECRET'),
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function call<T>(config: VoltMindConfig, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await callRemoteTool(config, name, args, { timeoutMs: 30_000 });
  return unpackToolResult<T>(response);
}

async function inspectHost(config: VoltMindConfig): Promise<void> {
  const identity = await call<BrainIdentity>(config, 'get_brain_identity');
  assert(identity.engine === 'postgres', `Host engine must be postgres, received ${JSON.stringify(identity.engine)}`);
  assert(typeof identity.version === 'string' && identity.version.length > 0, 'Host did not publish a version');
  assert(Number.isInteger(identity.page_count) && identity.page_count >= 0, 'Invalid Host page_count');
  assert(Number.isInteger(identity.chunk_count) && identity.chunk_count >= 0, 'Invalid Host chunk_count');

  const schema = await call<SchemaStats>(config, 'schema_stats');
  assert(schema.schema_version === 1, `Unsupported schema_stats payload: ${JSON.stringify(schema.schema_version)}`);
  assert(Number.isInteger(schema.aggregate?.total_pages), 'Host schema_stats is missing total_pages');
  assert(schema.aggregate.total_pages === identity.page_count, 'Host identity/schema_stats page counts disagree');
  assert(Array.isArray(schema.per_source), 'Host schema_stats is missing per_source results');

  // This is a DB-backed read of the hot-memory surface. include_pending also
  // proves the Host can execute the dream-cycle consolidation count query,
  // without exposing or requiring admin-only scheduler/job state.
  const recall = await call<RecallResult>(config, 'recall', { limit: 1, include_pending: true });
  assert(Array.isArray(recall.facts), 'Host recall did not return a facts array');
  assert(Number.isInteger(recall.total) && recall.total >= 0, 'Host recall returned an invalid total');
  assert(Number.isInteger(recall.pending_consolidation_count), 'Host recall omitted pending consolidation count');

  console.log(JSON.stringify({
    gate: 'host-mcp',
    host_version: identity.version,
    engine: identity.engine,
    page_count: identity.page_count,
    chunk_count: identity.chunk_count,
    typed_pages: schema.aggregate.typed_pages,
    pending_consolidation_count: recall.pending_consolidation_count,
  }));
}

async function runHeavy(config: VoltMindConfig): Promise<void> {
  // A bounded soak of the real thin-client path. Sequential iterations avoid
  // turning a release check into a load test against the user's Host.
  for (let i = 0; i < 10; i++) {
    const [identity, schema] = await Promise.all([
      call<BrainIdentity>(config, 'get_brain_identity'),
      call<SchemaStats>(config, 'schema_stats'),
    ]);
    assert(identity.engine === 'postgres', `Heavy iteration ${i + 1}: Host stopped reporting postgres`);
    assert(schema.schema_version === 1, `Heavy iteration ${i + 1}: schema_stats payload drifted`);
    assert(schema.aggregate.total_pages === identity.page_count, `Heavy iteration ${i + 1}: page counts disagree`);
  }
  console.log(JSON.stringify({ gate: 'host-mcp-heavy', iterations: 10, calls: 20 }));
}

const mode = process.argv[2] ?? 'tier2';
const config = hostConfig();
if (mode === 'tier2') await inspectHost(config);
else if (mode === 'heavy') await runHeavy(config);
else throw new Error(`Unknown Host MCP E2E mode: ${mode}`);

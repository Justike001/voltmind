/**
 * Release-gate probe for the real VoltMind Host.
 *
 * The CI runner is a thin client: it must never open a PostgreSQL connection.
 * Database, autopilot, and dream-cycle assertions are made exclusively through
 * the Host's authenticated MCP surface.
 */
import type { VoltMindConfig } from '../src/core/config.ts';
import { callRemoteTool, unpackToolResult } from '../src/core/mcp-client.ts';

type BrainIdentity = {
  version: string;
  engine: string;
  page_count: number;
  chunk_count: number;
};

type StatusSnapshot = {
  schema_version: number;
  sync: unknown;
  cycle: unknown;
};

type RemoteJob = { id?: number; name?: string; state?: string };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required Host MCP setting: ${name}`);
  return value;
}

function hostConfig(): VoltMindConfig {
  return {
    engine: 'pglite', // ignored in thin-client mode; kept for config typing
    remote_mcp: {
      issuer_url: required('VOLTMIND_REMOTE_ISSUER_URL'),
      mcp_url: required('VOLTMIND_REMOTE_MCP_URL'),
      oauth_client_id: required('VOLTMIND_REMOTE_CLIENT_ID'),
      oauth_client_secret: required('VOLTMIND_REMOTE_CLIENT_SECRET'),
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

  const status = await call<StatusSnapshot>(config, 'get_status_snapshot');
  assert(status.schema_version === 1, `Unsupported Host status schema: ${JSON.stringify(status.schema_version)}`);
  assert(status.sync !== null && typeof status.sync === 'object', 'Host status is missing sync state');
  assert(status.cycle !== null && typeof status.cycle === 'object', 'Host status is missing dream-cycle state');

  const jobs = await call<RemoteJob[]>(config, 'list_jobs', { name: 'autopilot-cycle', limit: 20 });
  assert(Array.isArray(jobs), 'Host list_jobs did not return an array');
  assert(jobs.some((job) => job?.name === 'autopilot-cycle'), 'Host has no recorded autopilot/dream cycle');

  const doctor = await call<{ status?: string; health_score?: number }>(config, 'run_doctor');
  assert(doctor.status !== 'unhealthy', `Host doctor reports unhealthy (score ${doctor.health_score ?? 'unknown'})`);

  console.log(JSON.stringify({
    gate: 'host-mcp',
    host_version: identity.version,
    engine: identity.engine,
    page_count: identity.page_count,
    chunk_count: identity.chunk_count,
    autopilot_jobs_observed: jobs.length,
    doctor_status: doctor.status,
    doctor_score: doctor.health_score,
  }));
}

async function runHeavy(config: VoltMindConfig): Promise<void> {
  // A bounded soak of the real thin-client path. Sequential calls avoid
  // turning a release check into a load test against the user's Host.
  for (let i = 0; i < 10; i++) {
    const [identity, status] = await Promise.all([
      call<BrainIdentity>(config, 'get_brain_identity'),
      call<StatusSnapshot>(config, 'get_status_snapshot'),
    ]);
    assert(identity.engine === 'postgres', `Heavy iteration ${i + 1}: Host stopped reporting postgres`);
    assert(status.schema_version === 1, `Heavy iteration ${i + 1}: status schema drifted`);
  }
  console.log(JSON.stringify({ gate: 'host-mcp-heavy', iterations: 10, calls: 20 }));
}

const mode = process.argv[2] ?? 'tier2';
const config = hostConfig();
if (mode === 'tier2') await inspectHost(config);
else if (mode === 'heavy') await runHeavy(config);
else throw new Error(`Unknown Host MCP E2E mode: ${mode}`);

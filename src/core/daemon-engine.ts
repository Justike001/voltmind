import type { BrainEngine, ReservedConnection } from './engine.ts';
import type { BrainStats, BrainHealth, EngineConfig } from './types.ts';
import type { DispatchOpts, ToolResult } from '../mcp/dispatch.ts';
import type { MinionJob, MinionJobInput } from './minions/types.ts';
import type { TrustedSubmitOpts } from './minions/queue.ts';
import {
  callLocalDaemon,
  isProcessAlive,
  LOCAL_DAEMON_RPC_PROTOCOL_VERSION,
  readDaemonState,
  removeDaemonState,
  type LocalDaemonState,
} from './local-daemon.ts';

export type DaemonToolDispatcher = (
  name: string,
  params: Record<string, unknown> | undefined,
  opts: DispatchOpts,
) => Promise<ToolResult>;

export type DaemonQueueAdd = (
  name: string,
  data?: Record<string, unknown>,
  opts?: Partial<MinionJobInput>,
  trusted?: TrustedSubmitOpts,
) => Promise<MinionJob>;

export interface DaemonBackedServeRuntime {
  state: LocalDaemonState;
  engine: BrainEngine;
  toolDispatcher: DaemonToolDispatcher;
  queueAdd: DaemonQueueAdd;
}

export type DaemonBackedServeResolution =
  | { kind: 'none' }
  | { kind: 'compatible'; runtime: DaemonBackedServeRuntime }
  | { kind: 'incompatible'; state: LocalDaemonState; reason: string };

function daemonEngineKind(state: LocalDaemonState): BrainEngine['kind'] {
  return state.database_path ? 'pglite' : 'postgres';
}

async function callDaemonResult<T>(
  state: LocalDaemonState,
  req: Parameters<typeof callLocalDaemon>[1],
  timeoutMs = 30_000,
): Promise<T> {
  const response = await callLocalDaemon(state, req, { timeoutMs });
  if (!response.ok) {
    throw new Error(response.error || response.stderr || `daemon RPC failed for ${(req as any).kind ?? (req as any).command}`);
  }
  return response.result as T;
}

function createDaemonBackedEngine(state: LocalDaemonState): BrainEngine {
  const executeRaw = async <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> => {
    return callDaemonResult<T[]>(state, {
      kind: 'raw_sql',
      sql,
      params: params ?? [],
    });
  };

  const engine = {
    kind: daemonEngineKind(state),
    connect: async (_config: EngineConfig) => undefined,
    disconnect: async () => undefined,
    initSchema: async () => {
      throw new Error('daemon-backed serve runtime cannot initialize schema; run migrations through the daemon owner');
    },
    transaction: async () => {
      throw new Error('daemon-backed serve runtime does not support client-side transactions; use daemon structured RPC');
    },
    withReservedConnection: async <T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> => {
      return fn({ executeRaw });
    },
    getStats: async (): Promise<BrainStats> => callDaemonResult<BrainStats>(state, { kind: 'engine_stats' }),
    getHealth: async (): Promise<BrainHealth> => callDaemonResult<BrainHealth>(state, { kind: 'engine_health' }),
    getConfig: async (key: string): Promise<string | null> => {
      const rows = await executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [key]);
      return rows[0]?.value ?? null;
    },
    setConfig: async (key: string, value: string): Promise<void> => {
      await executeRaw(
        'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value],
      );
    },
    unsetConfig: async (key: string): Promise<number> => {
      const rows = await executeRaw<{ count: number | string }>('DELETE FROM config WHERE key = $1 RETURNING 1 AS count', [key]);
      return rows.length;
    },
    listConfigKeys: async (prefix: string): Promise<string[]> => {
      const rows = await executeRaw<{ key: string }>('SELECT key FROM config WHERE key LIKE $1 ORDER BY key', [`${prefix}%`]);
      return rows.map(row => row.key);
    },
    executeRaw,
  };

  return engine as unknown as BrainEngine;
}

function createDaemonBackedServeRuntime(state: LocalDaemonState): DaemonBackedServeRuntime {
  const toolDispatcher: DaemonToolDispatcher = async (name, params, opts) => {
    return callDaemonResult<ToolResult>(state, {
      kind: 'tool_call',
      tool: name,
      params,
      opts,
    });
  };

  const queueAdd: DaemonQueueAdd = async (name, data, opts, trusted) => {
    return callDaemonResult<MinionJob>(state, {
      kind: 'queue_add',
      name,
      data,
      opts: opts as Record<string, unknown> | undefined,
      trusted,
    });
  };

  return {
    state,
    engine: createDaemonBackedEngine(state),
    toolDispatcher,
    queueAdd,
  };
}

export async function resolveDaemonBackedServeRuntime(): Promise<DaemonBackedServeResolution> {
  const state = readDaemonState();
  if (!state) return { kind: 'none' };

  if (!isProcessAlive(state.pid)) {
    removeDaemonState();
    return { kind: 'none' };
  }

  if ((state.rpc_protocol_version ?? 1) < LOCAL_DAEMON_RPC_PROTOCOL_VERSION) {
    return {
      kind: 'incompatible',
      state,
      reason: `local daemon protocol v${state.rpc_protocol_version ?? 1} is older than required v${LOCAL_DAEMON_RPC_PROTOCOL_VERSION}`,
    };
  }

  try {
    await callDaemonResult(state, { kind: 'raw_sql', sql: 'SELECT 1 AS ok', params: [] }, 2_000);
  } catch (err) {
    return {
      kind: 'incompatible',
      state,
      reason: `local daemon did not answer protocol v${LOCAL_DAEMON_RPC_PROTOCOL_VERSION} probe: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { kind: 'compatible', runtime: createDaemonBackedServeRuntime(state) };
}

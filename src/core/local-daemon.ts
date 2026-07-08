import { existsSync, readFileSync, rmSync } from 'fs';
import { voltmindPath } from './config.ts';

export interface LocalDaemonState {
  schema_version: 1;
  rpc_protocol_version?: number;
  pid: number;
  port: number;
  token: string;
  started_at: string;
  home: string;
  database_path?: string;
  version: string;
}

export const LOCAL_DAEMON_RPC_PROTOCOL_VERSION = 2;

export interface LocalDaemonCliRequest {
  command: string;
  args: string[];
}

export interface LocalDaemonToolCallRequest {
  kind: 'tool_call';
  tool: string;
  params?: Record<string, unknown>;
  opts?: {
    remote?: boolean;
    takesHoldersAllowList?: string[];
    sourceId?: string;
    auth?: unknown;
  };
}

export interface LocalDaemonRawSqlRequest {
  kind: 'raw_sql';
  sql: string;
  params?: unknown[];
}

export interface LocalDaemonEngineStatsRequest {
  kind: 'engine_stats';
}

export interface LocalDaemonEngineHealthRequest {
  kind: 'engine_health';
}

export interface LocalDaemonQueueAddRequest {
  kind: 'queue_add';
  name: string;
  data?: Record<string, unknown>;
  opts?: Record<string, unknown>;
  trusted?: { allowProtectedSubmit?: boolean };
}

export type LocalDaemonRequest =
  | LocalDaemonCliRequest
  | LocalDaemonToolCallRequest
  | LocalDaemonRawSqlRequest
  | LocalDaemonEngineStatsRequest
  | LocalDaemonEngineHealthRequest
  | LocalDaemonQueueAddRequest;

export interface LocalDaemonResponse {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  result?: unknown;
}

const DAEMON_STATE_FILE = 'daemon.json';

export const LOCAL_DAEMON_COMMANDS = new Set([
  'get',
  'put',
  'delete',
  'restore',
  'list',
  'search',
  'query',
  'ask',
  'tags',
  'tag',
  'untag',
  'link',
  'unlink',
  'backlinks',
  'graph',
  'timeline',
  'timeline-add',
  'stats',
  'health',
  'import',
  'capture',
  'enrich',
  'sync',
  'embed',
  'status',
  'config',
  'sources',
  'actions',
]);

export function daemonStatePath(): string {
  return voltmindPath(DAEMON_STATE_FILE);
}

export function readDaemonState(): LocalDaemonState | null {
  const path = daemonStatePath();
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as LocalDaemonState;
    if (!state || typeof state.port !== 'number' || typeof state.token !== 'string') return null;
    return state;
  } catch {
    return null;
  }
}

export function removeDaemonState(): void {
  try { rmSync(daemonStatePath(), { force: true }); } catch { /* best-effort */ }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

export function shouldForwardToLocalDaemon(command: string, args: string[]): boolean {
  if (process.env.VOLTMIND_DAEMON_BYPASS === '1') return false;
  if (args.includes('--help') || args.includes('-h')) return false;
  return LOCAL_DAEMON_COMMANDS.has(command);
}

export async function callLocalDaemon(
  state: LocalDaemonState,
  req: LocalDaemonRequest,
  opts?: { timeoutMs?: number },
): Promise<LocalDaemonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30_000);
  timeout.unref?.();
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${state.token}`,
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as LocalDaemonResponse;
    } catch {
      return { ok: false, error: text || `daemon returned HTTP ${res.status}`, exitCode: 1 };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function maybeForwardToLocalDaemon(command: string, args: string[]): Promise<boolean> {
  if (!shouldForwardToLocalDaemon(command, args)) return false;
  const state = readDaemonState();
  if (!state) return false;
  if (!isProcessAlive(state.pid)) {
    removeDaemonState();
    return false;
  }

  let response: LocalDaemonResponse;
  try {
    response = await callLocalDaemon(state, { command, args });
  } catch {
    return false;
  }

  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  if (!response.ok && response.error) process.stderr.write(response.error + '\n');
  process.exit(response.exitCode ?? (response.ok ? 0 : 1));
}

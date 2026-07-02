// Sync failure ledger.
//
// Records per-file sync failures as one JSONL row per (source_id, path). The
// ledger is source-scoped, cross-process locked, and keeps an attempt counter
// so chronic file failures can be handled without wedging every future sync.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { voltmindPath } from './config.ts';

export const DEFAULT_SOURCE_ID = 'default';
export const SENTINEL_PREFIX = '<';
export const DEFAULT_AUTOSKIP_AFTER = 3;

const LOCK_STALE_MS = 30_000;
const LOCK_SPIN_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;

export type SyncFailureState = 'open' | 'acknowledged' | 'auto_skipped';

export interface SyncFailure {
  source_id: string;
  path: string;
  error: string;
  code: string;
  commit: string;
  line?: number;
  first_seen: string;
  ts: string;
  attempts: number;
  state: SyncFailureState;
  resolved_at?: string;
  acknowledged?: boolean;
  acknowledged_at?: string | null;
}

export interface AcknowledgeResult {
  count: number;
  summary: Array<{ code: string; count: number }>;
}

export function isSkippablePath(path: string): boolean {
  return !path.startsWith(SENTINEL_PREFIX);
}

export function resolveAutoSkipThreshold(): number {
  const raw = process.env.VOLTMIND_SYNC_AUTOSKIP_AFTER;
  if (raw === undefined || raw === '') return DEFAULT_AUTOSKIP_AFTER;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTOSKIP_AFTER;
  return Math.floor(n);
}

export function classifyErrorCode(errorMsg: string): string {
  if (/slug.*does not match|SLUG_MISMATCH/i.test(errorMsg)) return 'SLUG_MISMATCH';
  if (/duplicate key value violates unique constraint|DB_DUPLICATE_KEY/i.test(errorMsg)) return 'DB_DUPLICATE_KEY';
  if (/canceling statement due to statement timeout|STATEMENT_TIMEOUT/i.test(errorMsg)) return 'STATEMENT_TIMEOUT';
  if (/YAML parse failed|YAML_PARSE/i.test(errorMsg)) return 'YAML_PARSE';
  if (/YAMLException|duplicated mapping key|YAML_DUPLICATE_KEY/i.test(errorMsg)) return 'YAML_DUPLICATE_KEY';
  if (/File is empty or whitespace-only|Frontmatter must start with ---|MISSING_OPEN/i.test(errorMsg)) return 'MISSING_OPEN';
  if (/No closing --- delimiter|Heading at line .* found inside frontmatter|MISSING_CLOSE/i.test(errorMsg)) return 'MISSING_CLOSE';
  if (/Frontmatter block is empty|EMPTY_FRONTMATTER/i.test(errorMsg)) return 'EMPTY_FRONTMATTER';
  if (/Content contains null bytes|NULL_BYTES|null byte/i.test(errorMsg)) return 'NULL_BYTES';
  if (/Nested double quotes|NESTED_QUOTES/i.test(errorMsg)) return 'NESTED_QUOTES';
  if (/invalid UTF-?8|INVALID_UTF8/i.test(errorMsg)) return 'INVALID_UTF8';
  if (/file too large|content too large|FILE_TOO_LARGE/i.test(errorMsg)) return 'FILE_TOO_LARGE';
  if (/skipping symlink|symlink|SYMLINK_NOT_ALLOWED/i.test(errorMsg)) return 'SYMLINK_NOT_ALLOWED';
  if (/TAKES_TABLE_MALFORMED|TAKES_ROW_NUM_COLLISION|TAKES_FENCE_UNBALANCED/i.test(errorMsg)) return 'TAKES_TABLE_MALFORMED';
  if (/TAKES_HOLDER_INVALID/i.test(errorMsg)) return 'TAKES_HOLDER_INVALID';
  if (/embedding requires [A-Z][A-Z0-9_]+_API_KEY|EMBEDDING_NO_CREDS/i.test(errorMsg)) return 'EMBEDDING_NO_CREDS';
  if (/Anthropic has no embedding model|EMBEDDING_NO_TOUCHPOINT/i.test(errorMsg)) return 'EMBEDDING_NO_TOUCHPOINT';
  if (/\brate.?limit|\b429\b|too many requests|rate_limited|RateLimit/i.test(errorMsg)) return 'EMBEDDING_RATE_LIMIT';
  if (/insufficient_quota|quota exceeded|exceeded.*quota|credit balance is too low|billing|EMBEDDING_QUOTA/i.test(errorMsg)) return 'EMBEDDING_QUOTA';
  if (/maximum context length|max_tokens|context length|input too long|input length exceeds|tokens? exceed|too many tokens|EMBEDDING_OVERSIZE/i.test(errorMsg)) return 'EMBEDDING_OVERSIZE';
  if (/PAGE_JUNK_PATTERN/i.test(errorMsg)) return 'PAGE_JUNK_PATTERN';
  return 'UNKNOWN';
}

export function summarizeFailuresByCode(
  failures: Array<{ error: string; code?: string }>,
): Array<{ code: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const f of failures) {
    const code = f.code ?? classifyErrorCode(f.error);
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => ({ code, count }));
}

export function formatCodeBreakdown(
  input: Array<{ error: string; code?: string }> | Array<{ code: string; count: number }>,
): string {
  const summary =
    input.length > 0 && typeof (input[0] as { count?: unknown }).count === 'number'
      ? (input as Array<{ code: string; count: number }>)
      : summarizeFailuresByCode(input as Array<{ error: string; code?: string }>);
  return summary.map(s => `  ${s.code}: ${s.count}`).join('\n');
}

export function syncFailuresPath(): string {
  return join(voltmindPath(), 'sync-failures.jsonl');
}

function ledgerKey(f: { source_id: string; path: string }): string {
  return `${f.source_id}\0${f.path}`;
}

function applyMirror(f: SyncFailure): SyncFailure {
  if (f.state === 'acknowledged') {
    f.acknowledged = true;
    f.acknowledged_at = f.resolved_at ?? f.ts;
  } else {
    delete f.acknowledged;
    delete f.acknowledged_at;
  }
  return f;
}

function normalizeRow(raw: Record<string, unknown>): SyncFailure {
  const source_id = typeof raw.source_id === 'string' && raw.source_id ? raw.source_id : DEFAULT_SOURCE_ID;
  const error = String(raw.error ?? '');
  const code = typeof raw.code === 'string' && raw.code ? raw.code : classifyErrorCode(error);
  const ts = typeof raw.ts === 'string' && raw.ts ? raw.ts : new Date(0).toISOString();
  const first_seen = typeof raw.first_seen === 'string' && raw.first_seen ? raw.first_seen : ts;
  let state: SyncFailureState;
  if (raw.state === 'open' || raw.state === 'acknowledged' || raw.state === 'auto_skipped') {
    state = raw.state;
  } else {
    state = raw.acknowledged === true || raw.acknowledged_at ? 'acknowledged' : 'open';
  }
  const attempts =
    typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) && raw.attempts > 0
      ? Math.floor(raw.attempts)
      : 1;
  return applyMirror({
    source_id,
    path: String(raw.path ?? ''),
    error,
    code,
    commit: String(raw.commit ?? ''),
    line: typeof raw.line === 'number' ? raw.line : undefined,
    first_seen,
    ts,
    attempts,
    state,
    resolved_at:
      typeof raw.resolved_at === 'string'
        ? raw.resolved_at
        : typeof raw.acknowledged_at === 'string'
          ? raw.acknowledged_at
          : undefined,
  });
}

function mergeGroup(group: SyncFailure[]): SyncFailure {
  const sorted = [...group].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const latest = sorted[sorted.length - 1];
  const first_seen = sorted.reduce(
    (min, row) => (row.first_seen && row.first_seen < min ? row.first_seen : min),
    sorted[0].first_seen,
  );
  const hasOpen = group.some(row => row.state === 'open');
  const hasAuto = group.some(row => row.state === 'auto_skipped');
  const state: SyncFailureState = hasOpen ? 'open' : hasAuto ? 'auto_skipped' : 'acknowledged';
  const distinctCommits = new Set(group.map(row => row.commit)).size;
  const maxAttempts = group.reduce((max, row) => Math.max(max, row.attempts), 0);
  return applyMirror({ ...latest, first_seen, state, attempts: Math.max(distinctCommits, maxAttempts, 1) });
}

export function loadSyncFailures(): SyncFailure[] {
  const path = syncFailuresPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const rows: SyncFailure[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(normalizeRow(JSON.parse(trimmed) as Record<string, unknown>));
    } catch {
      console.warn(`[sync-failures] skipping malformed line: ${trimmed.slice(0, 120)}`);
    }
  }
  const byKey = new Map<string, SyncFailure[]>();
  for (const row of rows) {
    const key = ledgerKey(row);
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey.values()].map(group => (group.length === 1 ? group[0] : mergeGroup(group)));
}

export function unacknowledgedSyncFailures(): SyncFailure[] {
  return loadSyncFailures().filter(row => row.state !== 'acknowledged');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch { /* raced */ }
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return false;
      sleepSync(LOCK_SPIN_MS);
    }
  }
}

export function withLedgerLock<T>(fn: () => T): T {
  mkdirSync(voltmindPath(), { recursive: true });
  const lockPath = syncFailuresPath() + '.lock';
  const locked = acquireLock(lockPath);
  if (!locked) console.warn('[sync-failures] could not acquire ledger lock; proceeding best-effort');
  try {
    return fn();
  } finally {
    if (locked) {
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}

function writeAll(entries: SyncFailure[]): void {
  mkdirSync(voltmindPath(), { recursive: true });
  const target = syncFailuresPath();
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, entries.length ? entries.map(row => JSON.stringify(row)).join('\n') + '\n' : '');
  renameSync(tmp, target);
}

function recordAndClear(
  sourceId: string,
  succeededPaths: string[],
  failures: Array<{ path: string; error: string; line?: number }>,
  commit: string,
): Map<string, number> {
  return withLedgerLock(() => {
    const entries = loadSyncFailures();
    const byKey = new Map<string, SyncFailure>();
    for (const entry of entries) byKey.set(ledgerKey(entry), entry);
    let changed = false;

    for (const path of succeededPaths) {
      if (byKey.delete(ledgerKey({ source_id: sourceId, path }))) changed = true;
    }

    const now = new Date().toISOString();
    for (const failure of failures) {
      const key = ledgerKey({ source_id: sourceId, path: failure.path });
      const existing = byKey.get(key);
      const code = classifyErrorCode(failure.error);
      if (existing && existing.state === 'open') {
        existing.attempts += 1;
        existing.ts = now;
        existing.commit = commit;
        existing.error = failure.error;
        existing.code = code;
        existing.line = failure.line;
        applyMirror(existing);
      } else {
        byKey.set(key, applyMirror({
          source_id: sourceId,
          path: failure.path,
          error: failure.error,
          code,
          commit,
          line: failure.line,
          first_seen: now,
          ts: now,
          attempts: 1,
          state: 'open',
        }));
      }
      changed = true;
    }

    if (changed) writeAll([...byKey.values()]);
    const attempts = new Map<string, number>();
    for (const failure of failures) {
      attempts.set(failure.path, byKey.get(ledgerKey({ source_id: sourceId, path: failure.path }))?.attempts ?? 1);
    }
    return attempts;
  });
}

export function recordFailures(
  sourceId: string,
  failures: Array<{ path: string; error: string; line?: number }>,
  commit: string,
): void {
  if (failures.length === 0) return;
  recordAndClear(sourceId, [], failures, commit);
}

export function clearFailures(sourceId: string, paths: string[]): void {
  if (paths.length === 0) return;
  withLedgerLock(() => {
    const remove = new Set(paths.map(path => ledgerKey({ source_id: sourceId, path })));
    const entries = loadSyncFailures();
    const kept = entries.filter(entry => !remove.has(ledgerKey(entry)));
    if (kept.length !== entries.length) writeAll(kept);
  });
}

export function acknowledgeFailures(sourceId?: string): AcknowledgeResult {
  return withLedgerLock(() => {
    const entries = loadSyncFailures();
    const now = new Date().toISOString();
    const acked: SyncFailure[] = [];
    for (const entry of entries) {
      if (entry.state !== 'open') continue;
      if (sourceId !== undefined && entry.source_id !== sourceId) continue;
      if (!isSkippablePath(entry.path)) continue;
      entry.state = 'acknowledged';
      entry.resolved_at = now;
      applyMirror(entry);
      acked.push(entry);
    }
    if (acked.length > 0) writeAll(entries);
    return { count: acked.length, summary: summarizeFailuresByCode(acked) };
  });
}

export function autoSkipFailures(sourceId: string, paths: string[]): AcknowledgeResult {
  if (paths.length === 0) return { count: 0, summary: [] };
  return withLedgerLock(() => {
    const entries = loadSyncFailures();
    const target = new Set(paths.filter(isSkippablePath).map(path => ledgerKey({ source_id: sourceId, path })));
    const now = new Date().toISOString();
    const skipped: SyncFailure[] = [];
    for (const entry of entries) {
      if (!target.has(ledgerKey(entry)) || entry.state !== 'open') continue;
      entry.state = 'auto_skipped';
      entry.resolved_at = now;
      applyMirror(entry);
      skipped.push(entry);
    }
    if (skipped.length > 0) writeAll(entries);
    return { count: skipped.length, summary: summarizeFailuresByCode(skipped) };
  });
}

export function recordSyncFailures(
  failures: Array<{ path: string; error: string; line?: number }>,
  commit: string,
): void {
  recordFailures(DEFAULT_SOURCE_ID, failures, commit);
}

export function acknowledgeSyncFailures(): AcknowledgeResult {
  return acknowledgeFailures(undefined);
}

export interface GateDecision {
  action: 'hard_block' | 'block' | 'advance' | 'advance_then_autoskip';
  autoSkipPaths: string[];
}

export function decideGateAction(args: {
  fileFailures: Array<{ path: string }>;
  sentinels: Array<{ path: string }>;
  attemptsByPath: Map<string, number>;
  threshold: number;
  skipFailed: boolean;
}): GateDecision {
  if (args.sentinels.length > 0) return { action: 'hard_block', autoSkipPaths: [] };
  if (args.fileFailures.length === 0) return { action: 'advance', autoSkipPaths: [] };
  if (args.skipFailed) return { action: 'advance', autoSkipPaths: [] };
  if (args.threshold <= 0) return { action: 'block', autoSkipPaths: [] };

  const chronic: string[] = [];
  let fresh = 0;
  for (const failure of args.fileFailures) {
    const attempts = args.attemptsByPath.get(failure.path) ?? 1;
    if (attempts >= args.threshold) chronic.push(failure.path);
    else fresh++;
  }
  if (fresh > 0) return { action: 'block', autoSkipPaths: [] };
  if (chronic.length > 0) return { action: 'advance_then_autoskip', autoSkipPaths: chronic };
  return { action: 'block', autoSkipPaths: [] };
}

export interface SeverityResult {
  status: 'ok' | 'warn' | 'fail';
  unresolved: number;
  open: number;
  auto_skipped: number;
}

export function decideSyncFailureSeverity(args: {
  entries: SyncFailure[];
  nowMs: number;
  failHours: number;
}): SeverityResult {
  const unresolved = args.entries.filter(entry => entry.state === 'open' || entry.state === 'auto_skipped');
  const autoSkipped = unresolved.filter(entry => entry.state === 'auto_skipped').length;
  const open = unresolved.length - autoSkipped;
  if (unresolved.length === 0) return { status: 'ok', unresolved: 0, open: 0, auto_skipped: 0 };

  let oldestOpenMs = Infinity;
  for (const entry of unresolved) {
    if (entry.state !== 'open') continue;
    const ms = Date.parse(entry.ts);
    if (Number.isFinite(ms)) oldestOpenMs = Math.min(oldestOpenMs, ms);
  }
  const blockedTooLong =
    Number.isFinite(oldestOpenMs) && args.nowMs - oldestOpenMs > args.failHours * 3_600_000;
  return {
    status: open >= 10 || blockedTooLong ? 'fail' : 'warn',
    unresolved: unresolved.length,
    open,
    auto_skipped: autoSkipped,
  };
}

export interface SyncGateInput {
  sourceId: string;
  failedFiles: Array<{ path: string; error: string; line?: number }>;
  succeededPaths: string[];
  commit: string;
  skipFailed: boolean;
  threshold?: number;
  advance: () => Promise<void> | void;
}

export interface SyncGateOutcome {
  advanced: boolean;
  sentinelBlocked: boolean;
  fresh: number;
  chronic: number;
  autoSkipped: string[];
  acknowledged: number;
}

export async function applySyncFailureGate(input: SyncGateInput): Promise<SyncGateOutcome> {
  const threshold = input.threshold ?? resolveAutoSkipThreshold();
  const sentinels = input.failedFiles.filter(failure => !isSkippablePath(failure.path));
  const fileFailures = input.failedFiles.filter(failure => isSkippablePath(failure.path));

  if (input.failedFiles.length === 0 && input.succeededPaths.length === 0) {
    await input.advance();
    return { advanced: true, sentinelBlocked: false, fresh: 0, chronic: 0, autoSkipped: [], acknowledged: 0 };
  }

  const attemptsByPath = recordAndClear(input.sourceId, input.succeededPaths, input.failedFiles, input.commit);
  const decision = decideGateAction({
    fileFailures,
    sentinels,
    attemptsByPath,
    threshold,
    skipFailed: input.skipFailed,
  });

  let fresh = 0;
  let chronic = 0;
  for (const failure of fileFailures) {
    if ((attemptsByPath.get(failure.path) ?? 1) >= threshold && threshold > 0) chronic++;
    else fresh++;
  }

  if (decision.action === 'hard_block' || decision.action === 'block') {
    return {
      advanced: false,
      sentinelBlocked: decision.action === 'hard_block',
      fresh,
      chronic,
      autoSkipped: [],
      acknowledged: 0,
    };
  }

  await input.advance();

  let autoSkipped: string[] = [];
  let acknowledged = 0;
  if (input.skipFailed) {
    acknowledged = acknowledgeFailures(input.sourceId).count;
  } else if (decision.action === 'advance_then_autoskip') {
    autoSkipped = decision.autoSkipPaths;
    autoSkipFailures(input.sourceId, autoSkipped);
  }

  return {
    advanced: true,
    sentinelBlocked: false,
    fresh,
    chronic,
    autoSkipped,
    acknowledged,
  };
}

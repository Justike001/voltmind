/**
 * Shared MCP tool-call dispatch — single source of truth for stdio + HTTP transports.
 *
 * Both transports validate the same params, build the same OperationContext shape,
 * and serialize errors identically. Drift between transports caused PR #483's reversed-args
 * + missing-context bugs; this module exists to prevent that recurring.
 */

import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError, resolveReadSourceScope, resolveWriteSourceId } from '../core/operations.ts';
import type { Operation, OperationContext, AuthInfo } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { hasScope } from '../core/scope.ts';
import { executeRawJsonb } from '../core/sql-query.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { randomUUID } from 'node:crypto';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /**
   * v0.31 (eD3): MCP spec-blessed metadata slot for server-supplied data.
   * The dispatcher injects `_meta.brain_hot_memory` here when an op succeeds
   * and the configured `metaHook` returns a payload.
   *
   * Existing clients ignore unknown `_meta` fields; capable clients (Claude
   * Code, Claude Desktop) read it. NOT a wrapper around the result body —
   * `content` stays the same shape it always had. Best-effort: any error in
   * the meta hook is absorbed and the tool call still succeeds.
   */
  _meta?: Record<string, unknown>;
}

export interface DispatchOpts {
  /** Defaults to true (remote/untrusted). Local CLI callers (`voltmind call`) pass false. */
  remote?: boolean;
  /** Override the default stderr logger (e.g. CLI uses console.* directly). */
  logger?: OperationContext['logger'];
  /**
   * v0.28: per-token allow-list for the takes.holder field. Threaded by
   * the HTTP/stdio transport from `access_tokens.permissions.takes_holders`.
   * When set, takes_list / takes_search / query (when it returns takes)
   * MUST filter `WHERE holder = ANY($takesHoldersAllowList)`. Local CLI
   * callers leave this unset (no filter — they own the brain).
   */
  takesHoldersAllowList?: string[];
  /**
   * v0.31 (eD4): tenancy axis for facts hot memory ops (extract_facts,
   * recall, forget_fact). When set, the OperationContext receives a
   * matching `sourceId`. CLI dispatch resolves this from --source flag /
   * VOLTMIND_SOURCE / .voltmind-source / 'default'; HTTP MCP transport
   * resolves it from the per-token allow-list (eE3).
   */
  sourceId?: string;
  /**
   * v0.31 (eD3): hook called by the dispatcher AFTER op.handler succeeds
   * to compute `_meta.brain_hot_memory` for the response. Wrapped in its
   * own try/catch (eE4) so a DB blip in the helper degrades to no _meta
   * rather than flipping the whole tool call to error.
   *
   * Returning undefined means "no _meta to inject"; the dispatcher
   * preserves the existing response shape.
   */
  metaHook?: (
    name: string,
    ctx: OperationContext,
  ) => Promise<Record<string, unknown> | undefined>;
  /**
   * OAuth auth info threaded through from the HTTP MCP transport. Set so
   * the whoami op (and any future scope-aware op handlers) can introspect
   * the calling identity. Without this, every whoami call from HTTP
   * transports throws unknown_transport — the v0.31 D12 / eE1 refactor
   * silently dropped this field when the inlined OperationContext literal
   * was replaced by dispatchToolCall.
   */
  auth?: AuthInfo;
  /**
   * v0.41.x stdio hardening: marks this dispatch as coming from the stdio
   * MCP transport (server.ts). When true, the dispatcher (a) enforces
   * `op.scope` against the stdio default scope set (admin / sources_admin /
   * users_admin / agent are denied by default) — closing the gap where
   * stdio MCP exposed every non-localOnly admin op because stdio has no
   * OAuth token to gate on, and (b) writes one `mcp_request_log` row per
   * tool call (success + every error path) with `token_name = NULL`,
   * `agent_name = 'stdio'` — stdio previously had zero audit coverage.
   *
   * Other transports opt out: serve-http does its own scope check + audit
   * (it has OAuth scopes to gate on); the legacy http-transport and the
   * local daemon keep their existing behavior. Default false preserves
   * both.
   */
  stdio?: boolean;
}

/** Execute database work with the request source installed transaction-locally. */
export function withOperationSourceScope<T>(
  engine: BrainEngine,
  sourceId: string,
  fn: (scopedEngine: BrainEngine) => Promise<T>,
): Promise<T>;
export function withOperationSourceScope<T>(
  engine: BrainEngine,
  sourceId: string,
  readSourceIds: string[],
  fn: (scopedEngine: BrainEngine) => Promise<T>,
): Promise<T>;
export async function withOperationSourceScope<T>(
  engine: BrainEngine,
  sourceId: string,
  readSourceIdsOrFn: string[] | ((scopedEngine: BrainEngine) => Promise<T>),
  maybeFn?: (scopedEngine: BrainEngine) => Promise<T>,
): Promise<T> {
  const readSourceIds = typeof readSourceIdsOrFn === 'function' ? [sourceId] : readSourceIdsOrFn;
  const fn = typeof readSourceIdsOrFn === 'function' ? readSourceIdsOrFn : maybeFn!;
  // PGLite has no RLS/session GUC. Validate the id through the engine parity
  // hook, then avoid wrapping handlers in a transaction: several operations
  // already own atomic subtransactions (notably put_page/importFromContent),
  // and PGLite does not support beginning a transaction from its tx object.
  if (engine.kind === 'pglite') {
    await engine.setSourceScope(sourceId);
    await engine.setSourceReadScope?.(readSourceIds);
    return fn(engine);
  }
  return engine.transaction(async (tx) => {
    await tx.setSourceScope(sourceId);
    await tx.setSourceReadScope?.(readSourceIds);
    return fn(tx);
  });
}

/**
 * Default capability scope granted to unauthenticated stdio MCP callers.
 *
 * stdio MCP has no per-token auth (local pipe), so unlike the HTTP path it
 * cannot gate on OAuth scopes. Pre-v0.41.x stdio exposed EVERY non-localOnly
 * operation — including 40+ admin-scope ops (submit_job, action_run,
 * schema_apply_mutations, get_ingest_log, get_recent_transcripts, …) — to any
 * local stdio client. That is the same trust posture the HTTP transport
 * explicitly rejects via `hasScope`.
 *
 * The default grants `read` + `write` (write implies read) so agents can
 * still read the brain and author pages, but DENIES admin / sources_admin /
 * users_admin / agent — matching the security-review finding that admin
 * ops must be opt-in, not default.
 *
 * Operators who need the legacy broad surface (e.g., a stdio wrapper that
 * triggers sync/embed jobs) set `VOLTMIND_MCP_STDIO_SCOPES` to a
 * space-separated scope list (e.g. `"read write admin"`). Read at call
 * time so a restart isn't required to tighten/loosen.
 */
export const STDIO_DEFAULT_SCOPES: ReadonlyArray<string> = Object.freeze(['read', 'write']);

/** Resolve the stdio caller's granted scopes, honoring the env override. */
export function resolveStdioScopes(): string[] {
  const raw = process.env.VOLTMIND_MCP_STDIO_SCOPES;
  if (!raw || !raw.trim()) return [...STDIO_DEFAULT_SCOPES];
  const parsed = raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : [...STDIO_DEFAULT_SCOPES];
}

/**
 * Best-effort `mcp_request_log` row for the stdio path. stdio has no token,
 * so `token_name` is NULL and `agent_name` is the literal `"stdio"` marker
 * (matches the audit-review ask: "token_name 留空或标记 stdio"). Params are
 * redacted via `summarizeMcpParams` — same privacy posture as the HTTP
 * transport (declared keys only, no values, no attacker-controlled key
 * names). Never throws; a DB blip must not flip a tool call to error.
 */
async function auditStdioRequest(
  engine: BrainEngine,
  name: string,
  status: 'success' | 'error',
  latencyMs: number,
  params: unknown,
  errorMessage?: string,
  sourceId?: string | null,
  brainId?: string | null,
): Promise<void> {
  try {
    const summary = summarizeMcpParams(name, params);
    // v0.42 (#861 audit follow-up): thread the resolved source_id + brain_id
    // so stdio audit rows carry the same tenant axis as the HTTP path.
    // sourceId comes from the stdio dispatch (VOLTMIND_SOURCE / 'default');
    // brainId is the resolved mount id. Both nullable for forward-compat
    // with transports that don't resolve them.
    const scopedSourceId = sourceId ?? 'default';
    await withOperationSourceScope(engine, scopedSourceId, [scopedSourceId], async (tx) => {
      await executeRawJsonb(
        tx,
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, source_id, brain_id, params)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [null, 'stdio', name, latencyMs, status, errorMessage ?? null, scopedSourceId, brainId ?? null],
        [summary],
      );
    });
  } catch { /* best-effort audit */ }
}

/**
 * Build a privacy-safe summary of MCP request params for logging + the admin
 * SSE feed.
 *
 * The previous default of `JSON.stringify(params)` wrote raw payloads —
 * page bodies, search queries, file paths — into `mcp_request_log` and
 * broadcast them to every connected admin browser. For a personal-knowledge
 * brain those payloads include private notes about real people / deals /
 * companies, retained indefinitely.
 *
 * The redactor returns the SHAPE of the request (what op was called, which
 * declared params were passed, approximate size) without any of the values.
 *
 * Hardening note (codex C8): a naive "dump all submitted keys" summary still
 * leaks via attacker-controlled key names — a caller can submit
 * `put_page {"wiki/people/sensitive_name": "..."}` and the key becomes a
 * persistent log entry. To prevent this, we intersect submitted keys
 * against the operation's declared `params` allow-list (the same definition
 * `validateParams` reads). Anything outside the allow-list is counted but
 * not named.
 *
 * Operators who want full payloads for debugging set `--log-full-params` on
 * `voltmind serve --http`; that path bypasses this helper and writes the raw
 * JSON, with a loud startup warning.
 */
export interface ParamSummary {
  redacted: true;
  kind: 'array' | 'object' | string;
  declared_keys?: string[];
  unknown_key_count?: number;
  length?: number;
  approx_bytes?: number;
}

/**
 * Round a byte count UP to the nearest 1KB so the redacted summary keeps a
 * coarse size signal without enabling a size-based side channel.
 *
 * Why bucketing matters: the previous shape published `approx_bytes` as the
 * exact JSON.stringify(params).length. An attacker who can submit
 * `put_page` with a known prefix and observe the resulting log entry
 * could binary-search the byte length of secret content (the body the
 * legitimate user just wrote) via repeated probes. Bucketing to 1KB
 * resolution destroys that channel while preserving the operator-useful
 * "roughly how large was the request" signal.
 */
function bucketBytes(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  const KB = 1024;
  return Math.ceil(n / KB) * KB;
}

export function summarizeMcpParams(opName: string, params: unknown): ParamSummary | null {
  if (params == null) return null;

  let approxBytes: number | undefined;
  try { approxBytes = bucketBytes(JSON.stringify(params).length); } catch { approxBytes = undefined; }

  if (Array.isArray(params)) {
    return {
      redacted: true,
      kind: 'array',
      length: params.length,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  if (typeof params === 'object') {
    const submittedKeys = Object.keys(params as Record<string, unknown>);
    const op = operations.find(o => o.name === opName);
    const allowList = op ? new Set(Object.keys(op.params)) : new Set<string>();
    const declared: string[] = [];
    let unknown = 0;
    for (const k of submittedKeys) {
      if (allowList.has(k)) declared.push(k);
      else unknown += 1;
    }
    declared.sort();
    return {
      redacted: true,
      kind: 'object',
      declared_keys: declared,
      unknown_key_count: unknown,
      ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
    };
  }

  return {
    redacted: true,
    kind: typeof params,
    ...(approxBytes !== undefined ? { approx_bytes: approxBytes } : {}),
  };
}

function validateParamValue(def: Operation['params'][string], value: unknown, path: string): string | null {
  if (def.type === 'string') {
    if (typeof value !== 'string') return `Parameter "${path}" must be a string`;
    if (def.enum && !def.enum.includes(value)) {
      return `Parameter "${path}" must be one of: ${def.enum.join(', ')}`;
    }
    return null;
  }
  if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `Parameter "${path}" must be a finite number`;
    }
    return null;
  }
  if (def.type === 'boolean') {
    return typeof value === 'boolean' ? null : `Parameter "${path}" must be a boolean`;
  }
  if (def.type === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? null
      : `Parameter "${path}" must be an object`;
  }
  if (!Array.isArray(value)) return `Parameter "${path}" must be an array`;
  if (def.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateParamValue(def.items, value[index], `${path}[${index}]`);
      if (error) return error;
    }
  }
  return null;
}

/**
 * Validate a tool call against the same closed ParamDef contract published by
 * tools/list. Unknown top-level fields are rejected; array items recurse.
 * JSON Schema's `default` annotation does not mutate instances, so omitted
 * optional fields remain omitted here as well.
 */
export function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const key of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(op.params, key)) {
      return `Unknown parameter: ${key}`;
    }
  }
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const error = validateParamValue(def, params[key], key);
      if (error) return error;
    }
  }
  return null;
}

/** Remove high-risk payloads before an unexpected exception reaches local audit/logs. */
export function sanitizeInternalErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    // Database statements commonly contain user content and identifiers.
    .replace(/\b(?:SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|WITH)\b[\s\S]*/gi, '<redacted-sql>')
    // Windows and POSIX absolute paths can reveal usernames and vault layout.
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n]*/g, '<redacted-path>')
    .replace(/\/(?:Users|home|var|tmp|etc|opt|srv)\/[^\r\n]*/g, '<redacted-path>')
    // Common credential and PII shapes.
    .replace(/\b(client_secret|password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<redacted-email>')
    .slice(0, 512);
}

const stderrLogger: OperationContext['logger'] = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
};

export function buildOperationContext(
  engine: BrainEngine,
  params: Record<string, unknown>,
  opts: DispatchOpts = {},
): OperationContext {
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: opts.logger || stderrLogger,
    dryRun: !!params.dry_run,
    remote: opts.remote ?? true,
    takesHoldersAllowList: opts.takesHoldersAllowList,
    // v0.34 D4: sourceId is REQUIRED at the type level. Auto-fill 'default'
    // for single-source brains and any caller who didn't resolve a sourceId.
    // CLI / HTTP / stdio transports SHOULD pass an explicit sourceId via opts;
    // this fallback covers code paths that historically passed undefined.
    sourceId: opts.sourceId ?? 'default',
    auth: opts.auth,
  };
}

/**
 * Resolve operation, validate params, build context, invoke handler, format result.
 *
 * Returns a `ToolResult` with the same shape both MCP transports need:
 * `{ content: [{ type: 'text', text }], isError?: boolean }`.
 */
export async function dispatchToolCall(
  engine: BrainEngine,
  name: string,
  params: Record<string, unknown> | undefined,
  opts: DispatchOpts = {},
): Promise<ToolResult> {
  const startedAt = Date.now();
  // stdio path: no OAuth auth, but still untrusted (server.ts sets remote=true).
  // Gate scope enforcement + audit on the explicit `stdio` flag so the legacy
  // http-transport and local-daemon dispatch callers keep their existing
  // behavior (their audit/scope stories are separate follow-ups).
  const isStdio = opts.stdio === true;
  // v0.42 (#861 audit follow-up): thread the resolved source_id + brain_id
  // into the stdio audit row so it carries the same tenant axis as the
  // HTTP path. sourceId comes from the stdio dispatch opts (server.ts sets
  // it from VOLTMIND_SOURCE || 'default'); brainId is the resolved mount id.
  // Resolved once per dispatchToolCall (resolveBrainId walks the filesystem
  // dotfile chain, so caching at call scope avoids repeating that per
  // audit-status callback within one call).
  const auditSourceId = isStdio ? (opts.sourceId ?? null) : null;
  const auditBrainId = isStdio ? resolveBrainId(null) : null;
  const audit = isStdio
    ? (status: 'success' | 'error', errorMessage?: string) =>
        auditStdioRequest(engine, name, status, Date.now() - startedAt, params, errorMessage, auditSourceId, auditBrainId)
    : undefined;

  const op = operations.find(o => o.name === name);
  if (!op) {
    // Always return JSON-shaped error content. v0.31 e2e tests
    // (sources-remote-mcp.test.ts) parse content via JSON.parse so a
    // plain `Error: ...` string here breaks the contract on every
    // unknown-op path and the resulting test failure looked like a
    // transport bug.
    await audit?.('error', `unknown_tool: ${name}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', message: `Unknown tool: ${name}` }, null, 2) }],
      isError: true,
    };
  }

  if (op.localOnly && (opts.remote ?? true) !== false) {
    await audit?.('error', `local_only: ${name}`);
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'operation_not_available', message: 'Operation ' + name + ' is local-only.' }, null, 2) }], isError: true };
  }

  // stdio scope enforcement (v0.41.x): stdio has no OAuth token, so it cannot
  // reuse the HTTP transport's `hasScope(authInfo.scopes, …)` gate. Without
  // this, every non-localOnly admin op (submit_job, action_run,
  // schema_apply_mutations, get_ingest_log, get_recent_transcripts, …) was
  // callable by any local stdio client. We gate against the configurable
  // stdio default scope set (read+write; admin/sources_admin/users_admin/
  // agent denied by default). HTTP is unaffected — it carries `opts.auth` and
  // serve-http.ts already enforced scope before calling us; the `stdio` flag
  // is what selects this branch.
  if (isStdio) {
    const requiredScope = op.scope || 'read';
    const grantedScopes = resolveStdioScopes();
    if (!hasScope(grantedScopes, requiredScope)) {
      await audit?.('error', `insufficient_scope: requires '${requiredScope}'`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'insufficient_scope',
            message: `Operation ${name} requires '${requiredScope}' scope`,
            your_scopes: grantedScopes,
          }, null, 2),
        }],
        isError: true,
      };
    }
  }

  const safeParams = params || {};
  const validationError = validateParams(op, safeParams);
  if (validationError) {
    // Do not persist attacker-controlled unknown key names in audit.
    await audit?.('error', 'invalid_params');
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }],
      isError: true,
    };
  }

  const ctx = buildOperationContext(engine, safeParams, opts);

  try {
    // A caller-supplied source_id on any mutating operation is an authority
    // assertion, never a hint. Reject mismatches before the handler can silently
    // fall back to the OAuth-bound personal source. Individual handlers still
    // resolve the id when they need to route a multi-source write explicitly.
    if (op.mutating && typeof safeParams.source_id === 'string') {
      resolveWriteSourceId(ctx, safeParams.source_id);
    }

    // Source authorization must be decided before opening a database
    // transaction. Besides avoiding unnecessary work for rejected requests,
    // this keeps the permission boundary independent from the engine surface
    // (and therefore fail-closed for malformed or unavailable engines).
    if (op.name === 'audit_frontmatter' && (opts.remote ?? true) !== false) {
      resolveReadSourceScope(ctx, typeof safeParams.source_id === 'string' ? safeParams.source_id : undefined);
    }

    const readSourceIds = ctx.auth?.allowedSources && ctx.auth.allowedSources.length > 0
      ? ctx.auth.allowedSources
      : [ctx.sourceId];
    const out = await withOperationSourceScope(engine, ctx.sourceId, readSourceIds, async (tx) => {
      const scopedCtx: OperationContext = { ...ctx, engine: tx };
      const result = await op.handler(scopedCtx, safeParams);
      const scopedOut: ToolResult = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      // Keep the meta hook in the same scoped transaction. Restricted
      // Postgres roles otherwise see an unset GUC and fail closed here.
      if (opts.metaHook) {
        try {
          const meta = await opts.metaHook(name, scopedCtx);
          if (meta && Object.keys(meta).length > 0) scopedOut._meta = meta;
        } catch (metaErr) {
          const msg = sanitizeInternalErrorMessage(metaErr);
          scopedCtx.logger.warn(`[mcp] _meta hook failed for ${name}: ${msg}; degrading to no-_meta`);
        }
      }
      return scopedOut;
    });
    await audit?.('success');
    return out;
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      const safeMessage = sanitizeInternalErrorMessage(e.message);
      const safeSuggestion = e.suggestion ? sanitizeInternalErrorMessage(e.suggestion) : undefined;
      const safeDocs = e.docs ? sanitizeInternalErrorMessage(e.docs) : undefined;
      await audit?.('error', `${e.code}: ${safeMessage}`);
      const payload = opts.remote === false
        ? e.toJSON()
        : { error: e.code, message: safeMessage, suggestion: safeSuggestion, docs: safeDocs };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
    }
    // Non-OperationError (uncaught throws) — wrap in the same shape so
    // every error response is JSON-parseable. The pre-v0.31 path emitted
    // plain `Error: ${msg}` strings here, which broke any caller that
    // tried JSON.parse(content).
    const requestId = randomUUID();
    const safeMessage = sanitizeInternalErrorMessage(e);
    ctx.logger.error(`[mcp] internal_error request_id=${requestId}: ${safeMessage}`);
    await audit?.('error', `internal_error request_id=${requestId}: ${safeMessage}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'internal_error', request_id: requestId }, null, 2) }],
      isError: true,
    };
  }
}

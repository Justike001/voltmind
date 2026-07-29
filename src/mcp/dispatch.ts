/**
 * Shared MCP tool-call dispatch — single source of truth for stdio + HTTP transports.
 *
 * Both transports validate the same params, build the same OperationContext shape,
 * and serialize errors identically. Drift between transports caused PR #483's reversed-args
 * + missing-context bugs; this module exists to prevent that recurring.
 */

import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError, resolveWriteSourceId } from '../core/operations.ts';
import type { Operation, OperationContext, AuthInfo } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { hasScope } from '../core/scope.ts';
import { executeRawJsonb } from '../core/sql-query.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';

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
function auditStdioRequest(
  engine: BrainEngine,
  name: string,
  status: 'success' | 'error',
  latencyMs: number,
  params: unknown,
  errorMessage?: string,
  sourceId?: string | null,
  brainId?: string | null,
): void {
  try {
    const summary = summarizeMcpParams(name, params);
    // v0.42 (#861 audit follow-up): thread the resolved source_id + brain_id
    // so stdio audit rows carry the same tenant axis as the HTTP path.
    // sourceId comes from the stdio dispatch (VOLTMIND_SOURCE / 'default');
    // brainId is the resolved mount id. Both nullable for forward-compat
    // with transports that don't resolve them.
    void executeRawJsonb(
      engine,
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, source_id, brain_id, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [null, 'stdio', name, latencyMs, status, errorMessage ?? null, sourceId ?? null, brainId ?? null],
      [summary],
    ).catch(() => { /* best-effort audit */ });
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

/** Validate required params exist and have the expected type. Returns null on success, error message on failure. */
export function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
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
    audit?.('error', `unknown_tool: ${name}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', message: `Unknown tool: ${name}` }, null, 2) }],
      isError: true,
    };
  }

  if (op.localOnly && (opts.remote ?? true) !== false) {
    audit?.('error', `local_only: ${name}`);
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
      audit?.('error', `insufficient_scope: requires '${requiredScope}'`);
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
    audit?.('error', `invalid_params: ${validationError}`);
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

    const result = await op.handler(ctx, safeParams);
    const out: ToolResult = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    // v0.31 (eD3 + eE4): best-effort _meta.brain_hot_memory injection.
    // The hook is wrapped in its own try/catch — any DB blip / cache miss /
    // helper crash degrades to no `_meta` rather than flipping the whole
    // tool call to error.
    if (opts.metaHook) {
      try {
        const meta = await opts.metaHook(name, ctx);
        if (meta && Object.keys(meta).length > 0) out._meta = meta;
      } catch (metaErr) {
        const msg = metaErr instanceof Error ? metaErr.message : String(metaErr);
        ctx.logger.warn(`[mcp] _meta hook failed for ${name}: ${msg}; degrading to no-_meta`);
      }
    }
    audit?.('success');
    return out;
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      audit?.('error', `${e.code}: ${e.message}`);
      return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
    }
    // Non-OperationError (uncaught throws) — wrap in the same shape so
    // every error response is JSON-parseable. The pre-v0.31 path emitted
    // plain `Error: ${msg}` strings here, which broke any caller that
    // tried JSON.parse(content).
    const msg = e instanceof Error ? e.message : String(e);
    audit?.('error', `internal_error: ${msg}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'internal_error', message: msg }, null, 2) }],
      isError: true,
    };
  }
}

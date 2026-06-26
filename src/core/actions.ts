import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import matter from 'gray-matter';
import type { BrainEngine } from './engine.ts';
import type { SearchResult } from './types.ts';
import type { DispatchOpts, ToolResult } from '../mcp/dispatch.ts';
import { parseMarkdown } from './markdown.ts';
import { resolveSourceId } from './source-resolver.ts';
import {
  DefaultActionRunner,
  type ActionRunStatus as RunnerActionRunStatus,
  type OutcomeSummary,
} from './action-runner.ts';
import {
  buildUserActionToolRoute,
  normalizeActionToolRoute,
  renderActionToolRouteForPrompt,
  routeActionTools,
  type ActionToolRoute,
} from './action-tool-router.ts';
import { scanPluginRegistry, type PluginRegistry } from './plugin-registry.ts';

export type ActionRiskLevel = 'low' | 'medium' | 'high' | 'restricted';
export type ActionMode = 'manual' | 'agent_assisted' | 'agent_executable';
export type ActionRunStatus = 'prepared' | 'blocked' | 'failed';

export interface ActionRelatedContext {
  related_people: string[];
  related_project: string | null;
  related_systems: string[];
  related_entities: string[];
  related_projects: string[];
  related_workstream: string | null;
}

export interface ActionRecord {
  source_id: string;
  slug: string;
  title: string;
  status: string;
  priority: string | null;
  due_at: string | null;
  eligible: boolean;
  mode: ActionMode | string;
  runtime: string | null;
  trigger: string | null;
  risk_level: ActionRiskLevel;
  requires_confirmation: boolean;
  requires_approval: boolean;
  max_autonomy: string | null;
  approved_at: string | null;
  approved_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  outcome: string | null;
  next_step: string | null;
  agent_contract: Record<string, unknown>;
  automation: Record<string, unknown>;
  allowed_tools: string[];
  blocked_tools: string[];
  related_context: ActionRelatedContext;
  agent: string | null;
  skill: string | null;
  user_prompt: string | null;
  tool_route: ActionToolRoute | null;
  file_path: string | null;
  updated_at: string;
  urgency_score?: number;
  elapsed_ms?: number | null;
  last_run?: ActionRunRecord | null;
}

export interface ActionRunRecord {
  id: number;
  source_id: string;
  action_slug: string;
  idempotency_key: string;
  status: ActionRunStatus | string;
  dry_run: boolean;
  prompt: string;
  user_prompt: string | null;
  result: Record<string, unknown> | null;
  error_text: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface RunActionResult {
  action: ActionRecord;
  run: ActionRunRecord;
  allowed: boolean;
  reason?: string;
  prompt?: string;
  status?: ActionRunStatus | RunnerActionRunStatus;
  outcome?: OutcomeSummary | null;
}

interface ParsedAction {
  sourceId: string;
  slug: string;
  title: string;
  status: string;
  priority: string | null;
  dueAt: string | null;
  eligible: boolean;
  mode: string;
  runtime: string | null;
  trigger: string | null;
  riskLevel: ActionRiskLevel;
  requiresConfirmation: boolean;
  requiresApproval: boolean;
  maxAutonomy: string | null;
  outcome: string | null;
  nextStep: string | null;
  agentContract: Record<string, unknown>;
  automation: Record<string, unknown>;
  allowedTools: string[];
  blockedTools: string[];
  relatedContext: ActionRelatedContext;
  filePath: string;
  contentHash: string;
}

interface ActionScanRoot {
  root: string;
  slugBase: string;
}

const ACTIONS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS action_index (
    source_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT,
    due_at TIMESTAMPTZ,
    eligible BOOLEAN NOT NULL DEFAULT false,
    mode TEXT NOT NULL DEFAULT 'manual',
    runtime TEXT,
    trigger TEXT,
    risk_level TEXT NOT NULL DEFAULT 'medium',
    requires_confirmation BOOLEAN NOT NULL DEFAULT true,
    requires_approval BOOLEAN NOT NULL DEFAULT false,
    max_autonomy TEXT,
    outcome TEXT,
    next_step TEXT,
    agent_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
    automation JSONB NOT NULL DEFAULT '{}'::jsonb,
    allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    blocked_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    related_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    user_prompt TEXT,
    file_path TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    approved_at TIMESTAMPTZ,
    approved_by TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_run_status TEXT,
    plan_json JSONB,
    tool_route_json JSONB,
    last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_action_index_due ON action_index (due_at) WHERE eligible = true`,
  `CREATE INDEX IF NOT EXISTS idx_action_index_status ON action_index (status)`,
  `CREATE TABLE IF NOT EXISTS action_runs (
    id SERIAL PRIMARY KEY,
    source_id TEXT NOT NULL,
    action_slug TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    dry_run BOOLEAN NOT NULL DEFAULT false,
    prompt TEXT NOT NULL,
    user_prompt TEXT,
    result JSONB,
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    UNIQUE (source_id, action_slug, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_action_runs_action ON action_runs (source_id, action_slug, created_at DESC)`,
];

export async function ensureActionSchema(engine: BrainEngine): Promise<void> {
 for (const sql of ACTIONS_SCHEMA_SQL) {
   await engine.executeRaw(sql);
 }
  // Add outcome/next_step columns if missing (migration for existing brains)
  try { await engine.executeRaw(`ALTER TABLE action_index ADD COLUMN outcome TEXT`); } catch (_) {}
  try { await engine.executeRaw(`ALTER TABLE action_index ADD COLUMN next_step TEXT`); } catch (_) {}
  try { await engine.executeRaw(`ALTER TABLE action_index ADD COLUMN plan_json JSONB`); } catch (_) {}
  try { await engine.executeRaw(`ALTER TABLE action_index ADD COLUMN tool_route_json JSONB`); } catch (_) {}
  try { await engine.executeRaw(`ALTER TABLE action_index ADD COLUMN started_at TIMESTAMPTZ`); } catch (_) {}
  try { await engine.executeRaw(`ALTER TABLE action_index ADD COLUMN completed_at TIMESTAMPTZ`); } catch (_) {}
  try { await engine.executeRaw(`ALTER TABLE action_index ADD COLUMN archived_at TIMESTAMPTZ`); } catch (_) {}
  try { await engine.executeRaw(`ALTER TABLE action_index ADD COLUMN related_context JSONB NOT NULL DEFAULT '{}'::jsonb`); } catch (_) {}
  // Ensure status constraint includes runtime and scheduling states.
  try {
    await engine.executeRaw(`
      UPDATE action_index
         SET status = CASE
           WHEN lower(status) = 'active' THEN 'in_progress'
           WHEN lower(status) IN ('complete','completed') THEN 'done'
           WHEN lower(status) = 'cancelled' THEN 'canceled'
           WHEN lower(status) IN ('scheduled','on schedule','on-schedule') THEN 'on_schedule'
           WHEN lower(status) IN ('pending','waiting') THEN 'open'
           WHEN lower(status) IN ('open','on_schedule','in_progress','done','blocked','canceled','failed','needs_confirmation','needs_approval') THEN lower(status)
           ELSE 'open'
         END
       WHERE status IS NOT NULL
    `);
    await engine.executeRaw(`ALTER TABLE action_index DROP CONSTRAINT IF EXISTS action_index_status_check`);
    await engine.executeRaw(`ALTER TABLE action_index ADD CONSTRAINT action_index_status_check CHECK (status IN ('open','on_schedule','in_progress','done','blocked','canceled','failed','needs_confirmation','needs_approval'))`);
  } catch (_) {}
}

export async function resolveActionRepoPath(engine: BrainEngine, repoArg?: string | null): Promise<string> {
  const { repo } = await resolveActionTarget(engine, { repo: repoArg });
  return repo;
}

async function resolveActionTarget(
  engine: BrainEngine,
  opts: { repo?: string | null; sourceId?: string } = {},
): Promise<{ repo: string; sourceId: string }> {
  const sourceId = opts.sourceId || await resolveSourceId(engine, null);
  const sourceRows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [sourceId],
  );
  const repoPath = opts.repo ||
    process.env.VOLTMIND_ACTIONS_REPO ||
    await engine.getConfig('sync.repo_path') ||
    inferActionRepoFromHome() ||
    sourceRows[0]?.local_path;
  if (!repoPath) {
    throw new Error('No brain repo path configured. Run `voltmind config set sync.repo_path <path>`, set VOLTMIND_ACTIONS_REPO, or pass --repo <path>.');
  }
  return { repo: repoPath, sourceId };
}

export async function scanActions(
  engine: BrainEngine,
  opts: { repo?: string | null; sourceId?: string; now?: Date } = {},
): Promise<{ scanned: number; indexed: number; removed: number; source_id: string; repo: string; actions_dir: string | null }> {
  await ensureActionSchema(engine);
  const { repo, sourceId } = await resolveActionTarget(engine, { repo: opts.repo, sourceId: opts.sourceId });
  const scanRoot = resolveActionScanRoot(repo);
  if (!scanRoot) {
    const removed = await pruneStaleActionIndex(engine, sourceId, []);
    return { scanned: 0, indexed: 0, removed, source_id: sourceId, repo, actions_dir: null };
  }
  const files = await listMarkdownFiles(scanRoot.root);
  const pluginRegistry = await scanPluginRegistry().catch(() => null);
  let indexed = 0;
  const indexedFilePaths: string[] = [];
  for (const file of files) {
    if (basename(file).toLowerCase() === 'readme.md') continue;
    const raw = await readFile(file, 'utf-8');
    const parsed = parseActionFile(raw, file, scanRoot.slugBase, sourceId);
    await upsertAction(engine, parsed);
    await refreshActionToolRouteBestEffort(engine, parsed.slug, sourceId, pluginRegistry, opts.now);
    indexedFilePaths.push(file);
    indexed++;
  }
  const removed = await pruneStaleActionIndex(engine, sourceId, indexedFilePaths);
  return { scanned: files.length, indexed, removed, source_id: sourceId, repo, actions_dir: scanRoot.root };
}

export async function listActions(
  engine: BrainEngine,
  opts: { status?: string; risk?: string; dueOnly?: boolean; limit?: number; sourceId?: string; allSources?: boolean } = {},
): Promise<ActionRecord[]> {
  await ensureActionSchema(engine);
  const params: unknown[] = [];
  const where: string[] = [];
  if (!opts.allSources) {
    params.push(opts.sourceId || await resolveSourceId(engine, null));
    where.push(`source_id = $${params.length}`);
  } else if (opts.sourceId) {
    params.push(opts.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.risk) {
    params.push(opts.risk);
    where.push(`risk_level = $${params.length}`);
  }
  if (opts.dueOnly) {
    where.push(`due_at IS NOT NULL AND due_at <= now()`);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  params.push(limit);
  const rows = await engine.executeRaw<ActionRecord>(
    `SELECT source_id, slug, title, status, priority,
            due_at::text, eligible, mode, runtime, trigger, risk_level,
            requires_confirmation, requires_approval, max_autonomy,
            approved_at::text, approved_by, started_at::text, completed_at::text,
            archived_at::text, last_run_at::text, last_run_status,
            agent_contract, automation, allowed_tools, blocked_tools, related_context, user_prompt,
            tool_route_json AS tool_route, outcome, next_step, file_path, updated_at::text
       FROM action_index
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY due_at ASC NULLS LAST, updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(normalizeActionRow).sort(compareActionsByUrgency);
}

export async function getAction(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<ActionRecord | null> {
  await ensureActionSchema(engine);
  const rows = await engine.executeRaw<ActionRecord>(
    `SELECT source_id, slug, title, status, priority,
            due_at::text, eligible, mode, runtime, trigger, risk_level,
            requires_confirmation, requires_approval, max_autonomy,
            approved_at::text, approved_by, started_at::text, completed_at::text,
            archived_at::text, last_run_at::text, last_run_status,
            agent_contract, automation, allowed_tools, blocked_tools, related_context, user_prompt,
            tool_route_json AS tool_route, outcome, next_step, file_path, updated_at::text
       FROM action_index
      WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug],
  );
  if (rows[0]) return normalizeActionRow(rows[0]);
  if (sourceId !== 'default') return null;

  const fallbackRows = await engine.executeRaw<ActionRecord>(
    `SELECT source_id, slug, title, status, priority,
            due_at::text, eligible, mode, runtime, trigger, risk_level,
            requires_confirmation, requires_approval, max_autonomy,
            approved_at::text, approved_by, started_at::text, completed_at::text,
            archived_at::text, last_run_at::text, last_run_status,
            agent_contract, automation, allowed_tools, blocked_tools, related_context, user_prompt,
            tool_route_json AS tool_route, outcome, next_step, file_path, updated_at::text
       FROM action_index
      WHERE slug = $1
      ORDER BY source_id ASC
      LIMIT 2`,
    [slug],
  );
  return fallbackRows.length === 1 ? normalizeActionRow(fallbackRows[0]) : null;
}

export async function approveAction(
  engine: BrainEngine,
  slug: string,
  opts: { sourceId?: string; approvedBy?: string } = {},
): Promise<ActionRecord> {
  await ensureActionSchema(engine);
  await engine.executeRaw(
    `UPDATE action_index
        SET approved_at = now(), approved_by = $3, updated_at = now()
      WHERE source_id = $1 AND slug = $2`,
    [opts.sourceId || 'default', slug, opts.approvedBy || 'local-admin'],
  );
  const action = await getAction(engine, slug, opts.sourceId || 'default');
  if (!action) throw new Error(`Action not found: ${slug}`);
  return action;
}

export async function updateActionStatus(
  engine: BrainEngine,
  slug: string,
  status: string,
  opts: { sourceId?: string; note?: string } = {},
): Promise<ActionRecord> {
  await ensureActionSchema(engine);
  const normalizedStatus = normalizeActionStatus(status);
  const sourceId = opts.sourceId || 'default';
  const action = await getAction(engine, slug, sourceId);
  if (!action) throw new Error(`Action not found: ${slug}`);
  if (action.file_path) {
    await updateActionMarkdownStatus(action.file_path, normalizedStatus, opts.note);
  }
  const doneFields = normalizedStatus === 'done'
    ? ', completed_at = COALESCE(completed_at, now()), archived_at = COALESCE(archived_at, now())'
    : '';
  const startedFields = normalizedStatus === 'in_progress'
    ? ', started_at = COALESCE(started_at, now())'
    : '';
  await engine.executeRaw(
    `UPDATE action_index
        SET status = $3, updated_at = now()${doneFields}${startedFields}
      WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug, normalizedStatus],
  );
  return (await getAction(engine, slug, sourceId))!;
}

export async function unarchiveAction(
  engine: BrainEngine,
  slug: string,
  opts: { sourceId?: string; note?: string } = {},
): Promise<ActionRecord> {
  await ensureActionSchema(engine);
  const sourceId = opts.sourceId || 'default';
  const action = await getAction(engine, slug, sourceId);
  if (!action) throw new Error(`Action not found: ${slug}`);
  if (action.status !== 'done') {
    throw new Error(`Action '${slug}' is not archived (status=${action.status}). Only done actions can be unarchived.`);
  }
  if (action.file_path) {
    await updateActionMarkdownStatus(action.file_path, 'open', opts.note || 'Unarchived from admin UI.');
  }
  await engine.executeRaw(
    `UPDATE action_index
        SET status = 'open', updated_at = now(),
            completed_at = NULL, archived_at = NULL
      WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug],
  );
  return (await getAction(engine, slug, sourceId))!;
}

export async function updateActionFields(
  engine: BrainEngine,
  slug: string,
  fields: { sourceId?: string; dueAt?: string | null; userPrompt?: string | null; mode?: string | null; priority?: string | null },
): Promise<ActionRecord> {
  await ensureActionSchema(engine);
  const sourceId = fields.sourceId || 'default';
  const action = await getAction(engine, slug, sourceId);
  if (!action) throw new Error(`Action not found: ${slug}`);
  const normalizedDue = fields.dueAt === undefined ? undefined : parseDueAt(fields.dueAt, null);
  const normalizedMode = fields.mode === undefined ? undefined : normalizeMode(fields.mode || 'manual').mode;
  const normalizedPriority = fields.priority === undefined ? undefined : normalizePriority(fields.priority);
  if (action.file_path) {
    if (normalizedDue !== undefined) await updateActionMarkdownDue(action.file_path, normalizedDue);
    if (normalizedMode !== undefined) await updateActionMarkdownMode(action.file_path, normalizedMode);
    if (normalizedPriority !== undefined) await updateActionMarkdownPriority(action.file_path, normalizedPriority);
  }
  await engine.executeRaw(
    `UPDATE action_index
        SET due_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE due_at END,
            user_prompt = CASE WHEN $5::boolean THEN $6 ELSE user_prompt END,
            mode = CASE WHEN $7::boolean THEN $8 ELSE mode END,
            priority = CASE WHEN $9::boolean THEN $10 ELSE priority END,
            updated_at = now()
      WHERE source_id = $1 AND slug = $2`,
    [
      sourceId,
      slug,
      fields.dueAt !== undefined,
      normalizedDue,
      fields.userPrompt !== undefined,
      fields.userPrompt ?? null,
      fields.mode !== undefined,
      normalizedMode ?? null,
      fields.priority !== undefined,
      normalizedPriority,
    ],
  );
  return (await getAction(engine, slug, sourceId))!;
}

export async function regenerateActionToolRoute(
  engine: BrainEngine,
  slug: string,
  opts: { sourceId?: string; now?: Date; allowLlm?: boolean; pluginProviders?: string[]; includeAllPlugins?: boolean } = {},
): Promise<ActionToolRoute> {
  await ensureActionSchema(engine);
  const sourceId = opts.sourceId || 'default';
  const action = await getAction(engine, slug, sourceId);
  if (!action) throw new Error(`Action not found: ${slug}`);
  const route = await routeActionTools(action, {
    allowLlm: opts.allowLlm ?? true,
    pluginProviders: opts.pluginProviders,
    includeAllPlugins: opts.includeAllPlugins,
    now: opts.now,
  });
  await saveActionToolRouteJson(engine, slug, action.source_id || sourceId, route);
  return route;
}

export async function saveUserActionToolRoute(
  engine: BrainEngine,
  slug: string,
  input: {
    sourceId?: string;
    selectedPlugins?: string[];
    selectedTools?: string[];
    blockedTools?: string[];
    notes?: string;
  },
): Promise<ActionRecord> {
  await ensureActionSchema(engine);
  const sourceId = input.sourceId || 'default';
  const action = await getAction(engine, slug, sourceId);
  if (!action) throw new Error(`Action not found: ${slug}`);
  const base = action.tool_route ?? await routeActionTools(action, { allowLlm: false }).catch(() => null);
  const route = buildUserActionToolRoute(base, {
    selected_plugins: input.selectedPlugins,
    selected_tools: input.selectedTools,
    blocked_tools: input.blockedTools,
    notes: input.notes,
  });
  // Only sync route-selected tools to the action's allowed_tools when the user
  // explicitly chose them. Clearing the selection should preserve whatever
  // allowlist the frontmatter already had, not overwrite it with [] (which
  // would widen the scope to "all tools available" in the harness prompt).
  const selectedTools = route.selected_tools.length > 0
    ? route.selected_tools
    : action.allowed_tools;
  const blockedTools = route.blocked_tools;
  if (action.file_path) {
    await updateActionMarkdownTools(action.file_path, selectedTools, blockedTools);
  }
  await engine.executeRaw(
    `UPDATE action_index
        SET tool_route_json = $3::jsonb,
            allowed_tools = $4::jsonb,
            blocked_tools = $5::jsonb,
            updated_at = now()
      WHERE source_id = $1 AND slug = $2`,
    [action.source_id || sourceId, slug, JSON.stringify(route), JSON.stringify(selectedTools), JSON.stringify(blockedTools)],
  );
  return (await getAction(engine, slug, action.source_id || sourceId))!;
}

export async function runAction(
  engine: BrainEngine,
  slug: string,
  opts: { sourceId?: string; dryRun?: boolean; now?: boolean; userPrompt?: string | null; execute?: boolean; force?: boolean; confirmed?: boolean; interactive?: boolean } = {},
): Promise<RunActionResult> {
  await ensureActionSchema(engine);
  const sourceId = opts.sourceId || 'default';
  const action = await getAction(engine, slug, sourceId);
  if (!action) throw new Error(`Action not found: ${slug}`);
  const resolvedSourceId = action.source_id || sourceId;

  // ── New execution path: route to DefaultActionRunner ──
  if (opts.execute && ['agent_assisted', 'agent_executable'].includes(action.mode)) {
    const runner = new DefaultActionRunner();
    const actionForRun = opts.interactive
      ? { ...action, runtime: 'codex_interactive' }
      : action;
    const runnerResult = await runner.run({
      action: actionForRun,
      engine,
      options: {
       execute: true,
       dryRun: opts.dryRun ?? false,
       userPrompt: opts.userPrompt ?? undefined,
       force: opts.force ?? false,
       confirmed: opts.confirmed ?? false,
      },
    });

    // Build a compatible return value for the legacy caller
    const idempotencyKey = buildRunIdempotencyKey(action);
    const dbStatus = runnerResult.status === 'needs_confirmation' ? 'needs_confirmation' : runnerResult.status === 'needs_approval' ? 'needs_approval' : runnerResult.allowed ? 'prepared' : 'blocked';
    const prompt = runnerResult.prompt ?? buildActionPrompt(actionForRun, opts.userPrompt || action.user_prompt || null);
    const result = runnerResult.outcome
      ? runnerResult.outcome
      : { kind: runnerResult.allowed ? 'executed' : runnerResult.status, reason: runnerResult.reason };

    const rows = await engine.executeRaw<ActionRunRecord>(
      `INSERT INTO action_runs (source_id, action_slug, idempotency_key, status, dry_run, prompt, user_prompt, result, error_text, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())
       ON CONFLICT (source_id, action_slug, idempotency_key)
       DO UPDATE SET
         status = EXCLUDED.status,
         dry_run = EXCLUDED.dry_run,
         prompt = EXCLUDED.prompt,
         user_prompt = EXCLUDED.user_prompt,
         result = EXCLUDED.result,
         error_text = EXCLUDED.error_text,
         finished_at = now()
       RETURNING id, source_id, action_slug, idempotency_key, status, dry_run, prompt, user_prompt,
                 result, error_text, created_at::text, finished_at::text`,
      [resolvedSourceId, slug, idempotencyKey, dbStatus, !!(opts.dryRun), prompt, opts.userPrompt || null, JSON.stringify(result), runnerResult.reason || null],
    );
    await engine.executeRaw(
      `UPDATE action_index
          SET last_run_at = now(), last_run_status = $3, user_prompt = COALESCE($4, user_prompt),
              started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE source_id = $1 AND slug = $2`,
      [resolvedSourceId, slug, dbStatus, opts.userPrompt || null],
    );
    // Update the action_runs row with the final execution result
    if (runnerResult.status === 'executed' || runnerResult.status === 'failed' || runnerResult.status === 'interactive_handoff') {
      await engine.executeRaw(
        `UPDATE action_runs
            SET status = $1, result = $2::jsonb, error_text = $3, finished_at = now()
          WHERE id = $4`,
        [
          runnerResult.status === 'executed' ? 'completed' : runnerResult.status,
          JSON.stringify(runnerResult.outcome ?? {}),
          runnerResult.status === 'failed' ? (runnerResult.reason ?? '') : null,
          rows[0].id,
        ],
      );
    }

    const enriched = {
      action,
      run: rows[0],
      allowed: runnerResult.allowed,
      reason: runnerResult.reason,
      status: runnerResult.status,
      outcome: runnerResult.outcome ?? null,
      prompt: runnerResult.prompt ?? undefined,
    };
    return enriched;
  }

  // ── Legacy draft_only path ──
  const gate = evaluateActionPolicy(action, {});
  const prompt = buildActionPrompt(action, opts.userPrompt || action.user_prompt || null);
  const idempotencyKey = buildRunIdempotencyKey(action);
  const status: ActionRunStatus = gate.allowed ? 'prepared' : 'blocked';
  const result = gate.allowed
    ? {
        kind: 'draft_only',
        message: 'Prepared an execution prompt. No browser, email, or external side effect was performed.',
      }
    : { kind: 'blocked', reason: gate.reason };

  const rows = await engine.executeRaw<ActionRunRecord>(
    `INSERT INTO action_runs (source_id, action_slug, idempotency_key, status, dry_run, prompt, user_prompt, result, error_text, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())
     ON CONFLICT (source_id, action_slug, idempotency_key)
     DO UPDATE SET
       status = EXCLUDED.status,
       dry_run = EXCLUDED.dry_run,
       prompt = EXCLUDED.prompt,
       user_prompt = EXCLUDED.user_prompt,
       result = EXCLUDED.result,
       error_text = EXCLUDED.error_text,
       finished_at = now()
     RETURNING id, source_id, action_slug, idempotency_key, status, dry_run, prompt, user_prompt,
               result, error_text, created_at::text, finished_at::text`,
    [resolvedSourceId, slug, idempotencyKey, status, !!opts.dryRun, prompt, opts.userPrompt || null, JSON.stringify(result), gate.reason || null],
  );
  await engine.executeRaw(
    `UPDATE action_index
        SET last_run_at = now(), last_run_status = $3, user_prompt = COALESCE($4, user_prompt),
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE source_id = $1 AND slug = $2`,
    [resolvedSourceId, slug, status, opts.userPrompt || null],
  );
  return { action, run: rows[0], allowed: gate.allowed, reason: gate.reason, prompt };
}

export async function listActionRuns(
  engine: BrainEngine,
  slug: string,
  opts: { sourceId?: string; limit?: number } = {},
): Promise<ActionRunRecord[]> {
  await ensureActionSchema(engine);
  const rows = await engine.executeRaw<ActionRunRecord>(
    `SELECT id, source_id, action_slug, idempotency_key, status, dry_run, prompt, user_prompt,
            result, error_text, created_at::text, finished_at::text
       FROM action_runs
      WHERE source_id = $1 AND action_slug = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [opts.sourceId || 'default', slug, Math.max(1, Math.min(opts.limit ?? 20, 100))],
  );
  return rows;
}

export async function listArchivedActions(
  engine: BrainEngine,
  opts: { sourceId?: string; limit?: number; allSources?: boolean } = {},
): Promise<ActionRecord[]> {
  await ensureActionSchema(engine);
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200));
  const params: unknown[] = [];
  const where: string[] = [];
  // Match listActions behaviour: allSources skips source_id filter.
  const allSources = opts.allSources === true;
  const noSourceFilter = allSources && !opts.sourceId;
  if (!noSourceFilter) {
    params.push(opts.sourceId || await resolveSourceId(engine, null));
    where.push(`source_id = $${params.length}`);
  }
  where.push(`status = 'done'`);
  params.push(limit);
  const rows = await engine.executeRaw<ActionRecord>(
    `SELECT source_id, slug, title, status, priority,
            due_at::text, eligible, mode, runtime, trigger, risk_level,
            requires_confirmation, requires_approval, max_autonomy,
            approved_at::text, approved_by, started_at::text, completed_at::text,
            archived_at::text, last_run_at::text, last_run_status,
            agent_contract, automation, allowed_tools, blocked_tools, related_context, user_prompt,
            tool_route_json AS tool_route, outcome, next_step, file_path, updated_at::text,
            CASE
              WHEN completed_at IS NOT NULL AND started_at IS NOT NULL THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
              ELSE NULL
            END::bigint as elapsed_ms
       FROM action_index
      WHERE ${where.join(' AND ')}
      ORDER BY archived_at DESC NULLS LAST, completed_at DESC NULLS LAST, updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const normalized = rows.map(normalizeActionRow);
  for (const row of normalized) {
    const runs = await listActionRuns(engine, row.slug, { sourceId: row.source_id, limit: 1 });
    row.last_run = runs[0] || null;
  }
  return normalized;
}

export interface ActionPolicyResult {
  allowed: boolean;
  reason?: string;
  requiresApproval: boolean;
  requiresConfirmation: boolean;
}

export function evaluateActionPolicy(
  action: ActionRecord,
  opts: { force?: boolean; requireConfirmation?: boolean } = {},
): ActionPolicyResult {
  // ── Approval checks (NEVER skipped by force) ──

  if (action.risk_level === 'high' || action.risk_level === 'restricted') {
    return { allowed: false, reason: `risk_level ${action.risk_level} requires human review`, requiresApproval: true, requiresConfirmation: false };
  }

  if (action.requires_approval && !action.approved_at) {
    return { allowed: false, reason: 'action requires approval', requiresApproval: true, requiresConfirmation: false };
  }

  if (action.risk_level === 'medium' && !action.approved_at) {
    return { allowed: false, reason: 'medium risk action requires approval', requiresApproval: true, requiresConfirmation: false };
  }

  // ── Confirmation checks (NEVER skipped by force) ──

  if (action.requires_confirmation && opts.requireConfirmation !== false) {
    return { allowed: false, reason: 'action requires confirmation', requiresApproval: false, requiresConfirmation: true };
  }

  // ── Non-approval gates (SKIPPED by force) ──

  const skipNonApproval = opts.force ?? false;

  if (!skipNonApproval && !action.eligible) {
    return { allowed: false, reason: 'automation.eligible is not true', requiresApproval: false, requiresConfirmation: false };
  }

  if (!skipNonApproval && !['open', 'on_schedule', 'in_progress'].includes(action.status)) {
    return { allowed: false, reason: `status is ${action.status}`, requiresApproval: false, requiresConfirmation: false };
  }

  if (!skipNonApproval && !['agent_assisted', 'agent_executable'].includes(action.mode)) {
    return { allowed: false, reason: `mode ${action.mode} is not executable`, requiresApproval: false, requiresConfirmation: false };
  }

  if (!skipNonApproval && action.max_autonomy && !['draft_only', 'single_step'].includes(action.max_autonomy)) {
    return { allowed: false, reason: `max_autonomy ${action.max_autonomy} exceeds boundary`, requiresApproval: false, requiresConfirmation: false };
  }

  if (!skipNonApproval && action.due_at && new Date(action.due_at).getTime() > Date.now()) {
    return { allowed: false, reason: 'action is not due yet', requiresApproval: false, requiresConfirmation: false };
  }

  return { allowed: true, requiresApproval: false, requiresConfirmation: false };
}

export function buildActionPrompt(action: ActionRecord, userPrompt: string | null): string {
  const contract = action.agent_contract || {};
  const objective = stringValue(contract.objective) || action.title;
  const criteria = Array.isArray(contract.success_criteria) ? contract.success_criteria.map(String) : [];
  const contextRefs = Array.isArray(contract.context_refs) ? contract.context_refs.map(String) : [];
  const toolRouteText = renderActionToolRouteForPrompt(action.tool_route);
  return [
    `VoltMind Action: ${action.slug}`,
    `Objective: ${objective}`,
    `Risk: ${action.risk_level}`,
    `Mode: ${action.mode}`,
    `Runtime: ${action.runtime || 'codex'}`,
    `Max autonomy: ${action.max_autonomy || 'draft_only'}${action.outcome ? `\\nOutcome: ${action.outcome}` : ''}${action.next_step ? `\\nNext Step: ${action.next_step}` : ''}`,
    action.due_at ? `Due: ${action.due_at}` : '',
    contextRefs.length ? `Context refs:\n${contextRefs.map(r => `- ${r}`).join('\n')}` : '',
    criteria.length ? `Success criteria:\n${criteria.map(c => `- ${c}`).join('\n')}` : '',
    action.allowed_tools.length ? `Allowed tools: ${action.allowed_tools.join(', ')}` : '',
    action.blocked_tools.length ? `Blocked tools: ${action.blocked_tools.join(', ')}` : '',
    toolRouteText,
    userPrompt ? `User prompt:\n${userPrompt}` : '',
    '',
    'V1 boundary: prepare a draft, plan, or artifact only. Do not send email, operate a browser, mutate external systems, or perform final irreversible actions.',
  ].filter(Boolean).join('\n');
}

export function buildActionPlanPrompt(action: ActionRecord, userPrompt: string | null): string {
  return buildActionPlanPromptWithContext(action, { userPrompt });
}

export interface ActionIdentityContext {
  user_md: string | null;
  soul_md: string | null;
  found: string[];
  missing: string[];
}

export interface ActionRelatedQueryHit {
  field: keyof ActionRelatedContext;
  value: string;
  slug: string;
  title: string;
  type: string;
  score: number | null;
  snippet: string;
  source_id?: string;
}

export interface ActionRelatedRuntimeContext {
  hits: ActionRelatedQueryHit[];
  warnings: string[];
}

export type ActionRuntimeQueryDispatcher = (
  name: string,
  params: Record<string, unknown> | undefined,
  opts: DispatchOpts,
) => Promise<Pick<ToolResult, 'content' | 'isError'>>;

export function buildActionPlanPromptWithContext(
  action: ActionRecord,
  opts: {
    userPrompt?: string | null;
    identityContext?: ActionIdentityContext | null;
    actionBody?: string | null;
    relatedRuntimeContext?: ActionRelatedRuntimeContext | null;
    previousPlan?: ActionPlan | null;
    regenerateInstructions?: string | null;
  } = {},
): string {
  const contract = action.agent_contract || {};
  const objective = stringValue(contract.objective) || action.title;
  const criteria = Array.isArray(contract.success_criteria) ? contract.success_criteria.map(String) : [];
  const contextRefs = Array.isArray(contract.context_refs) ? contract.context_refs.map(String) : [];
  const identity = opts.identityContext;
  const toolRouteText = renderActionToolRouteForPrompt(action.tool_route);
  return [
    'Generate a practical execution todo list for this VoltMind action.',
    'Return JSON that exactly matches the provided schema.',
    '',
    `Action slug: ${action.slug}`,
    `Title: ${action.title}`,
    `Objective: ${objective}`,
    `Status: ${action.status}`,
    `Risk: ${action.risk_level}`,
    `Mode: ${action.mode}`,
    `Runtime: ${action.runtime || 'codex'}`,
    `Max autonomy: ${action.max_autonomy || 'draft_only'}${action.outcome ? `\\nOutcome: ${action.outcome}` : ''}${action.next_step ? `\\nNext Step: ${action.next_step}` : ''}`,
    action.due_at ? `Due: ${action.due_at}` : '',
    contextRefs.length ? `Context refs:\n${contextRefs.map(r => `- ${r}`).join('\n')}` : '',
    criteria.length ? `Success criteria:\n${criteria.map(c => `- ${c}`).join('\n')}` : '',
    action.allowed_tools.length ? `Allowed tools: ${action.allowed_tools.join(', ')}` : '',
    action.blocked_tools.length ? `Blocked tools: ${action.blocked_tools.join(', ')}` : '',
    toolRouteText,
    renderRelatedContextForPrompt(action.related_context),
    opts.actionBody ? `Action markdown body:\n${opts.actionBody}` : '',
    renderRelatedRuntimeContextForPrompt(opts.relatedRuntimeContext),
    identity?.user_md ? `USER.md system context:\n${identity.user_md}` : '',
    identity?.soul_md ? `SOUL.md system context:\n${identity.soul_md}` : '',
    opts.previousPlan ? `Previous persisted plan JSON:\n${JSON.stringify(opts.previousPlan, null, 2)}` : '',
    opts.regenerateInstructions ? `Regenerate instructions:\n${opts.regenerateInstructions}` : '',
    opts.userPrompt ? `User instructions:\n${opts.userPrompt}` : '',
    '',
    'Plan requirements:',
    '- Use 2 to 4 phases.',
    '- Each phase should have 2 to 5 concrete checklist steps.',
    '- Keep steps directly executable by Codex later.',
    '- Respect the v1 boundary: plan/draft/prep only; no final email send, browser click, payment, deletion, or external side effect.',
    '- If a final side effect would be required, include a human-confirmation step instead.',
  ].filter(Boolean).join('\n');
}

export function buildActionStepRegeneratePrompt(
  action: ActionRecord,
  plan: ActionPlan,
  phaseIndex: number,
  stepIndex: number,
  instructions: string | null,
  identityContext: ActionIdentityContext | null,
): string {
  const step = plan.plan[phaseIndex]?.steps[stepIndex];
  return [
    'Regenerate exactly one checklist step for this VoltMind action.',
    'Return JSON that exactly matches: {"step":"new checklist text"}.',
    '',
    buildActionPlanPromptWithContext(action, {
      identityContext,
      previousPlan: plan,
      regenerateInstructions: [
        `Target phase index: ${phaseIndex}`,
        `Target step index: ${stepIndex}`,
        `Current step text: ${step?.text || ''}`,
        step?.note ? `User note on this step: ${step.note}` : '',
        instructions ? `Additional instructions: ${instructions}` : '',
      ].filter(Boolean).join('\n'),
    }),
    '',
    'Only produce the replacement text for the target step. Do not rewrite the whole plan.',
  ].join('\n');
}

export async function loadActionIdentityContext(
  engine: BrainEngine,
  action: ActionRecord,
): Promise<ActionIdentityContext> {
  const candidates = new Set<string>();
  if (action.file_path) {
    let dir = dirname(action.file_path);
    for (let i = 0; i < 6; i++) {
      candidates.add(dir);
      candidates.add(join(dir, 'brain'));
      dir = dirname(dir);
    }
  }
  try {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [action.source_id],
    );
    const sourcePath = rows[0]?.local_path;
    if (sourcePath) {
      candidates.add(sourcePath);
      candidates.add(join(sourcePath, 'brain'));
    }
  } catch {
    // Optional context: missing sources table/row should not block planning.
  }
  if (process.env.VOLTMIND_HOME) {
    const homeParent = dirname(process.env.VOLTMIND_HOME);
    candidates.add(homeParent);
    candidates.add(join(homeParent, 'brain'));
  }

  const found: string[] = [];
  const missing: string[] = [];
  async function firstFile(names: string[]): Promise<string | null> {
    for (const base of candidates) {
      for (const name of names) {
        const path = join(base, name);
        if (!existsSync(path)) continue;
        found.push(path);
        return readFile(path, 'utf-8');
      }
    }
    missing.push(names[0]);
    return null;
  }

  return {
    user_md: await firstFile(['USER.md']),
    soul_md: await firstFile(['SOUL.md', 'Soul.md']),
    found,
    missing,
  };
}

function resolveActionScanRoot(repo: string): ActionScanRoot | null {
  const direct = join(repo, 'state', 'actions');
  if (existsSync(direct)) return { root: direct, slugBase: repo };
  const scaffoldBrain = join(repo, 'brain');
  const nested = join(scaffoldBrain, 'state', 'actions');
  if (existsSync(nested)) return { root: nested, slugBase: scaffoldBrain };
  return null;
}

function inferActionRepoFromHome(): string | null {
  const home = process.env.VOLTMIND_HOME;
  if (!home) return null;
  const repo = dirname(home);
  return resolveActionScanRoot(repo) ? repo : null;
}


function extractSection(body: string, heading: string): string | null {
  const regex = new RegExp(`## \\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---|\\n\\s*$)`, 'i');
  const match = body.match(regex);
  return match ? match[1].trim() : null;
}

function normalizeRelatedContext(fm: Record<string, unknown>): ActionRelatedContext {
  return {
    related_people: arrayOfStringsFlexible(fm.related_people),
    related_project: scalarOrFirstString(fm.related_project),
    related_systems: arrayOfStringsFlexible(fm.related_systems),
    related_entities: arrayOfStringsFlexible(fm.related_entities),
    related_projects: arrayOfStringsFlexible(fm.related_projects),
    related_workstream: scalarOrFirstString(fm.related_workstream),
  };
}

function parseActionFile(raw: string, filePath: string, slugBase: string, sourceId: string): ParsedAction {
  const parsed = parseMarkdown(raw, filePath);
  const fm = matter(raw).data as Record<string, unknown>;
  const automation = objectValue(fm.automation);
  const agentContract = objectValue(fm.agent_contract);
  const mode = normalizeMode(stringValue(automation.mode), stringValue(automation.trigger));
  const slug = parsed.slug.startsWith('state/actions/')
    ? parsed.slug
    : normalizeSlug(relative(slugBase, filePath));
  const dueAt = parseDueAt(automation.run_at, fm.due);
  return {
    sourceId,
    slug,
    title: stringValue(fm.title) || parsed.title || slug,
    status: normalizeActionStatus(fm.status),
    priority: stringValue(fm.priority) || null,
    dueAt,
    eligible: automation.eligible === true,
    mode: mode.mode,
    runtime: stringValue(automation.runtime) || null,
    trigger: mode.trigger,
    riskLevel: normalizeRisk(stringValue(automation.risk_level)),
    requiresConfirmation: automation.requires_confirmation !== false,
    requiresApproval: automation.requires_approval === true,
    maxAutonomy: stringValue(fm.max_autonomy) || 'draft_only',
    outcome: extractSection(matter(raw).content || '', 'Outcome'),
    nextStep: extractSection(matter(raw).content || '', 'Next Step'),
    agentContract,
    automation,
    allowedTools: arrayOfStrings(fm.allowed_tools),
    blockedTools: arrayOfStrings(fm.blocked_tools),
    relatedContext: normalizeRelatedContext(fm),
    filePath,
    contentHash: createHash('sha256').update(raw).digest('hex'),
  };
}

async function upsertAction(engine: BrainEngine, action: ParsedAction): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO action_index (
      source_id, slug, title, status, priority, due_at, eligible, mode, runtime, trigger,
      risk_level, requires_confirmation, requires_approval, max_autonomy, outcome, next_step,
      agent_contract, automation, allowed_tools, blocked_tools, related_context, file_path, content_hash,
      last_scanned_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22,$23,now(),now())
    ON CONFLICT (source_id, slug)
    DO UPDATE SET
      title = EXCLUDED.title,
      status = EXCLUDED.status,
      priority = EXCLUDED.priority,
      due_at = EXCLUDED.due_at,
      eligible = EXCLUDED.eligible,
      mode = EXCLUDED.mode,
      runtime = EXCLUDED.runtime,
      trigger = EXCLUDED.trigger,
      risk_level = EXCLUDED.risk_level,
      requires_confirmation = EXCLUDED.requires_confirmation,
      requires_approval = EXCLUDED.requires_approval,
      max_autonomy = EXCLUDED.max_autonomy,
      outcome = EXCLUDED.outcome,
      next_step = EXCLUDED.next_step,
      agent_contract = EXCLUDED.agent_contract,
      automation = EXCLUDED.automation,
      allowed_tools = EXCLUDED.allowed_tools,
      blocked_tools = EXCLUDED.blocked_tools,
      related_context = EXCLUDED.related_context,
      file_path = EXCLUDED.file_path,
      content_hash = EXCLUDED.content_hash,
      last_scanned_at = now(),
      updated_at = now()`,
    [
      action.sourceId, action.slug, action.title, action.status, action.priority, action.dueAt,
      action.eligible, action.mode, action.runtime, action.trigger, action.riskLevel,
      action.requiresConfirmation, action.requiresApproval, action.maxAutonomy, action.outcome, action.nextStep,
      JSON.stringify(action.agentContract), JSON.stringify(action.automation),
      JSON.stringify(action.allowedTools), JSON.stringify(action.blockedTools),
      JSON.stringify(action.relatedContext),
      action.filePath, action.contentHash,
    ],
  );
}

async function pruneStaleActionIndex(engine: BrainEngine, sourceId: string, filePaths: string[]): Promise<number> {
  if (filePaths.length === 0) {
    const rows = await engine.executeRaw<{ slug: string }>(
      `DELETE FROM action_index
        WHERE source_id = $1
        RETURNING slug`,
      [sourceId],
    );
    return rows.length;
  }
  const placeholders = filePaths.map((_, index) => `$${index + 2}`).join(', ');
  const rows = await engine.executeRaw<{ slug: string }>(
    `DELETE FROM action_index
      WHERE source_id = $1
        AND (file_path IS NULL OR file_path NOT IN (${placeholders}))
      RETURNING slug`,
    [sourceId, ...filePaths],
  );
  return rows.length;
}

export async function loadActionBodyContext(action: ActionRecord): Promise<string | null> {
  if (!action.file_path) return null;
  try {
    const raw = await readFile(action.file_path, 'utf-8');
    return matter(raw).content.trim() || null;
  } catch {
    return null;
  }
}

export function collectActionRelatedQueryRequests(
  context: ActionRelatedContext,
): Array<{ field: keyof ActionRelatedContext; value: string; query: string }> {
  const requests: Array<{ field: keyof ActionRelatedContext; value: string; query: string }> = [];
  const push = (field: keyof ActionRelatedContext, values: string[] | string | null) => {
    const arr = Array.isArray(values) ? values : values ? [values] : [];
    for (const value of arr) {
      const trimmed = value.trim();
      if (!trimmed || requests.some(req => req.field === field && req.value === trimmed)) continue;
      requests.push({ field, value: trimmed, query: `what do we know about ${trimmed}` });
    }
  };
  push('related_people', context.related_people);
  push('related_project', context.related_project);
  push('related_systems', context.related_systems);
  push('related_entities', context.related_entities);
  push('related_projects', context.related_projects);
  push('related_workstream', context.related_workstream);
  return requests.slice(0, 12);
}

export function normalizeActionRelatedQueryHits(
  field: keyof ActionRelatedContext,
  value: string,
  rawResults: unknown,
): ActionRelatedQueryHit[] {
  const results = Array.isArray(rawResults) ? rawResults : [];
  return results.map((result): ActionRelatedQueryHit | null => {
    const r = result as Partial<SearchResult>;
    if (typeof r.slug !== 'string' || typeof r.title !== 'string') return null;
    const text = typeof r.chunk_text === 'string' ? r.chunk_text : '';
    return {
      field,
      value,
      slug: r.slug,
      title: r.title,
      type: typeof r.type === 'string' ? r.type : 'unknown',
      score: typeof r.score === 'number' ? r.score : null,
      snippet: truncateForPrompt(text.replace(/\s+/g, ' ').trim(), 700),
      ...(typeof r.source_id === 'string' ? { source_id: r.source_id } : {}),
    };
  }).filter((hit): hit is ActionRelatedQueryHit => Boolean(hit));
}

export function dedupeAndCapActionRelatedHits(
  hits: ActionRelatedQueryHit[],
  maxHits = 12,
): ActionRelatedQueryHit[] {
  const seen = new Set<string>();
  const out: ActionRelatedQueryHit[] = [];
  for (const hit of hits) {
    const key = `${hit.source_id || 'default'}:${hit.slug}:${hit.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= maxHits) break;
  }
  return out;
}

export async function loadActionRelatedRuntimeContext(
  action: ActionRecord,
  dispatcher: ActionRuntimeQueryDispatcher,
): Promise<ActionRelatedRuntimeContext> {
  if (!dispatcher) throw new Error('Action plan runtime query dispatcher is unavailable');
  const hits: ActionRelatedQueryHit[] = [];
  const warnings: string[] = [];
  for (const req of collectActionRelatedQueryRequests(action.related_context)) {
    try {
      const result = await dispatcher('query', {
        query: req.query,
        detail: 'medium',
        limit: 3,
        source_id: action.source_id,
      }, {
        remote: false,
        sourceId: action.source_id,
      });
      const text = result.content?.[0]?.text ?? '[]';
      if (result.isError) {
        warnings.push(`${req.field}:${req.value}: ${extractRuntimeErrorMessage(text)}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        warnings.push(`${req.field}:${req.value}: query returned non-JSON output`);
        continue;
      }
      hits.push(...normalizeActionRelatedQueryHits(req.field, req.value, parsed));
    } catch (err) {
      warnings.push(`${req.field}:${req.value}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { hits: dedupeAndCapActionRelatedHits(hits), warnings };
}

async function refreshActionToolRouteBestEffort(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  registry: PluginRegistry | null,
  now?: Date,
): Promise<void> {
  if (!registry) return;
  try {
    const action = await getAction(engine, slug, sourceId);
    if (!action || action.tool_route?.source === 'user') return;
    const route = await routeActionTools(action, { registry, now });
    await saveActionToolRouteJson(engine, slug, sourceId, route);
  } catch {
    // Tool routing is advisory. A failed route scan must not block action indexing.
  }
}

async function saveActionToolRouteJson(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  route: ActionToolRoute,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE action_index
        SET tool_route_json = $3::jsonb,
            updated_at = now()
      WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug, JSON.stringify(route)],
  );
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(path);
    }
  }
  await walk(root);
  return out;
}

async function updateActionMarkdownStatus(filePath: string, status: string, note?: string): Promise<void> {
  const raw = await readFile(filePath, 'utf-8');
  const doc = matter(raw);
  doc.data.status = status;
  doc.data.updated = new Date().toISOString().slice(0, 10);
  const timeline = [
    doc.content.trimEnd(),
    '',
    '<!-- timeline -->',
    '',
    `- ${new Date().toISOString().slice(0, 10)} | VoltMind - Status set to ${status}${note ? `: ${note}` : ''}.`,
    '',
  ].join('\n');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, matter.stringify(timeline, doc.data), 'utf-8');
}

async function updateActionMarkdownDue(filePath: string, dueAt: string | null): Promise<void> {
  const raw = await readFile(filePath, 'utf-8');
  const doc = matter(raw);
  if (dueAt) {
    const d = new Date(dueAt);
    const localish = d.toISOString().slice(0, 16);
    doc.data.due = localish;
    const automation = objectValue(doc.data.automation);
    automation.run_at = localish;
    automation.trigger = automation.trigger || 'due_time';
    doc.data.automation = automation;
  } else {
    delete doc.data.due;
    const automation = objectValue(doc.data.automation);
    delete automation.run_at;
    doc.data.automation = automation;
  }
  doc.data.updated = new Date().toISOString().slice(0, 10);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, matter.stringify(doc.content, doc.data), 'utf-8');
}

async function updateActionMarkdownMode(filePath: string, mode: ActionMode): Promise<void> {
  const raw = await readFile(filePath, 'utf-8');
  const doc = matter(raw);
  const automation = objectValue(doc.data.automation);
  automation.mode = mode;
  if (mode === 'manual') automation.trigger = automation.trigger || 'manual_checkbox';
  doc.data.automation = automation;
  doc.data.updated = new Date().toISOString().slice(0, 10);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, matter.stringify(doc.content, doc.data), 'utf-8');
}

async function updateActionMarkdownPriority(filePath: string, priority: string | null): Promise<void> {
  const raw = await readFile(filePath, 'utf-8');
  const doc = matter(raw);
  if (priority) doc.data.priority = priority;
  else delete doc.data.priority;
  doc.data.updated = new Date().toISOString().slice(0, 10);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, matter.stringify(doc.content, doc.data), 'utf-8');
}

async function updateActionMarkdownTools(filePath: string, allowedTools: string[], blockedTools: string[]): Promise<void> {
  const raw = await readFile(filePath, 'utf-8');
  const doc = matter(raw);
  doc.data.allowed_tools = allowedTools;
  doc.data.blocked_tools = blockedTools;
  doc.data.updated = new Date().toISOString().slice(0, 10);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, matter.stringify(doc.content, doc.data), 'utf-8');
}

function normalizeActionRow(row: ActionRecord): ActionRecord {
  const mode = normalizeMode(row.mode, row.trigger);
  return {
    ...row,
    mode: mode.mode,
    trigger: mode.trigger,
    agent_contract: objectValue(row.agent_contract),
    automation: objectValue(row.automation),
    allowed_tools: arrayOfStrings(row.allowed_tools),
    blocked_tools: arrayOfStrings(row.blocked_tools),
    related_context: normalizeActionRelatedContext(row.related_context),
    tool_route: normalizeActionToolRoute(row.tool_route),
    risk_level: normalizeRisk(row.risk_level),
    urgency_score: computeActionUrgencyScore(row),
  };
}

function buildRunIdempotencyKey(action: ActionRecord): string {
  const triggerKey = action.trigger || 'manual';
  const scheduled = action.due_at || 'unscheduled';
  return `${action.slug}|${triggerKey}|${scheduled}`;
}

function parseDueAt(runAt: unknown, due: unknown): string | null {
  const raw = stringValue(runAt) || stringValue(due);
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:00` : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeSlug(path: string): string {
  return path.replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\.?\//, '');
}

function normalizeRisk(raw: unknown): ActionRiskLevel {
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'restricted' ? raw : 'medium';
}

function normalizeActionStatus(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return 'open';
  if (value === 'active') return 'in_progress';
  if (value === 'complete' || value === 'completed') return 'done';
  if (value === 'cancelled') return 'canceled';
  if (value === 'scheduled' || value === 'on schedule' || value === 'on-schedule') return 'on_schedule';
  if (value === 'pending' || value === 'waiting') return 'open';
  if (['open', 'on_schedule', 'in_progress', 'done', 'blocked', 'canceled', 'failed', 'needs_confirmation', 'needs_approval'].includes(value)) return value;
  return 'open';
}

function normalizeMode(raw: unknown, trigger?: string | null): { mode: ActionMode; trigger: string | null } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === 'agent_executable') return { mode: 'agent_executable', trigger: trigger || null };
  if (value === 'agent_assisted') return { mode: 'agent_assisted', trigger: trigger || null };
  if (value === 'scheduled_agent') return { mode: 'agent_assisted', trigger: trigger || 'due_time' };
  if (value === 'watch_agent') return { mode: 'agent_assisted', trigger: trigger || 'watch_event' };
  return { mode: 'manual', trigger: trigger || null };
}

function normalizePriority(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return null;
  if (['urgent', 'high', 'medium', 'low'].includes(raw)) return raw;
  return raw;
}

export function computeActionUrgencyScore(
  action: Pick<ActionRecord, 'due_at' | 'priority' | 'risk_level' | 'updated_at'>,
  now = new Date(),
): number {
  const deadlineWeight = (() => {
    if (!action.due_at) return 0.15;
    const due = new Date(action.due_at).getTime();
    if (Number.isNaN(due)) return 0.15;
    const days = (due - now.getTime()) / 86_400_000;
    if (days < 0) return 1;
    if (days <= 1) return 0.9;
    if (days <= 3) return 0.75;
    if (days <= 7) return 0.5;
    if (days <= 14) return 0.3;
    return 0.15;
  })();
  const priorityMap: Record<string, number> = { urgent: 1, high: 0.85, medium: 0.6, low: 0.3 };
  const riskMap: Record<string, number> = { restricted: 1, high: 0.85, medium: 0.55, low: 0.2 };
  const priorityWeight = priorityMap[String(action.priority || '').toLowerCase()] ?? 0.2;
  const riskWeight = riskMap[action.risk_level] ?? 0.55;
  return Number((deadlineWeight * 0.45 + priorityWeight * 0.35 + riskWeight * 0.20).toFixed(4));
}

function compareActionsByUrgency(a: ActionRecord, b: ActionRecord): number {
  const scoreDelta = (b.urgency_score ?? computeActionUrgencyScore(b)) - (a.urgency_score ?? computeActionUrgencyScore(a));
  if (scoreDelta !== 0) return scoreDelta;
  const ad = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
  const bd = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  const priorityRank: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
  const pr = (priorityRank[b.priority || ''] || 0) - (priorityRank[a.priority || ''] || 0);
  if (pr !== 0) return pr;
  const riskRank: Record<string, number> = { restricted: 4, high: 3, medium: 2, low: 1 };
  const rr = riskRank[b.risk_level] - riskRank[a.risk_level];
  if (rr !== 0) return rr;
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeActionRelatedContext(value: unknown): ActionRelatedContext {
  const obj = objectValue(value);
  return normalizeRelatedContext(obj);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringOrNull(value: unknown): string | null {
  const str = stringValue(value);
  return str || null;
}

function scalarOrFirstString(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((v: unknown) => typeof v === "string" && v.trim());
    return first ? String(first).trim() : null;
  }
  const str = stringValue(value);
  return str || null;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean);
}

function arrayOfStringsFlexible(value: unknown): string[] {
  if (Array.isArray(value)) return arrayOfStrings(value);
  const str = stringValue(value);
  return str ? [str] : [];
}

function truncateForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 3)).trimEnd() + '...';
}

function extractRuntimeErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (parsed.error && typeof parsed.error === 'object') {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Fall through to raw text.
  }
  return truncateForPrompt(text.trim() || 'query failed', 200);
}

function renderRelatedContextForPrompt(context: ActionRelatedContext): string {
  const lines = [
    context.related_people.length ? `related_people: ${context.related_people.join(', ')}` : '',
    context.related_project ? `related_project: ${context.related_project}` : '',
    context.related_systems.length ? `related_systems: ${context.related_systems.join(', ')}` : '',
    context.related_entities.length ? `related_entities: ${context.related_entities.join(', ')}` : '',
    context.related_projects.length ? `related_projects: ${context.related_projects.join(', ')}` : '',
    context.related_workstream ? `related_workstream: ${context.related_workstream}` : '',
  ].filter(Boolean);
  return lines.length ? `Action related frontmatter:\n${lines.join('\n')}` : '';
}

function renderRelatedRuntimeContextForPrompt(context: ActionRelatedRuntimeContext | null | undefined): string {
  if (!context || context.hits.length === 0) return '';
  return [
    'Related Context From VoltMind Query:',
    ...context.hits.map(hit => [
      `- ${hit.slug} (${hit.type}) score=${hit.score ?? 'n/a'}`,
      `  Source field: ${hit.field} = ${hit.value}`,
      `  Title: ${hit.title}`,
      hit.source_id ? `  Source: ${hit.source_id}` : '',
      hit.snippet ? `  Snippet: ${hit.snippet}` : '',
    ].filter(Boolean).join('\n')),
  ].join('\n');
}


/* ── Plan persistence ── */

export interface ActionPlan {
  version: 2;
  plan: ActionPlanPhase[];
  done: Record<string, boolean>;
}

export interface ActionPlanPhase {
  phase: string;
  steps: ActionPlanStep[];
}

export interface ActionPlanStep {
  id: string;
  text: string;
  done: boolean;
  note: string;
  regenerated_at?: string;
}

export async function saveActionPlan(
  engine: BrainEngine,
  slug: string,
  plan: unknown | null,
  sourceId = "default",
): Promise<void> {
  await ensureActionSchema(engine);
  const normalized = plan ? normalizeActionPlan(plan) : null;
  const hasStarted = normalized?.plan.some(phase => phase.steps.some(step => step.done)) ?? false;
  await engine.executeRaw(
    `UPDATE action_index
        SET plan_json = $3::jsonb,
            started_at = CASE WHEN $4 THEN COALESCE(started_at, now()) ELSE started_at END,
            updated_at = now()
      WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug, normalized ? JSON.stringify(normalized) : null, hasStarted],
  );
}

export async function getActionPlan(
  engine: BrainEngine,
  slug: string,
  sourceId = "default",
): Promise<ActionPlan | null> {
  await ensureActionSchema(engine);
  const rows = await engine.executeRaw<{ plan_json: Record<string, unknown> | null }>(
    `SELECT plan_json FROM action_index WHERE source_id = $1 AND slug = $2`,
    [sourceId, slug],
  );
  if (!rows[0]?.plan_json) return null;
  return normalizeActionPlan(rows[0].plan_json);
}

export function normalizeActionPlan(value: unknown): ActionPlan | null {
  const raw = value && typeof value === 'object'
    ? value as { plan?: unknown; done?: Record<string, boolean> }
    : {};
  if (!Array.isArray(raw.plan)) return null;
  const legacyDone = raw.done || {};
  const plan = raw.plan.map((phase: unknown, phaseIndex: number): ActionPlanPhase => {
    const obj = phase && typeof phase === 'object' ? phase as { phase?: unknown; steps?: unknown } : {};
    const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
    return {
      phase: typeof obj.phase === 'string' && obj.phase.trim() ? obj.phase.trim() : `Phase ${phaseIndex + 1}`,
      steps: rawSteps.map((step: unknown, stepIndex: number): ActionPlanStep => {
        if (typeof step === 'string') {
          const key = `${phaseIndex}:${stepIndex}`;
          return { id: `p${phaseIndex + 1}s${stepIndex + 1}`, text: step, done: Boolean(legacyDone[key]), note: '' };
        }
        const s = step && typeof step === 'object' ? step as Partial<ActionPlanStep> : {};
        return {
          id: typeof s.id === 'string' && s.id ? s.id : `p${phaseIndex + 1}s${stepIndex + 1}`,
          text: typeof s.text === 'string' ? s.text : '',
          done: Boolean(s.done ?? legacyDone[`${phaseIndex}:${stepIndex}`]),
          note: typeof s.note === 'string' ? s.note : '',
          ...(typeof s.regenerated_at === 'string' ? { regenerated_at: s.regenerated_at } : {}),
        };
      }).filter(step => step.text.trim()),
    };
  }).filter(phase => phase.steps.length > 0);
  return {
    version: 2,
    plan,
    done: Object.fromEntries(plan.flatMap((phase, phaseIndex) =>
      phase.steps.map((step, stepIndex) => [`${phaseIndex}:${stepIndex}`, step.done]),
    )),
  };
}

export function planFromGeneratedPlan(plan: Array<{ phase: string; steps: string[] | Array<{ text?: string }> }>): ActionPlan {
  const normalized = normalizeActionPlan({
    version: 2,
    plan: plan.map((phase, phaseIndex) => ({
      phase: phase.phase,
      steps: phase.steps.map((step, stepIndex) => typeof step === 'string'
        ? { id: `p${phaseIndex + 1}s${stepIndex + 1}`, text: step, done: false, note: '' }
        : { id: `p${phaseIndex + 1}s${stepIndex + 1}`, text: String(step.text || ''), done: false, note: '' }),
    })),
  });
  if (!normalized) throw new Error('generated plan did not normalize');
  return normalized;
}


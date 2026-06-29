/**
 * ActionRunner — the orchestration layer between the CLI and the agent+executor stack.
 *
 * Owns the full execution flow:
 *   gate checks → resolve agent → resolve tool scope → load skill →
 *   build prompt → (dry-run stop) → resolve executor → execute →
 *   parse outcome → write outcome → sync
 *
 * Gate order is fixed: approval first, then confirmation, then non-approval gates.
 * `force` only skips non-approval gates (Gate 4); it NEVER bypasses approval or
 * confirmation gates.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import matter from 'gray-matter';
import type { BrainEngine } from './engine.ts';
import {
  evaluateActionPolicy,
  ensureActionSchema,
  type ActionRecord,
} from './actions.ts';
import {
  resolveExecutor,
  type ActionExecutor,
  type ActionExecutionResult,
  type InteractiveActionRunEnvelope,
} from './action-executor.ts';
import { resolveHarnessAgent, type HarnessAgent, type ToolScope } from './harness-agent.ts';
import { buildActionExecutionPacket } from './action-execution-packet.ts';

/* ── Public types ────────────────────────────────────────── */

export type ActionRunStatus =
  | 'draft_only'
  | 'dry_run'
  | 'blocked'
  | 'needs_confirmation'
  | 'needs_approval'
  | 'interactive_handoff'
  | 'executed'
  | 'failed';

export interface ActionRunOptions {
  execute: boolean;
  dryRun?: boolean;
  userPrompt?: string;
  /** Policy says this action needs confirmation */
  requireConfirmation?: boolean;
  /** User has completed confirmation (CLI sets this on re-call) */
  confirmed?: boolean;
  /** Skip non-approval gates (eligibility/status/due/autonomy). NEVER skips approval. */
  force?: boolean;
  /** Override the action's runtime field. Use 'codex-interactive' for TUI mode. */
  runtimeOverride?: string;
  /** Stable writeback envelope for Admin-started Codex interactive runs. */
  interactiveRun?: InteractiveActionRunEnvelope;
}

export interface OutcomeSummary {
  success: boolean;
  /** machine-readable failure class for CLI/audit diagnostics */
  diagnosticCode?: string;
  /** 1-2 sentence human-readable summary, max 500 chars */
  summary: string;
  /** paths/slugs/URLs of generated artifacts */
  artifactRefs: string[];
  /** non-empty only on failure */
  errors: string[];
  /** first 2000 chars of stdout, for audit */
  rawTruncated: string;
  /** first 2000 chars of stderr, retained for failure diagnosis */
  stderrTruncated?: string;
}

export interface ActionRunResult {
  status: ActionRunStatus;
  allowed: boolean;
  reason?: string;
  prompt?: string;
  execution?: ActionExecutionResult;
  outcome?: OutcomeSummary;
}

export interface ActionRunContext {
  action: ActionRecord;
  options: ActionRunOptions;
  engine: BrainEngine;
}

/* ── ActionRunner interface ───────────────────────────────── */

export interface ActionRunner {
  run(ctx: ActionRunContext): Promise<ActionRunResult>;
}

/* ── DefaultActionRunner ──────────────────────────────────── */

export class DefaultActionRunner implements ActionRunner {
  async run(ctx: ActionRunContext): Promise<ActionRunResult> {
    const { action, options, engine } = ctx;

    await ensureActionSchema(engine);

    // ── Gate 1: manual mode ──
    if (action.mode === 'manual') {
      return {
        status: 'blocked',
        allowed: false,
        reason: 'Manual actions cannot be executed by agent runtime.',
      };
    }

    // ── Call policy gate ──
    const policy = evaluateActionPolicy(action, {
      force: options.force ?? false,
      requireConfirmation: options.requireConfirmation,
    });

    // ── Gate 2: approval (force never skips) ──
    if (policy.requiresApproval) {
      return {
        status: 'needs_approval',
        allowed: false,
        reason: policy.reason ?? 'Action requires approval',
      };
    }

    // ── Gate 3: confirmation (force never skips) ──
    if (policy.requiresConfirmation && !options.confirmed) {
      return {
        status: 'needs_confirmation',
        allowed: false,
        reason: policy.reason ?? 'Action requires confirmation',
      };
    }

    // ── Gate 4: remaining non-approval gates (force skips) ──
    if (!policy.allowed && !(options.force ?? false)) {
      return {
        status: 'blocked',
        allowed: false,
        reason: policy.reason ?? 'Action blocked by policy',
      };
    }

    // ── Resolve agent ──
    const agent = resolveHarnessAgent(action.agent ?? null);

    // ── Build context ──
    const baseCtx = { action, engine, userPrompt: options.userPrompt ?? undefined };

    const executionPacket = await buildActionExecutionPacket(engine, action, {
      userPrompt: options.userPrompt ?? undefined,
    });
    const toolScope = mergeToolScopes(await agent.resolveToolScope(baseCtx), executionPacket.toolScope);
    const skillText = await agent.loadSkill(baseCtx);
    const prompt = await agent.buildPrompt({
      ...baseCtx,
      toolScope,
      skillText,
      executionPacket,
    });

    // ── Dry run: stop here ──
    if (options.dryRun) {
      return {
        status: 'dry_run',
        allowed: true,
        prompt,
      };
    }

    // ── Resolve executor ──
    let executor: ActionExecutor;
    try {
      executor = resolveExecutor(options.runtimeOverride ?? action.runtime);
    } catch (err) {
      return {
        status: 'blocked',
        allowed: false,
        reason: err instanceof Error ? err.message : 'Unknown executor resolution error',
      };
    }

    // ── Execute ──
    let execResult: ActionExecutionResult;
    try {
      execResult = await executor.execute({
        prompt,
        toolScope,
        timeoutMs: 600_000,
        interactiveRun: options.interactiveRun,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const outcome: OutcomeSummary = {
        success: false,
        diagnosticCode: 'executor_error',
        summary: errorMsg.slice(0, 500),
        artifactRefs: [],
        errors: [errorMsg],
        rawTruncated: '',
        stderrTruncated: errorMsg.slice(0, 2000),
      };
      await writeOutcome(engine, action, outcome, 'failed');
      return {
        status: 'failed',
        allowed: true,
        reason: errorMsg,
        prompt,
        execution: {
          kind: 'error',
          exitCode: 1,
          stdout: '',
          stderr: errorMsg,
          wallMs: 0,
        },
        outcome,
      };
    }

    // ── Parse outcome ──
    if (execResult.kind === 'codex_interactive' || execResult.kind === 'codex_interactive_detached') {
      const outcome: OutcomeSummary = {
        success: execResult.exitCode === 0,
        diagnosticCode: execResult.exitCode === 0 ? undefined : 'codex_interactive_failed',
        summary: execResult.exitCode === 0
          ? 'Interactive Codex session started. VoltMind is waiting for the writeback result file.'
          : 'Interactive Codex session exited with a non-zero status.',
        artifactRefs: [],
        errors: execResult.exitCode === 0 ? [] : [`codex interactive exited with code ${execResult.exitCode}`],
        rawTruncated: '',
        stderrTruncated: undefined,
      };
      if (execResult.exitCode !== 0) {
        await writeOutcome(engine, action, outcome, 'failed');
      }
      return {
        status: execResult.exitCode === 0 ? 'interactive_handoff' : 'failed',
        allowed: true,
        prompt,
        execution: execResult,
        outcome,
      };
    }

    // ── Parse outcome ──
    const outcome = parseExecutionOutcome(execResult, { action, toolScope });

    // ── Determine run status ──
    const runStatus: ActionRunStatus = outcome.success
      ? 'executed'
      : 'failed';

    // ── Write outcome ──
    await writeOutcome(engine, action, outcome, runStatus);

    return {
      status: runStatus,
      allowed: true,
      prompt,
      execution: execResult,
      outcome,
    };
  }
}

function mergeToolScopes(primary: ToolScope, routed: ToolScope): ToolScope {
  return {
    allowed: primary.allowed.length > 0 ? primary.allowed : routed.allowed,
    blocked: [...new Set([...primary.blocked, ...routed.blocked])],
  };
}

/* ── Outcome parsing ─────────────────────────────────────── */

/**
 * Extract a structured OutcomeSummary from raw Codex execution output.
 * Heuristic approach (Phase 1): exitCode, final text block, file-path regex.
 * Phase 2 can replace this with LLM-based structured extraction.
 */
export function parseExecutionOutcome(
  result: ActionExecutionResult,
  ctx: { action?: ActionRecord; toolScope?: ToolScope } = {},
): OutcomeSummary {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const parsedEvents = parseJsonl(stdout);
  const connectorSignal = inspectConnectorSignals(parsedEvents, combined);
  const emailAction = isOutlookEmailAction(ctx);

  let success = result.exitCode === 0;
  let diagnosticCode: string | undefined;
  const errors: string[] = [];

  if (connectorSignal.failure) {
    success = false;
    diagnosticCode = connectorSignal.failure;
    errors.push(connectorSignal.failureMessage);
  }

  if (success && emailAction && !connectorSignal.success) {
    success = false;
    diagnosticCode = 'connector_not_observed';
    errors.push(
      'Outlook Email connector success event was not observed. Possible causes: app id is wrong, connector is not visible in the Codex CLI surface, the model did not choose the connector, or features.apps did not take effect.',
    );
  }

  if (!success && !diagnosticCode && result.exitCode !== 0) {
    diagnosticCode = 'codex_exec_failed';
  }

  // Extract last meaningful paragraph (skip trailing whitespace)
  const trimmed = stdout.trimEnd();
  const lastBlockMatch = trimmed.match(/(?:^|\n)([^\n]{20,500})(?:\n|$)/g);
  const lastBlock = lastBlockMatch
    ? lastBlockMatch[lastBlockMatch.length - 1]!.trim()
    : trimmed.slice(-500);
  const summary = (lastBlock || 'No output captured').slice(0, 500);

  // Extract file path / URL references
  const pathRefs = new Set<string>();
  const pathPattern = /(?:^|\s)((?:\/|[A-Za-z]:\\|https?:\/\/)\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(stdout)) !== null) {
    pathRefs.add(match[1]!);
  }

  if (!success && errors.length === 0) {
    const errSummary = stderr
      ? stderr.trim().split('\n').filter(Boolean).slice(-5)
      : stdout.trim().split('\n').filter(Boolean).slice(-5);
    errors.push(...errSummary.map(e => e.slice(0, 300)));
  }

  return {
    success,
    diagnosticCode,
    summary,
    artifactRefs: [...pathRefs].slice(0, 20),
    errors,
    rawTruncated: stdout.slice(0, 2000),
    stderrTruncated: stderr ? stderr.slice(0, 2000) : undefined,
  };
}

function parseJsonl(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON progress lines are allowed even when --json is requested.
    }
  }
  return events;
}

function inspectConnectorSignals(events: unknown[], combinedOutput: string): {
  success: boolean;
  failure?: string;
  failureMessage: string;
} {
  const failurePhrase = /(tool call was cancelled|email was not sent|no email was sent|connector call was cancelled|approval required|no send tool|no send operation|unable to send|no send\/create|do not include a send|does not include a send)/i;
  if (failurePhrase.test(combinedOutput)) {
    return {
      success: false,
      failure: 'connector_call_failed',
      failureMessage: 'Codex reported that the Outlook Email connector call did not complete.',
    };
  }

  let success = false;
  for (const event of events) {
    const flat = JSON.stringify(event).toLowerCase();
    const connectorRelated = isConnectorRelated(flat);
    const outlookRelated = isOutlookEmailRelated(flat);
    const toolEvent = isToolEvent(flat);

    if (connectorRelated && /(cancelled|canceled|denied|approval_required|approval required|failed|error)/.test(flat)) {
      return {
        success: false,
        failure: eventFailureCode(flat),
        failureMessage: 'Codex JSONL reported a failed or cancelled connector/tool event.',
      };
    }

    if (outlookRelated && toolEvent && /(success|succeeded|completed|complete|result|output|call_end|tool_call_result)/.test(flat)) {
      success = true;
    }
  }

  return { success, failureMessage: '' };
}

function isConnectorRelated(flat: string): boolean {
  return /\b(app|connector|mcp|tool)\b/.test(flat);
}

function isToolEvent(flat: string): boolean {
  if (flat.includes('"type":"agent_message"')) return false;
  return (
    flat.includes('app_tool_call') ||
    flat.includes('mcp_tool_call') ||
    flat.includes('tool_call') ||
    flat.includes('tool_result') ||
    flat.includes('tool_call_result') ||
    flat.includes('"type":"function_call"') ||
    flat.includes('"type":"function_call_output"')
  );
}

function isOutlookEmailRelated(flat: string): boolean {
  return (
    flat.includes('outlook_email') ||
    flat.includes('outlook email') ||
    flat.includes('microsoft_outlook_email') ||
    flat.includes('outlook-email') ||
    flat.includes('microsoft outlook') && flat.includes('email')
  );
}

function eventFailureCode(flat: string): string {
  if (flat.includes('approval_required') || flat.includes('approval required')) return 'approval_required';
  if (flat.includes('denied')) return 'connector_denied';
  if (flat.includes('cancelled') || flat.includes('canceled')) return 'connector_cancelled';
  if (flat.includes('failed')) return 'connector_failed';
  return 'connector_error';
}

function isOutlookEmailAction(ctx: { action?: ActionRecord; toolScope?: ToolScope }): boolean {
  const toolNames = [
    ...(ctx.toolScope?.allowed ?? []),
    ...(ctx.action?.allowed_tools ?? []),
    ctx.action?.runtime ?? '',
    ctx.action?.agent ?? '',
    ctx.action?.skill ?? '',
  ].join(' ').toLowerCase();
  return (
    toolNames.includes('outlook_email') ||
    toolNames.includes('outlook email') ||
    toolNames.includes('microsoft_outlook_email')
  );
}

/* ── Outcome writeback ───────────────────────────────────── */

/**
 * Write execution outcome to both the DB (action_index) and
 * the action markdown file on disk (## Outcome section).
 *
 * Status mapping:
 *   blocked / needs_approval  → action_index.status = "blocked"
 *   success                    → action_index.status = "done"
 *   otherwise                  → action_index.status = "failed"
 */
export async function writeOutcome(
  engine: BrainEngine,
  action: ActionRecord,
  outcome: OutcomeSummary,
  runStatus: ActionRunStatus,
): Promise<void> {
  const dbStatus =
    runStatus === 'blocked' || runStatus === 'needs_approval'
      ? 'blocked'
      : outcome.success
        ? 'done'
        : 'failed';

  // Update DB
  await engine.executeRaw(
    `UPDATE action_index
        SET status = $3,
            outcome = $4,
            completed_at = CASE WHEN $3 = 'done' THEN COALESCE(completed_at, now()) ELSE completed_at END,
            archived_at = CASE WHEN $3 = 'done' THEN COALESCE(archived_at, now()) ELSE archived_at END,
            updated_at = now()
      WHERE source_id = $1 AND slug = $2`,
    [action.source_id, action.slug, dbStatus, outcome.summary],
  );

  // Update markdown file
  if (action.file_path && existsSync(action.file_path)) {
    try {
      const raw = await readFile(action.file_path, 'utf-8');
      const doc = matter(raw);
      doc.data.status = dbStatus;
      doc.data.updated = new Date().toISOString().slice(0, 10);

      const artifactLines = outcome.artifactRefs.length
        ? '\n\nArtifacts:\n' + outcome.artifactRefs.map(r => '- ' + r).join('\n')
        : '';

      const outcomeParts: string[] = [outcome.summary];
      if (artifactLines) outcomeParts.push(artifactLines);
      if (outcome.errors.length) {
        outcomeParts.push('');
        outcomeParts.push('Errors:');
        outcomeParts.push(...outcome.errors.map(e => '- ' + e));
      }

      const newContent = [
        doc.content.trimEnd(),
        '',
        '## Outcome',
        '',
        outcomeParts.join('\n'),
      ].join('\n');

      await mkdir(dirname(action.file_path), { recursive: true });
      await writeFile(action.file_path, matter.stringify(newContent, doc.data), 'utf-8');
    } catch {
      // File write is best-effort; DB is the primary store
    }
  }
}

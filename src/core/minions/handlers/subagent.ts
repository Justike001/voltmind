/**
 * Subagent LLM-loop handler (v0.15).
 *
 * Runs one Anthropic Messages API conversation with tool use. The loop is
 * crash-resumable: subagent_messages + subagent_tool_executions together
 * are the single source of truth about where the conversation is. On
 * resume after a worker kill, we load all committed rows, trust any tool
 * execution marked 'complete' or 'failed', and re-run 'pending' ones only
 * for idempotent tools.
 *
 * Safety rails:
 *   - rate leases around every LLM call (acquire → call → release). Mid-
 *     call renewal with backoff. Persistent renewal failure aborts as a
 *     renewable error so the worker re-claims.
 *   - dual-signal abort wiring (ctx.signal + ctx.shutdownSignal) drains
 *     the in-flight call and commits whatever turns are already persisted.
 *   - Anthropic prompt cache markers on system + tools blocks.
 *   - token rollup via ctx.updateTokens per turn.
 *
 * NOT in v0.15: refusal detection, stop_reason=max_tokens partial
 * recovery, parallel tool-use dispatch (runs tools sequentially; the
 * Messages API allows parallel tool_use blocks and the replay tolerates
 * them, but v1 dispatches serially for simplicity). All three are tracked
 * as P2 items in the plan file.
 */

import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type {
  ContentBlock,
  SubagentHandlerData,
  SubagentResult,
  SubagentStopReason,
  ToolDef,
} from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { VoltMindConfig } from '../../config.ts';
import { loadConfig } from '../../config.ts';
import { buildBrainTools, filterAllowedTools } from '../tools/brain-allowlist.ts';
import { acquireLease, releaseLease } from '../rate-leases.ts';
import { logSubagentSubmission, logSubagentHeartbeat } from './subagent-audit.ts';
import { DEFAULT_OPENROUTER_CHAT_MODEL, resolveModel, TIER_DEFAULTS } from '../../model-config.ts';
import { buildSystemPrompt, DEFAULT_SUBAGENT_SYSTEM } from '../system-prompt.ts';
import { chat as gatewayChat, toolLoop as gatewayToolLoop } from '../../ai/gateway.ts';
import type { ChatToolDef, ChatMessage, ChatBlock, ChatResult, ChatOpts, ToolHandler } from '../../ai/gateway.ts';
import { classifyCapabilities } from '../../ai/capabilities.ts';
import { randomUUIDv7 } from 'bun';

// ── Defaults ────────────────────────────────────────────────

const DEFAULT_MODEL = DEFAULT_OPENROUTER_CHAT_MODEL;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_RATE_KEY = 'anthropic:messages';
const DEFAULT_MAX_CONCURRENT = resolveLeaseCap(process.env.VOLTMIND_ANTHROPIC_MAX_INFLIGHT);
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_SYSTEM = DEFAULT_SUBAGENT_SYSTEM;

export function resolveLeaseCap(raw: string | undefined): number {
  if (raw === undefined) return 32;
  if (raw === 'unlimited' || raw === 'none') return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  throw new Error(
    `VOLTMIND_ANTHROPIC_MAX_INFLIGHT="${raw}" is invalid. ` +
    `Use a positive integer, "unlimited" (or "none"), or omit for default 32.`,
  );
}

export interface SubagentDeps {
  engine: BrainEngine;
  /** Gateway-shaped test transport; production leaves this unset. */
  chatFn?: (opts: ChatOpts) => Promise<ChatResult>;
  config?: VoltMindConfig;
  rateLeaseKey?: string;
  maxConcurrent?: number;
  leaseTtlMs?: number;
  toolRegistry?: ToolDef[];
}

interface PersistedMessage {
  message_idx: number;
  role: 'user' | 'assistant';
  content_blocks: ContentBlock[];
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_create: number | null;
  model: string | null;
}

interface PersistedToolExec {
  message_idx: number;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

export function makeSubagentHandler(deps: SubagentDeps) {
  const engine = deps.engine;
  const config = deps.config ?? loadConfig() ?? ({ engine: 'postgres' } as VoltMindConfig);
  const rateLeaseKey = deps.rateLeaseKey ?? DEFAULT_RATE_KEY;
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  return async function subagentHandler(ctx: MinionJobContext): Promise<SubagentResult> {
    const data = (ctx.data ?? {}) as unknown as SubagentHandlerData;
    if (!data.prompt || typeof data.prompt !== 'string') {
      throw new Error('subagent job data.prompt is required (string)');
    }
    if (data.model) {
      const verdict = classifyCapabilities(data.model);
      if (verdict === 'unusable:no_tools') {
        throw new Error(
          `subagent job rejected: data.model "${data.model}" lacks native tool calling. ` +
          `The subagent loop dispatches brain ops via tool calls — without tool support the loop has no way to run.`,
        );
      }
      if (verdict === 'unknown') {
        throw new Error(
          `subagent job rejected: data.model "${data.model}" references an unknown provider. ` +
          `Use format provider:model where provider matches a recipe in src/core/ai/recipes/.`,
        );
      }
    }
    const model = data.model ?? await resolveModel(engine, {
      tier: 'subagent',
      configKey: 'models.subagent',
      fallback: TIER_DEFAULTS.subagent,
    });
    const maxTurns = data.max_turns ?? DEFAULT_MAX_TURNS;
    const registry = deps.toolRegistry ?? buildBrainTools({
      subagentId: ctx.id,
      engine,
      config,
      brainId: data.brain_id,
      allowedSlugPrefixes: data.allowed_slug_prefixes,
      sourceId: data.source_id,
      allowTrackingRegistration: data.tracking_maintenance === true,
    });
    const toolDefs = data.allowed_tools && data.allowed_tools.length > 0
      ? filterAllowedTools(registry, data.allowed_tools)
      : registry;
    const systemPrompt = buildSystemPrompt(toolDefs, data.system, {
      no_tool_preamble: data.system_no_tool_preamble,
    });
    logSubagentSubmission({
      caller: 'worker',
      remote: true,
      job_id: ctx.id,
      model,
      tools_count: toolDefs.length,
      allowed_tools: toolDefs.map(t => t.name),
    });
    // Every model call is gateway-owned. chatFn is a provider-neutral test seam.
    return await runSubagentViaGateway({
      engine,
      ctx,
      data,
      model,
      systemPrompt,
      toolDefs,
      maxTurns,
      rateLeaseKey,
      maxConcurrent,
      leaseTtlMs,
      chatFn: deps.chatFn,
    });
  };
}

// ── v0.38 Gateway-native subagent path ──────────────────────

interface GatewayRunArgs {
  engine: BrainEngine;
  ctx: MinionJobContext;
  data: SubagentHandlerData;
  model: string;
  systemPrompt: string;
  toolDefs: ToolDef[];
  maxTurns: number;
  rateLeaseKey: string;
  maxConcurrent: number;
  leaseTtlMs: number;
  chatFn?: (opts: ChatOpts) => Promise<ChatResult>;
}

/**
 * v0.38 S1.5 — provider-agnostic subagent loop via `gateway.toolLoop()`.
 *
 * Adapts the existing brain-tool registry (anthropic-shaped ToolDef) to the
 * gateway's provider-neutral `ChatToolDef` + `ToolHandler` shapes, wires
 * persistence callbacks that use the v0.38 stable-ID columns (ordinal +
 * voltmind_tool_use_id from migration v106), and invokes the gateway loop.
 *
 * Replay semantics: loads prior `subagent_messages` + `subagent_tool_executions`,
 * builds a `ToolLoopReplayState` keyed by `voltmind_tool_use_id`. For pre-v81
 * legacy rows (ordinal NULL), the D5 read-time shim synthesizes a stable key
 * from `(job_id, message_idx, content_blocks index, tool_name)` so the
 * reconciler sees both shapes uniformly.
 */
async function runSubagentViaGateway(args: GatewayRunArgs): Promise<SubagentResult> {
  const { engine, ctx, data, model, systemPrompt, toolDefs, maxTurns, rateLeaseKey, maxConcurrent, leaseTtlMs, chatFn } = args;

  // Map ToolDef → ChatToolDef (gateway shape). The gateway's chat() bridges
  // this to provider-specific tool definitions via the Vercel AI SDK.
  const chatTools: ChatToolDef[] = toolDefs.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema as Record<string, unknown>,
  }));

  // Map ToolDef → ToolHandler (gateway shape). Each handler is a thin wrapper
  // that invokes the existing brain-tool dispatch.
  const toolHandlers = new Map<string, ToolHandler>();
  for (const t of toolDefs) {
    toolHandlers.set(t.name, {
      idempotent: t.idempotent === true,
      async execute(input: unknown, signal: AbortSignal): Promise<unknown> {
        return await t.execute(input, {
          engine,
          jobId: ctx.id,
          remote: true,
          signal,
        });
      },
    });
  }

  // Load prior state (replay support via D5 shim for legacy v1 rows).
  const priorMessages = await loadPriorMessages(engine, ctx.id);
  // A persisted assistant message with no tool calls is already terminal.
  // Resume must return it directly instead of sending an assistant-prefill
  // conversation back to a provider (which strict APIs reject).
  const lastPrior = priorMessages[priorMessages.length - 1];
  if (lastPrior?.role === 'assistant') {
    const adaptedLastBlocks = adaptContentBlocksToChatBlocks(lastPrior.content_blocks);
    const lastBlocks: ChatBlock[] = Array.isArray(adaptedLastBlocks)
      ? adaptedLastBlocks
      : [{ type: 'text', text: adaptedLastBlocks }];
    const hasToolCall = lastBlocks.some(block => block.type === 'tool-call');
    if (!hasToolCall) {
      const finalText = lastBlocks
        .filter((block): block is Extract<ChatBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('');
      const assistantMessages = priorMessages.filter(message => message.role === 'assistant');
      const tokens = assistantMessages.reduce(
        (total, message) => ({
          in: total.in + (message.tokens_in ?? 0),
          out: total.out + (message.tokens_out ?? 0),
          cache_read: total.cache_read + (message.tokens_cache_read ?? 0),
          cache_create: total.cache_create + (message.tokens_cache_create ?? 0),
        }),
        { in: 0, out: 0, cache_read: 0, cache_create: 0 },
      );
      return {
        result: finalText,
        turns_count: assistantMessages.length,
        stop_reason: 'end_turn',
        tokens,
      };
    }
  }
  const priorTools = await loadPriorToolsV2(engine, ctx.id);
  const priorToolsByStableKey = new Map<string, { status: 'pending' | 'complete' | 'failed'; output?: unknown; error?: string }>();
  for (const row of priorTools) {
    priorToolsByStableKey.set(row.stableKey, {
      status: row.status,
      output: row.output,
      error: row.error ?? undefined,
    });
  }

  // Convert prior Anthropic-shape messages → ChatMessage with ChatBlock content.
  // v1 rows store Anthropic content blocks ({type:'tool_use'|'tool_result'|...});
  // we adapt them to ChatBlock shape (type: 'tool-call' | 'tool-result' | 'text').
  //
  // Tool RESULTS are NOT persisted as messages — they live in
  // subagent_tool_executions keyed by (job_id, message_idx, ordinal). A resumed
  // history is therefore a bare sequence of user/assistant rows with NO
  // tool-result message between them. Handing that to the LLM makes the AI SDK
  // throw AI_MissingToolResultsError ("Tool results are missing for tool calls
  // ..."), which surfaced against DeepSeek/OpenRouter on multi-turn
  // parallel-tool-call resumes (jobs 3837/3838, 3960). Interleave a 'tool'
  // message after every prior assistant turn whose executions are known,
  // re-running idempotent tools that never completed and failing hard on
  // non-idempotent pending ones.
  const priorChatMessages: ChatMessage[] = [];
  const priorToolExecs = await loadPriorToolExecs(engine, ctx.id);
  const execByKey = new Map<string, PriorToolExecRow>();
  for (const ex of priorToolExecs) {
    execByKey.set(
      ex.ordinal != null ? `${ex.message_idx}:${ex.ordinal}` : `${ex.message_idx}:name:${ex.tool_name}`,
      ex,
    );
  }
  const toolDefByIdent = new Map(toolDefs.map(t => [t.name, t]));
  for (const m of priorMessages) {
    const blocks = adaptContentBlocksToChatBlocks(m.content_blocks);
    priorChatMessages.push({ role: m.role as 'user' | 'assistant', content: blocks });
    if (m.role !== 'assistant') continue;
    const toolCalls = (Array.isArray(blocks) ? blocks : []).filter(
      (b): b is Extract<ChatBlock, { type: 'tool-call' }> => b.type === 'tool-call',
    );
    if (toolCalls.length === 0) continue;
    const toolResults: ChatBlock[] = [];
    for (let o = 0; o < toolCalls.length; o++) {
      const call = toolCalls[o];
      const exec = execByKey.get(`${m.message_idx}:${o}`) ?? execByKey.get(`${m.message_idx}:name:${call.toolName}`);
      if (exec?.status === 'complete') {
        toolResults.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: replayToolResultOutput(exec.output ?? null) });
        continue;
      }
      if (exec?.status === 'failed') {
        toolResults.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: replayToolResultOutput(exec.error ?? 'tool failed', true), isError: true });
        continue;
      }
      // pending, or no row at all (crash before onToolCallStart persisted the
      // pending row). Write-ordering invariant means no row ⇒ no side effect,
      // so a never-started tool is always safe to re-run; a pending row is only
      // safe for idempotent tools.
      const def = toolDefByIdent.get(call.toolName);
      if (!def) {
        toolResults.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: replayToolResultOutput(`tool ${call.toolName} is not registered`, true), isError: true });
        continue;
      }
      if (exec?.status === 'pending' && def.idempotent !== true) {
        throw new UnrecoverableError(
          `non-idempotent tool "${call.toolName}" pending on resume; cannot safely re-run`,
        );
      }
      try {
        const output = await def.execute(call.input, { engine, jobId: ctx.id, remote: true, signal: ctx.signal });
        if (exec) {
          await engine.executeRaw(
            `UPDATE subagent_tool_executions SET status='complete', output=$3::text::jsonb, ended_at=now()
              WHERE job_id=$1 AND message_idx=$2 AND (($4::int IS NULL AND ordinal IS NULL) OR ordinal=$4)`,
            [ctx.id, m.message_idx, JSON.stringify(output ?? null), exec.ordinal],
          );
        } else {
          await engine.executeRaw(
            `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version, ordinal, voltmind_tool_use_id, provider_id)
             VALUES ($1,$2,$3,$4,$5::text::jsonb,'complete',2,$6,$7,$8)
             ON CONFLICT (job_id, message_idx, ordinal) DO NOTHING`,
            [ctx.id, m.message_idx, call.toolCallId, call.toolName, JSON.stringify(call.input ?? null), o, randomUUIDv7(), recipeIdFromModel(model)],
          );
        }
        toolResults.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: replayToolResultOutput(output) });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        toolResults.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: replayToolResultOutput(errMsg, true), isError: true });
      }
    }
    if (toolResults.length > 0) priorChatMessages.push({ role: 'tool', content: toolResults });
  }

  // Initial seed message if no prior state.
  const initialMessages: ChatMessage[] = priorChatMessages.length === 0
    ? [{ role: 'user', content: data.prompt }]
    : [];

  // Persist seed user message at idx 0 if fresh start.
  let nextMessageIdx = priorMessages.length;
  if (nextMessageIdx === 0) {
    await persistMessage(engine, ctx.id, {
      message_idx: 0,
      role: 'user',
      content_blocks: [{ type: 'text', text: data.prompt }] as ContentBlock[],
      tokens_in: null,
      tokens_out: null,
      tokens_cache_read: null,
      tokens_cache_create: null,
      model: null,
    });
    nextMessageIdx = 1;
  }

  // Capability detection drives cache_control injection.
  const verdict = classifyCapabilities(model);
  const cacheSystem = verdict === 'ok' || verdict === 'degraded:no_parallel';

  // Heartbeat bridge.
  const heartbeat = (event: string, payload: Record<string, unknown>) => {
    logSubagentHeartbeat({
      job_id: ctx.id,
      event: event as any,
      ...payload,
    } as any);
  };

  // Keep the existing rate-limit lease around every gateway provider call.
  const leasedChat = async (opts: ChatOpts): Promise<ChatResult> => {
    const lease = await acquireLease(engine, rateLeaseKey, ctx.id, maxConcurrent, { ttlMs: leaseTtlMs });
    if (!lease.acquired) throw new RateLeaseUnavailableError(rateLeaseKey, lease.activeCount, lease.maxConcurrent);
    const startedAt = Date.now();
    try {
      const result = await (chatFn ?? gatewayChat)(opts);
      logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_completed', turn_idx: 0, ms_elapsed: Date.now() - startedAt, tokens: result.usage } as any);
      return result;
    } catch (err) {
      if (isPromptTooLongError(err)) {
        throw new UnrecoverableError(`prompt_too_long: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    } finally {
      await releaseLease(engine, lease.leaseId!).catch(() => {});
    }
  };

  // Run the loop.
  const result = await gatewayToolLoop({
    model,
    system: systemPrompt,
    initialMessages,
    tools: chatTools,
    toolHandlers,
    maxTurns,
    chatFn: leasedChat,
    abortSignal: ctx.signal,
    cacheSystem,
    // ALWAYS pass replayState (even on fresh runs) so the gateway loop's
    // messageIdx counter starts at `nextMessageIdx` (1 on fresh, after the
    // seed user write above). Without this, the loop defaults to messageIdx=0
    // on fresh runs and the first onAssistantTurn callback tries to write
    // role='assistant' at idx 0, colliding with the seed user message at idx 0
    // (unique constraint on (job_id, message_idx)). Pinned by
    // test/e2e/subagent-gateway-path.test.ts ("happy path 1-turn" + "write-
    // ordering invariant").
    replayState: {
      priorMessages: priorChatMessages,
      priorTools: priorToolsByStableKey,
      nextTurnIdx: priorChatMessages.filter(m => m.role === 'assistant').length,
      nextMessageIdx,
    },
    onAssistantTurn: async (turnIdx, messageIdx, blocks, usage, modelStr) => {
      // Convert ChatBlock[] back to ContentBlock-shaped JSONB for persistence.
      // Storing the gateway's provider-neutral shape is the v2 content_blocks
      // contract; the D5 shim handles legacy reads from v1 rows.
      await persistMessage(engine, ctx.id, {
        message_idx: messageIdx,
        role: 'assistant',
        content_blocks: blocks as unknown as ContentBlock[],
        tokens_in: usage.input_tokens,
        tokens_out: usage.output_tokens,
        tokens_cache_read: usage.cache_read_tokens,
        tokens_cache_create: usage.cache_creation_tokens,
        model: modelStr,
      });
      await ctx.updateTokens({
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_read: usage.cache_read_tokens,
      });
      heartbeat('llm_call_completed', { turn_idx: turnIdx, tokens: usage });
    },
    onToolCallStart: async (turnIdx, messageIdx, ordinal, toolName, input, providerToolCallId) => {
      // CRITICAL — read back the canonical voltmind_tool_use_id from RETURNING,
      // NOT the locally-generated UUID. On crash-replay the (job_id,
      // message_idx, ordinal) row already exists with the ORIGINAL UUID from
      // the pre-crash run; the ON CONFLICT DO UPDATE keeps it. If we
      // returned the freshly-generated `candidateId` instead, the gateway
      // loop's `replayState.priorTools.get(stableKey)` lookup would miss
      // because priorTools is keyed by the original UUID — the short-
      // circuit silently breaks and the tool re-executes. Pinned by
      // test/e2e/subagent-crash-replay-multi-provider.test.ts.
      const candidateId = randomUUIDv7();
      const rows = await engine.executeRaw<{ voltmind_tool_use_id: string }>(
        `INSERT INTO subagent_tool_executions
           (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version, ordinal, voltmind_tool_use_id, provider_id)
         VALUES ($1, $2, $3, $4, $5::text::jsonb, 'pending', 2, $6, $7, $8)
         ON CONFLICT (job_id, message_idx, ordinal) DO UPDATE
           SET status = subagent_tool_executions.status
         RETURNING voltmind_tool_use_id::text AS voltmind_tool_use_id`,
        [ctx.id, messageIdx, providerToolCallId, toolName, JSON.stringify(input ?? null), ordinal, candidateId, recipeIdFromModel(model)],
      );
      const gbrainToolUseId = rows[0]?.voltmind_tool_use_id ?? candidateId;
      heartbeat('tool_called', { turn_idx: turnIdx, tool_name: toolName });
      return { gbrainToolUseId };
    },
    onToolCallComplete: async (gbrainToolUseId, output) => {
      await engine.executeRaw(
        `UPDATE subagent_tool_executions
           SET status = 'complete', output = $1::text::jsonb, ended_at = now()
         WHERE voltmind_tool_use_id::text = $2`,
        [JSON.stringify(output ?? null), gbrainToolUseId],
      );
    },
    onToolCallFailed: async (gbrainToolUseId, errorMsg) => {
      await engine.executeRaw(
        `UPDATE subagent_tool_executions
           SET status = 'failed', error = $1, ended_at = now()
         WHERE voltmind_tool_use_id::text = $2`,
        [errorMsg, gbrainToolUseId],
      );
    },
    onHeartbeat: heartbeat,
  });

  // Map gateway stop reason to SubagentStopReason. SubagentStopReason has
  // {end_turn, max_turns, refusal, error}; aborted maps to error.
  const stopReason: SubagentStopReason = result.stopReason === 'end'
    ? 'end_turn'
    : result.stopReason === 'max_turns'
      ? 'max_turns'
      : result.stopReason === 'refusal'
        ? 'refusal'
        : result.stopReason === 'content_filter'
          ? 'refusal'
          : result.stopReason === 'aborted'
            ? 'error'
            : 'end_turn';

  return {
    result: result.finalText,
    turns_count: result.totalTurns,
    stop_reason: stopReason,
    tokens: {
      in: result.totalUsage.input_tokens,
      out: result.totalUsage.output_tokens,
      cache_read: result.totalUsage.cache_read_tokens,
      cache_create: result.totalUsage.cache_creation_tokens,
    },
  };
}

function recipeIdFromModel(modelString: string): string {
  const idx = modelString.indexOf(':');
  return idx > 0 ? modelString.slice(0, idx) : 'anthropic';
}

/**
 * Strip the `provider:` prefix from a model string. Returns the bare
 * model id the Anthropic Messages API expects. Idempotent on already-bare
 * strings.
 *
 *   stripProviderPrefix('anthropic:claude-sonnet-4-6') === 'claude-sonnet-4-6'
 *   stripProviderPrefix('claude-sonnet-4-6') === 'claude-sonnet-4-6'
 *
 * v0.41 Bug 3 — pre-fix, `voltmind agent run --model anthropic:claude-sonnet-4-6`
 * sent the prefixed string straight into `client.messages.create()`, which
 * Anthropic rejects with "model not found." Omitting `--model` worked because
 * `resolveModel()` returns the bare id; explicit-model users hit the bug.
 *
 * Used ONLY at the SDK call site. The wider `model` variable stays
 * qualified everywhere else (persistence, recipe lookup, capability gate)
 * because those readers want the provider info.
 */
export function stripProviderPrefix(modelString: string): string {
  const idx = modelString.indexOf(':');
  return idx > 0 ? modelString.slice(idx + 1) : modelString;
}

/**
 * D5 — adapt v1 Anthropic content blocks to v2 ChatBlock shape on read.
 * Symmetric in the other direction is handled by persisting ChatBlock[] as-is
 * (the JSONB column accepts both shapes; v2 writes carry the new vocabulary).
 */
function adaptContentBlocksToChatBlocks(blocks: unknown): ChatBlock[] | string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return [];
  const out: ChatBlock[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    const t = block.type;
    if (t === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (t === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      // v1 Anthropic shape
      out.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input ?? {},
      });
    } else if (t === 'tool-call' && typeof block.toolCallId === 'string' && typeof block.toolName === 'string') {
      // v2 gateway shape (re-read of own writes)
      out.push({
        type: 'tool-call',
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input ?? {},
      });
    } else if (t === 'tool_result' && typeof block.tool_use_id === 'string') {
      // v1 Anthropic shape — tool result block (no toolName in v1; synthesize)
      out.push({
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        toolName: '__legacy__',
        output: block.content ?? null,
        isError: block.is_error === true,
      });
    } else if (t === 'tool-result' && typeof block.toolCallId === 'string') {
      out.push({
        type: 'tool-result',
        toolCallId: block.toolCallId,
        toolName: typeof block.toolName === 'string' ? block.toolName : '__legacy__',
        output: block.output ?? null,
        isError: block.isError === true,
      });
    }
  }
  return out;
}

interface PriorToolV2Row {
  stableKey: string;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

/**
 * Load prior tool executions keyed by a stable key.
 *
 *   - v2 rows: voltmind_tool_use_id is the stable key (set at first observation
 *     by onToolCallStart).
 *   - v1 legacy rows: D5 shim synthesizes a stable key from
 *     (job_id, message_idx, ordinal-position-by-array-index, tool_name).
 *
 * Both forms resolve to the same Map<stableKey, outcome> the gateway loop
 * consults during replay.
 */
async function loadPriorToolsV2(engine: BrainEngine, jobId: number): Promise<PriorToolV2Row[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, tool_use_id, tool_name, ordinal, voltmind_tool_use_id::text AS voltmind_tool_use_id,
            status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1
      ORDER BY message_idx, COALESCE(ordinal, 0), id`,
    [jobId],
  );
  return rows.map(r => {
    const gbrainId = r.voltmind_tool_use_id as string | null;
    const stableKey = gbrainId
      ? gbrainId
      // D5 legacy shim: derive a stable key from (job, msg_idx, tool_name, tool_use_id).
      // Pre-v81 rows don't have ordinal; the provider tool_use_id is stable
      // within a single Anthropic turn so it's safe as a fallback hash input.
      : `legacy:${jobId}:${r.message_idx}:${r.tool_use_id}:${r.tool_name}`;
    return {
      stableKey,
      status: r.status as 'pending' | 'complete' | 'failed',
      output: r.output,
      error: (r.error as string | null) ?? null,
    };
  });
}

interface PriorToolExecRow {
  message_idx: number;
  ordinal: number | null;
  tool_name: string;
  tool_use_id: string;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

/**
 * Mirror of gateway.ts `gatewayToolResultOutput` — the AI SDK's ModelMessage
 * schema expects tool-result `output` in the wrapped `{ type, value }` shape,
 * not the raw value (a raw string/object fails with "messages do not match
 * the ModelMessage[] schema" against strict OpenAI-compatible endpoints).
 * Kept local so the handler doesn't depend on a module-private gateway helper.
 */
function replayToolResultOutput(output: unknown, isError = false): unknown {
  if (isError) {
    const value = typeof output === 'string' ? output : (JSON.stringify(output) ?? String(output));
    return { type: 'error-text', value };
  }
  if (typeof output === 'string') return { type: 'text', value: output };
  try {
    return { type: 'json', value: JSON.parse(JSON.stringify(output ?? null)) };
  } catch {
    return { type: 'text', value: String(output) };
  }
}

/**
 * Load prior tool executions WITH their (message_idx, ordinal) positions.
 * Unlike `loadPriorToolsV2` (stable-key view for the gateway loop's replay
 * short-circuit), this is used to RECONSTRUCT tool-result messages in the
 * resumed message history.
 */
async function loadPriorToolExecs(engine: BrainEngine, jobId: number): Promise<PriorToolExecRow[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, ordinal, tool_name, tool_use_id, status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1
      ORDER BY message_idx, COALESCE(ordinal, 0), id`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    ordinal: r.ordinal as number | null,
    tool_name: r.tool_name as string,
    tool_use_id: r.tool_use_id as string,
    status: r.status as 'pending' | 'complete' | 'failed',
    output: r.output == null
      ? null
      : (typeof r.output === 'string' ? JSON.parse(r.output as string) : r.output),
    error: (r.error as string | null) ?? null,
  }));
}

// ── Internal: persistence ───────────────────────────────────

async function loadPriorMessages(engine: BrainEngine, jobId: number): Promise<PersistedMessage[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, role, content_blocks, tokens_in, tokens_out,
            tokens_cache_read, tokens_cache_create, model
       FROM subagent_messages
      WHERE job_id = $1
      ORDER BY message_idx ASC`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    role: r.role as 'user' | 'assistant',
    content_blocks: (typeof r.content_blocks === 'string'
      ? JSON.parse(r.content_blocks as string)
      : r.content_blocks) as ContentBlock[],
    tokens_in: (r.tokens_in as number) ?? null,
    tokens_out: (r.tokens_out as number) ?? null,
    tokens_cache_read: (r.tokens_cache_read as number) ?? null,
    tokens_cache_create: (r.tokens_cache_create as number) ?? null,
    model: (r.model as string) ?? null,
  }));
}

async function loadPriorTools(engine: BrainEngine, jobId: number): Promise<PersistedToolExec[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, tool_use_id, tool_name, input, status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    tool_use_id: r.tool_use_id as string,
    tool_name: r.tool_name as string,
    input: typeof r.input === 'string' ? JSON.parse(r.input) : r.input,
    status: r.status as 'pending' | 'complete' | 'failed',
    output: r.output == null
      ? null
      : (typeof r.output === 'string' ? JSON.parse(r.output) : r.output),
    error: (r.error as string) ?? null,
  }));
}

async function persistMessage(engine: BrainEngine, jobId: number, msg: PersistedMessage): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7, $8, $9)
     ON CONFLICT (job_id, message_idx) DO NOTHING`,
    [
      jobId,
      msg.message_idx,
      msg.role,
      JSON.stringify(msg.content_blocks),
      msg.tokens_in,
      msg.tokens_out,
      msg.tokens_cache_read,
      msg.tokens_cache_create,
      msg.model,
    ],
  );
}

async function persistToolExecPending(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
): Promise<void> {
  // Serialize to JSON string for the ::jsonb cast. When `input` is already a
  // string (e.g. pre-serialized), avoid double-encoding which produces a jsonb
  // scalar string instead of a jsonb object — breaking `input->>'key'` lookups.
  const jsonStr = typeof input === 'string' ? input : JSON.stringify(input);
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, 'pending')
     ON CONFLICT (job_id, tool_use_id) DO NOTHING`,
    [jobId, messageIdx, toolUseId, toolName, jsonStr],
  );
}

async function persistToolExecComplete(
  engine: BrainEngine,
  jobId: number,
  toolUseId: string,
  output: unknown,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE subagent_tool_executions
        SET status = 'complete', output = $3::text::jsonb, ended_at = now()
      WHERE job_id = $1 AND tool_use_id = $2`,
    [jobId, toolUseId, typeof output === 'string' ? output : JSON.stringify(output)],
  );
}

async function persistToolExecFailed(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
  error: string,
): Promise<void> {
  // INSERT-or-UPDATE to failed — covers both "no pending row yet" (tool
  // rejected upfront) and "pending row exists" (tool threw mid-execute).
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, error, ended_at)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, 'failed', $6, now())
     ON CONFLICT (job_id, tool_use_id) DO UPDATE
       SET status = 'failed', error = EXCLUDED.error, ended_at = now()`,
    [jobId, messageIdx, toolUseId, toolName, typeof input === 'string' ? input : JSON.stringify(input), error],
  );
}

// ── Internal: helpers ───────────────────────────────────────

function asStringIfNotObject(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Merge two AbortSignals into one. Fires when either source aborts. No-op
 * polyfill when AbortSignal.any isn't available yet (Node ≥ 20 has it).
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFn = (AbortSignal as any).any;
  if (typeof anyFn === 'function') return anyFn([a, b]) as AbortSignal;
  // Manual merge.
  const ac = new AbortController();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener('abort', () => ac.abort(), { once: true });
    b.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}

/**
 * Error thrown when acquireLease returns acquired=false. The worker
 * treats this as a renewable error — job goes back to waiting with
 * backoff, no terminal fail.
 */
export class RateLeaseUnavailableError extends Error {
  constructor(public key: string, public active: number, public max: number) {
    super(`rate lease "${key}" full (${active}/${max})`);
    this.name = 'RateLeaseUnavailableError';
  }
}

/**
 * Detect Anthropic SDK errors that indicate the input prompt exceeded the
 * model's context window. Two recognized shapes:
 *   - `Anthropic.APIError` with `.status === 400` and message containing
 *     "prompt is too long" (current SDK wording, observed in production
 *     as `prompt is too long: 1707509 tokens > 1000000 maximum`).
 *   - Any error whose message includes "prompt is too long" (defensive
 *     against SDK-wrap shape changes).
 *
 * Case-insensitive on the phrase. Also matches `request_too_large` and
 * `invalid_request_error` types when accompanied by the same message.
 *
 * Exported for unit testing.
 */
export function isPromptTooLongError(err: unknown): boolean {
  if (!err) return false;
  // Walk both `.message` and `.error?.message` shapes.
  const msg = (err as { message?: unknown })?.message;
  const inner = (err as { error?: { message?: unknown } })?.error?.message;
  const candidates = [msg, inner].filter((s): s is string => typeof s === 'string');
  for (const c of candidates) {
    if (/prompt is too long/i.test(c)) return true;
  }
  // Anthropic SDK wraps with .status; 400 + 'invalid_request_error' /
  // 'request_too_large' types both indicate the same class. Only treat
  // as terminal when the message actually says prompt-too-long; broader
  // 400s could be transient (e.g., malformed JSON from a test stub).
  const status = (err as { status?: unknown })?.status;
  const errType = (err as { error?: { type?: unknown } })?.error?.type;
  if (status === 400 && (errType === 'invalid_request_error' || errType === 'request_too_large')) {
    for (const c of candidates) {
      if (/too long|exceed|maximum/i.test(c)) return true;
    }
  }
  return false;
}

// ── Testing surface ─────────────────────────────────────────

export const __testing = {
  loadPriorMessages,
  loadPriorTools,
  persistMessage,
  persistToolExecPending,
  persistToolExecComplete,
  persistToolExecFailed,
  asStringIfNotObject,
  DEFAULT_MODEL,
  // v0.38 Slice 1 D5 — read-time shim for crash-replay across the v1→v2
  // content_blocks shape boundary. Exposed for test/subagent-v1-v2-shim.test.ts
  // which pins legacy-row adaptation correctness.
  adaptContentBlocksToChatBlocks,
  loadPriorToolsV2,
};

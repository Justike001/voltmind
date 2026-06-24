/**
 * HarnessAgent — the behaviour-strategy layer between ActionRunner and ActionExecutor.
 *
 * An agent decides HOW to execute: what tools are in scope, which skill (if any)
 * provides the procedure, and how the prompt is assembled.  The runner owns the
 * orchestration (gate -> agent -> executor -> outcome); the agent owns the
 * "what does the model actually see and what is it allowed to do" decisions.
 *
 * Phase 1 ships DefaultHarnessAgent which:
 *   - builds tool scope from action.allowed_tools / blocked_tools
 *   - returns null for skill (Phase 2 loads markdown skill files)
 *   - assembles a structured prompt from action body + context refs + linked pages
 */

import type { BrainEngine } from './engine.ts';
import type { ActionRecord } from './actions.ts';
import type { ToolScope } from './action-executor.ts';

export type { ToolScope } from './action-executor.ts';

/* ---- Context types ---- */

export interface HarnessAgentBaseContext {
  action: ActionRecord;
  engine: BrainEngine;
  userPrompt?: string;
}

export interface HarnessAgentContext extends HarnessAgentBaseContext {
  /** Pre-resolved by ActionRunner so buildPrompt can be pure assembly */
  toolScope?: ToolScope;
  /** Pre-loaded by ActionRunner; null means no skill configured / Phase 1 placeholder */
  skillText?: string | null;
  /** Tool search bootstrap context — injected by ActionRunner before buildPrompt */
  toolSearchContext?: string;
}

/* ---- Agent interface ---- */

export interface HarnessAgent {
  readonly name: string;

  /** Build the final prompt that will be sent to the execution backend. */
  buildPrompt(ctx: HarnessAgentContext): Promise<string>;

  /** Derive tool constraints from the action definition. */
  resolveToolScope(ctx: HarnessAgentBaseContext): Promise<ToolScope>;

  /** Load a skill procedure document. Phase 1 returns null (placeholder). */
  loadSkill(ctx: HarnessAgentBaseContext): Promise<string | null>;
}

/* ---- DefaultHarnessAgent ---- */

export class DefaultHarnessAgent implements HarnessAgent {
  readonly name = 'default';

  async resolveToolScope(ctx: HarnessAgentBaseContext): Promise<ToolScope> {
    return {
      allowed: ctx.action.allowed_tools ?? [],
      blocked: ctx.action.blocked_tools ?? [],
    };
  }

  async loadSkill(_ctx: HarnessAgentBaseContext): Promise<string | null> {
    // Phase 2: load markdown skill file based on action.skill field
    return null;
  }

  async buildPrompt(ctx: HarnessAgentContext): Promise<string> {
    const action = ctx.action;
    const contract = (action.agent_contract ?? {}) as Record<string, unknown>;
    const objective = stringValue(contract.objective) || action.title;
    const criteria = Array.isArray(contract.success_criteria)
      ? contract.success_criteria.map(String)
      : [];
    const contextRefs = Array.isArray(contract.context_refs)
      ? contract.context_refs.map(String)
      : [];

    const scope = ctx.toolScope;
    const toolSection = buildToolConstraintSection(scope);
    const skillSection = ctx.skillText
      ? '\n## Skill Procedure\n\n' + ctx.skillText + '\n'
      : '';

    // Tool search context (from ToolSearchBootstrap)
    const toolSearchSection = ctx.toolSearchContext
      ? ctx.toolSearchContext + '\n'
      : '';

    const parts: string[] = [
      toolSearchSection,
      'You are executing a VoltMind Action as a harnessed agent.',
      '',
      'Action: ' + action.slug,
      'Title: ' + action.title,
      'Objective: ' + objective,
      'Mode: ' + action.mode,
      'Risk: ' + action.risk_level,
      'Max autonomy: ' + (action.max_autonomy || 'draft_only'),
      action.runtime ? 'Runtime backend: ' + action.runtime : '',
      action.due_at ? 'Due: ' + action.due_at : '',
      '',
      toolSection,
      skillSection,
      action.outcome ? 'Previous outcome: ' + action.outcome : '',
      action.next_step ? 'Next step: ' + action.next_step : '',
      '',
      contextRefs.length
        ? 'Context refs (read these brain pages for background):\n' + contextRefs.map((r: string) => '- ' + r).join('\n') + '\n'
        : '',
      criteria.length
        ? 'Success criteria:\n' + criteria.map((c: string) => '- ' + c).join('\n') + '\n'
        : '',
      ctx.userPrompt ? 'User prompt:\n' + ctx.userPrompt + '\n' : '',
      '',
      'Complete the task above. If you generate artifacts, note their paths. After finishing, output a brief summary of what was done.',
    ];

    return parts.filter(Boolean).join('\n');
  }
}

/* ---- Agent factory ---- */

/**
 * Resolve a HarnessAgent from the action's `agent` field.
 * Phase 1 always returns DefaultHarnessAgent.
 * Phase 2 will map names like "meeting_brief_agent" to specialised agents.
 */
export function resolveHarnessAgent(_name: string | null | undefined): HarnessAgent {
  // Phase 1: always default
  return new DefaultHarnessAgent();
}

/* ---- Helpers ---- */

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildToolConstraintSection(scope?: ToolScope): string {
  if (!scope) return '';
  const lines: string[] = [];
  if (scope.allowed.length > 0) {
    lines.push('You may ONLY use these tools: ' + scope.allowed.join(', ') + '.');
  } else {
    lines.push('All tools are available (no allowlist).');
  }
  if (scope.blocked.length > 0) {
    lines.push('You MUST NOT use these tools: ' + scope.blocked.join(', ') + '.');
  }
  return lines.join('\n');
}

import type { BrainEngine } from './engine.ts';
import type { ActionPlan, ActionRecord } from './actions.ts';
import { getActionPlan } from './actions.ts';
import type { ToolScope } from './action-executor.ts';
import {
  normalizeActionToolRoute,
  renderActionToolRouteForPrompt,
  routeActionTools,
  type ActionToolRoute,
} from './action-tool-router.ts';

export interface ActionExecutionPacket {
  toolRoute: ActionToolRoute | null;
  toolScope: ToolScope;
  routeContextText: string;
  planText: string;
  userPrompt?: string;
}

export async function buildActionExecutionPacket(
  engine: BrainEngine,
  action: ActionRecord,
  opts: { userPrompt?: string } = {},
): Promise<ActionExecutionPacket> {
  const persistedRoute = await loadPersistedToolRoute(engine, action);
  const toolRoute = persistedRoute ?? await routeActionTools(action, { allowLlm: false }).catch(() => null);
  const plan = await getActionPlan(engine, action.slug, action.source_id || 'default');
  const routeAllowed = toolRoute?.selected_tools ?? [];
  const routeBlocked = toolRoute?.blocked_tools ?? [];

  return {
    toolRoute,
    toolScope: {
      allowed: action.allowed_tools.length > 0 ? action.allowed_tools : routeAllowed,
      blocked: unique([...(action.blocked_tools ?? []), ...routeBlocked]),
    },
    routeContextText: renderActionToolRouteForPrompt(toolRoute),
    planText: renderActionPlanForPrompt(plan),
    ...(opts.userPrompt ? { userPrompt: opts.userPrompt } : {}),
  };
}

async function loadPersistedToolRoute(
  engine: BrainEngine,
  action: ActionRecord,
): Promise<ActionToolRoute | null> {
  try {
    const rows = await engine.executeRaw<{ tool_route_json: unknown }>(
      `SELECT tool_route_json FROM action_index WHERE source_id = $1 AND slug = $2`,
      [action.source_id, action.slug],
    );
    return normalizeActionToolRoute(rows[0]?.tool_route_json);
  } catch {
    return null;
  }
}

function renderActionPlanForPrompt(plan: ActionPlan | null): string {
  if (!plan?.plan.length) return '';
  return [
    '## Persisted Action Plan',
    '',
    ...plan.plan.flatMap((phase, index) => [
      `${index + 1}. ${phase.phase.replace(/^\d+\.\s*/, '')}`,
      ...phase.steps.map(step => `- [${step.done ? 'x' : ' '}] ${step.text}${step.note ? `\n  Note: ${step.note}` : ''}`),
    ]),
    '',
    'Use this persisted plan as the execution todo list. Checked steps are already complete unless the user asks you to revisit them.',
  ].join('\n');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

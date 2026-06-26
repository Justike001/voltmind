import { chat as gatewayChat, isAvailable as gatewayIsAvailable } from './ai/gateway.ts';
import {
  scanPluginRegistry,
  type PluginDescriptor,
  type PluginRegistry,
} from './plugin-registry.ts';
import type { ActionRecord } from './actions.ts';

export type ActionToolRouteSource = 'auto' | 'llm' | 'user';

export interface ActionToolRouteSkill {
  name: string;
  description: string;
}

export interface ActionToolRouteCandidate {
  plugin: string;
  display_name: string;
  description: string;
  icon_data_url?: string;
  category: string;
  score: number;
  reason: string;
  skills: ActionToolRouteSkill[];
  tools: string[];
}

export interface ActionToolRoute {
  version: 1;
  source: ActionToolRouteSource;
  generated_at: string;
  selected_plugins: string[];
  selected_tools: string[];
  blocked_tools: string[];
  confidence: number;
  reason: string;
  candidates: ActionToolRouteCandidate[];
  notes?: string;
}

type RouteActionInput = Pick<
  ActionRecord,
  'title' | 'allowed_tools' | 'blocked_tools' | 'agent_contract'
>;

type RerankChat = (opts: {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  maxTokens?: number;
}) => Promise<{ text: string }>;

export interface RouteActionToolsOptions {
  registry?: PluginRegistry;
  pluginProviders?: string[];
  includeAllPlugins?: boolean;
  allowLlm?: boolean;
  maxCandidates?: number;
  now?: Date;
  chat?: RerankChat;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'onto', 'your',
  'you', 'are', 'is', 'was', 'were', 'will', 'can', 'should', 'would', 'could',
  'action', 'task', 'plan', 'draft', 'make', 'create', 'update', 'review',
]);

const DEFAULT_ROUTE_PLUGIN_ORDER = [
  'outlook-email',
  'teams',
  'outlook-calendar',
  'browser',
  'chrome',
];

export async function routeActionTools(
  action: RouteActionInput,
  opts: RouteActionToolsOptions = {},
): Promise<ActionToolRoute> {
  const registry = opts.registry ?? await scanPluginRegistry({ providers: opts.pluginProviders });
  return routeActionToolsFromRegistry(action, registry, opts);
}

export async function routeActionToolsFromRegistry(
  action: RouteActionInput,
  registry: PluginRegistry,
  opts: RouteActionToolsOptions = {},
): Promise<ActionToolRoute> {
  const maxCandidates = Math.max(1, Math.min(opts.maxCandidates ?? (opts.includeAllPlugins ? 50 : 5), 50));
  const candidates = rankCandidates(action, registry, opts.includeAllPlugins === true).slice(0, maxCandidates);
  const base = buildAutoRoute(action, candidates, opts.now);

  if (!shouldUseLlmRerank(candidates, opts.allowLlm ?? true)) return base;
  const chat: RerankChat | null = opts.chat ?? (gatewayIsAvailable('chat')
    ? async request => gatewayChat(request as Parameters<typeof gatewayChat>[0])
    : null);
  if (!chat) return base;

  try {
    const reranked = await rerankWithLlm(action, base, chat, opts.now);
    return reranked ?? base;
  } catch {
    return base;
  }
}

export function buildUserActionToolRoute(
  base: ActionToolRoute | null,
  input: {
    selected_plugins?: string[];
    selected_tools?: string[];
    blocked_tools?: string[];
    notes?: string;
  },
  now = new Date(),
): ActionToolRoute {
  const selectedPlugins = uniqueStrings(input.selected_plugins ?? base?.selected_plugins ?? []);
  const selectedTools = uniqueStrings(input.selected_tools ?? base?.selected_tools ?? []);
  const blockedTools = uniqueStrings(input.blocked_tools ?? base?.blocked_tools ?? []);

  return {
    version: 1,
    source: 'user',
    generated_at: now.toISOString(),
    selected_plugins: selectedPlugins,
    selected_tools: selectedTools,
    blocked_tools: blockedTools,
    confidence: 1,
    reason: selectedPlugins.length || selectedTools.length
      ? 'User-selected route from the Admin Action tool picker.'
      : 'User cleared the selected tool route.',
    candidates: base?.candidates ?? [],
    ...(input.notes ? { notes: input.notes.slice(0, 500) } : {}),
  };
}

export function normalizeActionToolRoute(value: unknown): ActionToolRoute | null {
  const raw = parseJsonObject(value);
  if (!raw) return null;
  const candidatesRaw = Array.isArray(raw.candidates) ? raw.candidates : [];
  const candidates = candidatesRaw.map(normalizeCandidate).filter((c): c is ActionToolRouteCandidate => Boolean(c));
  const source = raw.source === 'llm' || raw.source === 'user' ? raw.source : 'auto';
  const generated = typeof raw.generated_at === 'string' && raw.generated_at ? raw.generated_at : new Date(0).toISOString();
  return {
    version: 1,
    source,
    generated_at: generated,
    selected_plugins: uniqueStrings(raw.selected_plugins),
    selected_tools: uniqueStrings(raw.selected_tools),
    blocked_tools: uniqueStrings(raw.blocked_tools),
    confidence: clamp01(Number(raw.confidence ?? 0)),
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : '',
    candidates,
    ...(typeof raw.notes === 'string' ? { notes: raw.notes.slice(0, 500) } : {}),
  };
}

export function renderActionToolRouteForPrompt(route: ActionToolRoute | null): string {
  if (!route) return '';
  const plugins = route.selected_plugins.map(p => '@' + p).join(', ') || '(none selected)';
  const tools = route.selected_tools.join(', ') || '(no explicit tool allowlist)';
  const blocked = route.blocked_tools.length ? `\nBlocked tools: ${route.blocked_tools.join(', ')}` : '';
  const candidateHint = route.candidates.length
    ? `\nTop candidate: @${route.candidates[0]!.plugin} (${Math.round(route.candidates[0]!.score)} score) - ${route.candidates[0]!.reason}`
    : '';
  return [
    '## Action Tool Route',
    '',
    `Selected route: ${plugins}`,
    `Selected tools: ${tools}${blocked}`,
    `Route source: ${route.source}; confidence: ${Math.round(route.confidence * 100)}%`,
    route.reason ? `Reason: ${route.reason}` : '',
    candidateHint,
    '',
    'Codex already has plugin skill procedures and MCP tool schemas loaded. Use the selected route directly; do not re-read plugin files.',
  ].filter(Boolean).join('\n');
}

function rankCandidates(action: RouteActionInput, registry: PluginRegistry, includeAllPlugins = false): ActionToolRouteCandidate[] {
  const queryTerms = buildQueryTerms(action);
  const allowedNorm = uniqueStrings(action.allowed_tools).map(normalizeId);

  const ranked = registry.plugins
    .map(plugin => scorePlugin(plugin, queryTerms, allowedNorm))
    .filter(scored => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.plugin.name.localeCompare(b.plugin.name))
    .map(scored => toCandidate(scored.plugin, scored.score, scored.reasons));

  if (includeAllPlugins) {
    const seen = new Set(ranked.map(candidate => candidate.plugin));
    const rest = fallbackRouteCandidates(registry)
      .filter(candidate => !seen.has(candidate.plugin));
    return [...ranked, ...rest];
  }

  if (ranked.length > 0) return ranked;

  return fallbackRouteCandidates(registry);
}

function scorePlugin(
  plugin: PluginDescriptor,
  queryTerms: string[],
  allowedNorm: string[],
): { plugin: PluginDescriptor; score: number; reasons: string[] } {
  const pluginName = normalizeId(plugin.name);
  const displayName = normalizeId(plugin.displayName);
  const description = normalizeText(plugin.description);
  const category = normalizeText(plugin.category);
  const skillText = normalizeText(plugin.skills.map(skill => `${skill.name} ${skill.description}`).join(' '));
  const toolNames = uniqueStrings(plugin.skills.flatMap(skill => skill.referencedTools));
  const toolText = normalizeId(toolNames.join(' '));
  const reasons = new Set<string>();
  let score = 0;

  for (const allowed of allowedNorm) {
    if (!allowed) continue;
    if (pluginName.includes(allowed) || allowed.includes(pluginName) || displayName.includes(allowed)) {
      score += 100;
      reasons.add(`allowed_tools matched ${plugin.name}`);
    }
    if (toolText.includes(allowed)) {
      score += 80;
      reasons.add('allowed_tools matched a referenced tool');
    }
  }

  for (const term of queryTerms) {
    if (pluginName.includes(term)) {
      score += 8;
      reasons.add(`plugin name matched "${term}"`);
    }
    if (displayName.includes(term)) score += 6;
    if (skillText.includes(term)) {
      score += 4;
      reasons.add(`skill description matched "${term}"`);
    }
    if (toolText.includes(term)) {
      score += 5;
      reasons.add(`tool reference matched "${term}"`);
    }
    if (description.includes(term)) score += 2;
    if (category.includes(term)) score += 1;
  }

  return { plugin, score, reasons: [...reasons].slice(0, 3) };
}

function toCandidate(plugin: PluginDescriptor, score: number, reasons: string[]): ActionToolRouteCandidate {
  return {
    plugin: plugin.name,
    display_name: plugin.displayName,
    description: compact(plugin.description, 240),
    ...(plugin.iconDataUrl ? { icon_data_url: plugin.iconDataUrl } : {}),
    category: plugin.category || 'Other',
    score,
    reason: reasons.length ? reasons.join('; ') : `Matched ${plugin.displayName}`,
    skills: plugin.skills.slice(0, 6).map(skill => ({
      name: skill.name,
      description: compact(skill.description, 220),
    })),
    tools: uniqueStrings(plugin.skills.flatMap(skill => skill.referencedTools)).slice(0, 20),
  };
}

function buildAutoRoute(
  action: RouteActionInput,
  candidates: ActionToolRouteCandidate[],
  now = new Date(),
): ActionToolRoute {
  const explicitTools = uniqueStrings(action.allowed_tools);
  const explicitBlocked = uniqueStrings(action.blocked_tools);
  const top = candidates[0] ?? null;
  const score = Math.max(0, top?.score ?? 0);
  const selectedPlugins = explicitTools.length
    ? candidates.filter(c => explicitTools.some(t => normalizeId(c.plugin).includes(normalizeId(t)) || normalizeId(t).includes(normalizeId(c.plugin)))).map(c => c.plugin)
    : score > 0 ? candidates.slice(0, 1).map(c => c.plugin) : [];
  const selectedTools = explicitTools.length
    ? explicitTools
    : score > 0 ? uniqueStrings(top?.tools ?? []).slice(0, 12) : [];

  return {
    version: 1,
    source: 'auto',
    generated_at: now.toISOString(),
    selected_plugins: selectedPlugins,
    selected_tools: selectedTools,
    blocked_tools: explicitBlocked,
    confidence: score > 0 ? clamp01(score / (score + 16)) : 0,
    reason: score > 0 && top ? top.reason : 'No confident route matched this action. Showing installed Codex plugin candidates for manual selection.',
    candidates,
  };
}

function fallbackRouteCandidates(registry: PluginRegistry): ActionToolRouteCandidate[] {
  const byName = new Map(registry.plugins.map(plugin => [plugin.name, plugin]));
  const preferred = DEFAULT_ROUTE_PLUGIN_ORDER
    .map(name => byName.get(name))
    .filter((plugin): plugin is PluginDescriptor => Boolean(plugin));
  const remaining = registry.plugins
    .filter(plugin => !DEFAULT_ROUTE_PLUGIN_ORDER.includes(plugin.name))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return [...preferred, ...remaining]
    .slice(0, 8)
    .map(plugin => toCandidate(plugin, 0, [
      'Installed Codex plugin from plugin manifest and skill YAML descriptions',
    ]));
}

function shouldUseLlmRerank(candidates: ActionToolRouteCandidate[], allowLlm: boolean): boolean {
  if (!allowLlm || candidates.length < 2) return false;
  const [first, second] = candidates;
  if (!first || !second) return false;
  return first.score < 20 || (first.score - second.score) <= 4;
}

async function rerankWithLlm(
  action: RouteActionInput,
  base: ActionToolRoute,
  chat: RerankChat,
  now = new Date(),
): Promise<ActionToolRoute | null> {
  const allowedPlugins = new Set(base.candidates.map(c => c.plugin));
  const allowedTools = new Set(base.candidates.flatMap(c => c.tools));
  for (const tool of action.allowed_tools ?? []) allowedTools.add(tool);

  const result = await chat({
    system: [
      'You choose the minimal plugin/tool route for a VoltMind action.',
      'Return ONLY JSON with selected_plugins, selected_tools, confidence, and reason.',
      'Do not invent plugin names outside the candidate list.',
    ].join('\n'),
    messages: [{
      role: 'user',
      content: JSON.stringify({
        action: routeActionSummary(action),
        candidates: base.candidates.map(c => ({
          plugin: c.plugin,
          display_name: c.display_name,
          description: c.description,
          skills: c.skills,
          tools: c.tools,
          score: c.score,
          reason: c.reason,
        })),
      }),
    }],
    maxTokens: 700,
  });

  const parsed = parseJsonObject(result.text);
  if (!parsed) return null;
  const selectedPlugins = uniqueStrings(parsed.selected_plugins).filter(p => allowedPlugins.has(p));
  const selectedTools = uniqueStrings(parsed.selected_tools).filter(t => allowedTools.has(t));
  if (selectedPlugins.length === 0 && selectedTools.length === 0) return null;

  return {
    ...base,
    source: 'llm',
    generated_at: now.toISOString(),
    selected_plugins: selectedPlugins.length ? selectedPlugins : base.selected_plugins,
    selected_tools: selectedTools.length ? selectedTools : base.selected_tools,
    confidence: clamp01(Number(parsed.confidence ?? base.confidence)),
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : base.reason,
  };
}

function routeActionSummary(action: RouteActionInput): Record<string, unknown> {
  const contract = action.agent_contract ?? {};
  return {
    title: action.title,
    objective: typeof contract.objective === 'string' ? contract.objective : '',
    success_criteria: Array.isArray(contract.success_criteria) ? contract.success_criteria.map(String) : [],
    context_refs: Array.isArray(contract.context_refs) ? contract.context_refs.map(String) : [],
    allowed_tools: action.allowed_tools ?? [],
    blocked_tools: action.blocked_tools ?? [],
  };
}

function buildQueryTerms(action: RouteActionInput): string[] {
  const summary = routeActionSummary(action);
  const text = [
    summary.title,
    summary.objective,
    ...(summary.success_criteria as string[]),
    ...(summary.context_refs as string[]),
    ...(summary.allowed_tools as string[]),
  ].join(' ');
  return uniqueStrings(
    normalizeText(text)
      .split(/\s+/)
      .map(term => term.trim())
      .filter(term => term.length > 2 && !STOP_WORDS.has(term)),
  );
}

function normalizeCandidate(value: unknown): ActionToolRouteCandidate | null {
  const raw = parseJsonObject(value);
  if (!raw || typeof raw.plugin !== 'string') return null;
  return {
    plugin: raw.plugin,
    display_name: typeof raw.display_name === 'string' ? raw.display_name : raw.plugin,
    description: typeof raw.description === 'string' ? raw.description : '',
    ...(typeof raw.icon_data_url === 'string' ? { icon_data_url: raw.icon_data_url } : {}),
    category: typeof raw.category === 'string' ? raw.category : 'Other',
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    skills: Array.isArray(raw.skills) ? raw.skills.map(normalizeSkill).filter((s): s is ActionToolRouteSkill => Boolean(s)) : [],
    tools: uniqueStrings(raw.tools),
  };
}

function normalizeSkill(value: unknown): ActionToolRouteSkill | null {
  const raw = parseJsonObject(value);
  if (!raw || typeof raw.name !== 'string') return null;
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean))];
}

function normalizeId(value: string): string {
  return normalizeText(value.replace(/[-_./:]+/g, ' '));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function compact(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1).trimEnd() + '...' : oneLine;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

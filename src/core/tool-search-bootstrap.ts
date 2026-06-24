/**
 * ToolSearchBootstrap — bridges Action context with the PluginRegistry.
 *
 * Before a harness agent executes an action, this module:
 *   1. Scans the local Codex plugin cache (PluginRegistry)
 *   2. Matches the action's objective, title, and allowed_tools against
 *      available plugins and skills
 *   3. Returns a structured ToolSearchResult with:
 *      - Ranked matching plugins + their skill procedures
 *      - Suggested tool scope constraints
 *      - Ready-to-inject context text for the harness prompt
 *
 * Phase 1: simple keyword matching. Phase 2 can add embedding-based search.
 */

import { scanPluginRegistry, searchPlugins, searchSkills, type PluginRegistry, type PluginDescriptor, type SkillDescriptor } from './plugin-registry.ts';
import type { ActionRecord } from './actions.ts';
import type { ToolScope } from './action-executor.ts';

/* ── Types ───────────────────────────────────────────────── */

export interface ToolSearchResult {
  /** Plugins matched to this action, ranked by relevance */
  matchedPlugins: PluginDescriptor[];
  /** Skills matched to this action, ranked by relevance */
  matchedSkills: SkillDescriptor[];
  /** Suggested tool scope based on matched plugins (can be merged with action.allowed_tools) */
  toolScopeSuggestion: ToolScope;
  /** Ready-to-inject text block describing available plugins, skills, and tools */
  contextText: string;
}

/* ── Bootstrap function ──────────────────────────────────── */

/**
 * Run the tool search bootstrap against an action.
 *
 * Builds a search query from the action's objective, title, and allowed_tools,
 * then queries the PluginRegistry for relevant plugins and skills.
 *
 * The returned contextText is designed to be injected directly into
 * the HarnessAgent's buildPrompt output — Codex interactive will see
 * a "## Available Plugins & Skills" section in its initial context.
 */
/**
 * Find relevant plugins with prioritised matching.
 * Plugins whose name matches an allowed_tool get top priority.
 * Others are ranked by keyword match on the full query.
 */
function findRelevantPlugins(
  registry: PluginRegistry,
  query: string,
  allowedTools: string[],
  maxResults: number,
): PluginDescriptor[] {
  const normalize = (s: string) => s.replace(/[-_]/g, ' ').toLowerCase();

  // If allowed_tools is specified, these are the ONLY plugins we recommend.
  // The user explicitly chose which tools to use — keyword search on the
  // full action text would introduce noise (false positives).
  if (allowedTools.length > 0) {
    const toolsNorm = allowedTools.map(normalize);
    const seen = new Set<string>();
    const matches: PluginDescriptor[] = [];

    for (const plugin of registry.plugins) {
      const pluginNorm = normalize(plugin.name + ' ' + plugin.displayName);
      if (toolsNorm.some(t => pluginNorm.includes(t)) && !seen.has(plugin.name)) {
        seen.add(plugin.name);
        matches.push(plugin);
      }
    }
    return matches.slice(0, maxResults);
  }

  // No allowed_tools specified: fall back to keyword search on action text
  return searchPlugins(registry, query, maxResults);
}

export async function bootstrapToolSearch(
  action: ActionRecord,
): Promise<ToolSearchResult> {
  const registry = await scanPluginRegistry();

  // Build search query from action context.
  // Priority: 1) allowed_tools (strongest signal), 2) action title, 3) objective.
  const contract = (action.agent_contract ?? {}) as Record<string, unknown>;
  const objective = typeof contract.objective === 'string' ? contract.objective : '';

  // Normalize plugin/tool identifiers: turn both hyphens and underscores into
  // spaces so "outlook_email" matches "outlook-email".
  const normalizeId = (s: string) => s.replace(/[-_]/g, ' ');

  const toolQuery = (action.allowed_tools ?? [])
    .map(normalizeId)
    .join(' ');

  const titleQuery = normalizeId(action.title);
  const objectiveQuery = normalizeId(objective);

  // Phase 1 query: allowed_tools have highest signal weight
  const query = toolQuery + ' ' + titleQuery + ' ' + objectiveQuery;

  // Pass the normalized allowed tools for exact matching
  const matchedPlugins = findRelevantPlugins(registry, query, action.allowed_tools ?? [], 5);
  const matchedSkills = searchSkills(registry, query, 10);

  // Build tool scope suggestion: all tool names from matched plugins
  const suggestedTools = new Set<string>();
  for (const plugin of matchedPlugins) {
    for (const skill of plugin.skills) {
      for (const tool of skill.referencedTools) {
        suggestedTools.add(tool);
      }
    }
  }

  const toolScopeSuggestion: ToolScope = {
    allowed: action.allowed_tools && action.allowed_tools.length > 0
      ? action.allowed_tools
      : [...suggestedTools],
    blocked: action.blocked_tools ?? [],
  };

  // Build context text
  const contextText = buildToolContextText(matchedPlugins, matchedSkills);

  return { matchedPlugins, matchedSkills, toolScopeSuggestion, contextText };
}

/* ── Context text builder ────────────────────────────────── */

function buildToolContextText(
  plugins: PluginDescriptor[],
  skills: SkillDescriptor[],
): string {
  // IMPORTANT: In Codex interactive mode, Codex already loads plugin SKILL.md
  // files into its own context. We must NOT duplicate the skill procedure text
  // here — that would waste context window space and confuse the model.
  //
  // Instead, we only inject a lightweight "relevance map":
  //   - Which plugins/skills match this action and WHY
  //   - Which plugins were ruled out
  //   - Brief guidance on which specific skill to invoke
  //
  // Codex handles the actual skill loading and procedure injection itself.

  if (plugins.length === 0) return '';

  const lines: string[] = [
    '## Plugins Relevant to This Action',
    '',
    'The Tool Search Bootstrap analyzed this action and identified the following',
    'matching plugins. Codex already has these plugins loaded — use their @name',
    'directly. Do NOT re-read or re-load plugin files.',
    '',
  ];

  for (const plugin of plugins) {
    const pluginSkills = skills.filter(s =>
      plugin.skills.some(ps => ps.name === s.name),
    );
    const matchTerms = extractMatchTerms(plugin.name, plugin.description);

    lines.push('- **@' + plugin.name + '** (' + plugin.displayName + ')');
    lines.push('  Matched on: ' + matchTerms.join(', '));
    if (pluginSkills.length > 0) {
      const skillNames = pluginSkills.slice(0, 3).map(s => s.name).join(', ');
      lines.push('  Suggested skills: ' + skillNames);
    }
  }

  // Not-matched plugins (ruled out)
  const matchedNames = new Set(plugins.map(p => p.name));
  if (matchedNames.size > 0) {
    lines.push('');
    lines.push('Other available plugins (not relevant to this specific task):');
    // We would need the full registry for this; skip in v1
    lines.push('- (use @name if needed anyway)');
  }

  lines.push('');
  lines.push('The codex runtime has already loaded all plugin procedures. Execute the');
  lines.push('task directly using the referenced @plugin names and their skills.');

  return lines.join('\n');
}

/* ── Helpers ─────────────────────────────────────────────── */

function extractMatchTerms(pluginName: string, pluginDescription: string): string[] {
  // Return simple keyword tags explaining why this plugin matched
  const name = pluginName.toLowerCase();
  const terms: string[] = [];
  if (name.includes('email') || name.includes('outlook')) terms.push('email');
  if (name.includes('teams')) terms.push('teams/chat');
  if (name.includes('calendar')) terms.push('calendar');
  if (name.includes('browser')) terms.push('browser');
  if (name.includes('github')) terms.push('github');
  if (name.includes('sharepoint')) terms.push('sharepoint');
  if (terms.length === 0) terms.push(name);
  return terms;
}

/* ── Lazy-load registry singleton ────────────────────────── */

let _cachedRegistry: PluginRegistry | null = null;

export async function getPluginRegistry(): Promise<PluginRegistry> {
  if (!_cachedRegistry) {
    _cachedRegistry = await scanPluginRegistry();
  }
  return _cachedRegistry;
}

export function clearPluginRegistryCache(): void {
  _cachedRegistry = null;
}

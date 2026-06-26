/**
 * PluginRegistry — scans the local Codex plugin cache and builds a
 * structured index of available plugins, skills, and referenced tools.
 *
 * Used by ToolSearchBootstrap and ActionToolRouter to match action context
 * against available capabilities. The registry intentionally exposes only
 * manifest fields, skill frontmatter descriptions, and referenced tool names;
 * Codex owns full skill procedure loading in its own runtime.
 *
 * Plugin cache layout (standard Codex install):
 *   ~/.codex/plugins/cache/
 *     openai-curated/
 *       outlook-email/<version>/
 *         .codex-plugin/plugin.json
 *         skills/
 *           outlook-email/SKILL.md
 *           outlook-email-inbox-triage/SKILL.md
 *           ...
 *     openai-curated-remote/
 *       outlook-calendar/<version>/
 *         ...
 */

import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

/* ── Types ───────────────────────────────────────────────── */

export interface PluginDescriptor {
  /** Directory name (e.g. "outlook-email") */
  name: string;
  /** Human-readable display name from plugin.json interface.displayName */
  displayName: string;
  /** Long description from plugin.json interface.longDescription */
  description: string;
  /** Small data URL icon loaded from assets/*.png when available */
  iconDataUrl?: string;
  /** Category from plugin.json interface.category */
  category: string;
  /** Absolute path to the plugin root directory */
  repoPath: string;
  /** Skills declared by this plugin */
  skills: SkillDescriptor[];
}

export interface SkillDescriptor {
  /** Skill name from SKILL.md frontmatter */
  name: string;
  /** Skill description from SKILL.md frontmatter */
  description: string;
  /** Short description from a skill agents/openai.yaml when present */
  agentDescription?: string;
  /** Display name from a skill agents/openai.yaml when present */
  agentDisplayName?: string;
  /** Tool names referenced in the "Relevant Actions" section */
  referencedTools: string[];
  /** Absolute path to the SKILL.md file */
  filePath: string;
}

export interface PluginRegistry {
  plugins: PluginDescriptor[];
  /** Flat index: skill name → SkillDescriptor */
  skillIndex: Map<string, SkillDescriptor>;
  /** Flat index: tool name → set of plugin names that provide it */
  toolIndex: Map<string, string[]>;
}

export interface ScanPluginRegistryOptions {
  providers?: string[];
}

/* ── Scanner ─────────────────────────────────────────────── */

const CODEX_PLUGIN_CACHE = join(homedir(), '.codex', 'plugins', 'cache');
const PREFERRED_PLUGIN_PROVIDERS = ['openai-curated', 'openai-curated-remote', 'openai-bundled'];

/**
 * Scan the local Codex plugin cache and build a PluginRegistry.
 * Returns empty registry if the cache directory doesn't exist.
 */
export async function scanPluginRegistry(opts: ScanPluginRegistryOptions = {}): Promise<PluginRegistry> {
  const plugins: PluginDescriptor[] = [];
  const skillIndex = new Map<string, SkillDescriptor>();
  const toolIndex = new Map<string, string[]>();
  const providerAllowList = opts.providers?.length ? new Set(opts.providers) : null;

  if (!existsSync(CODEX_PLUGIN_CACHE)) {
    return { plugins, skillIndex, toolIndex };
  }

  // Walk the cache directory: provider → plugin-name → version
  const providers = (await readdir(CODEX_PLUGIN_CACHE, { withFileTypes: true }))
    .sort((a, b) => providerRank(a.name) - providerRank(b.name) || a.name.localeCompare(b.name));
  for (const provider of providers) {
    if (!provider.isDirectory()) continue;
    if (providerAllowList && !providerAllowList.has(provider.name)) continue;
    const providerPath = join(CODEX_PLUGIN_CACHE, provider.name);
    const pluginDirs = await readdir(providerPath, { withFileTypes: true });
    for (const pluginDir of pluginDirs) {
      if (!pluginDir.isDirectory()) continue;
      const pluginBase = join(providerPath, pluginDir.name);

      // Each plugin-name dir may contain versioned subdirectories
      const versions = await readdir(pluginBase, { withFileTypes: true });
      for (const version of versions) {
        if (!version.isDirectory()) continue;
        const versionPath = join(pluginBase, version.name);

        const descriptor = await parsePluginDir(pluginDir.name, versionPath);
        if (descriptor) {
          plugins.push(descriptor);
          for (const skill of descriptor.skills) {
            skillIndex.set(skill.name, skill);
            for (const tool of skill.referencedTools) {
              const providers = toolIndex.get(tool) ?? [];
              providers.push(descriptor.name);
              toolIndex.set(tool, providers);
            }
          }
        }
      }
    }
  }

  return { plugins, skillIndex, toolIndex };
}

function providerRank(name: string): number {
  const index = PREFERRED_PLUGIN_PROVIDERS.indexOf(name);
  return index >= 0 ? index : PREFERRED_PLUGIN_PROVIDERS.length;
}

async function parsePluginDir(
  dirName: string,
  versionPath: string,
): Promise<PluginDescriptor | null> {
  const pluginJsonPath = join(versionPath, '.codex-plugin', 'plugin.json');
  if (!existsSync(pluginJsonPath)) return null;

  try {
    const raw = await readFile(pluginJsonPath, 'utf-8');
    const manifest = JSON.parse(raw);

    const skillsDir = join(versionPath, 'skills');
    const skills = existsSync(skillsDir)
      ? await scanSkills(skillsDir)
      : [];
    const primarySkill = skills.find(skill => skill.name === dirName) ?? skills[0];
    const yamlDescription = primarySkill?.agentDescription;
    const yamlDisplayName = primarySkill?.agentDisplayName;
    const iconDataUrl = await loadPluginIconDataUrl(versionPath, dirName);

    return {
      name: manifest.name ?? dirName,
      displayName: yamlDisplayName ?? manifest.interface?.displayName ?? dirName,
      description: yamlDescription ?? manifest.interface?.longDescription ?? manifest.description ?? '',
      ...(iconDataUrl ? { iconDataUrl } : {}),
      category: manifest.interface?.category ?? 'Other',
      repoPath: versionPath,
      skills,
    };
  } catch {
    return null;
  }
}

async function scanSkills(skillsDir: string): Promise<SkillDescriptor[]> {
  const results: SkillDescriptor[] = [];
  const entries = await readdir(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

  try {
    const raw = await readFile(skillMdPath, 'utf-8');
      const skill = await parseSkillMarkdown(entry.name, raw, skillMdPath);
      if (skill) results.push(skill);
    } catch {
      // Skip unparseable skills
    }
  }

  return results;
}

async function parseSkillMarkdown(
  skillDirName: string,
  raw: string,
  filePath: string,
): Promise<SkillDescriptor | null> {
  // Extract YAML frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1]!;
  const body = fmMatch[2]!;

  // Parse simple YAML fields without a full YAML parser
  const name = extractYamlField(frontmatter, 'name') ?? skillDirName;
  const description = extractYamlField(frontmatter, 'description') ?? '';
  const agentMeta = await readSkillAgentMeta(filePath).catch(() => null);

  // Extract tool references from "## Relevant Actions" section
  const tools = extractReferencedTools(body);

  return {
    name,
    description,
    ...(agentMeta?.description ? { agentDescription: agentMeta.description } : {}),
    ...(agentMeta?.displayName ? { agentDisplayName: agentMeta.displayName } : {}),
    referencedTools: tools,
    filePath,
  };
}

async function readSkillAgentMeta(skillMdPath: string): Promise<{ displayName?: string; description?: string } | null> {
  const yamlPath = join(skillMdPath, '..', 'agents', 'openai.yaml');
  if (!existsSync(yamlPath)) return null;
  const raw = await readFile(yamlPath, 'utf-8');
  return {
    displayName: extractYamlField(raw, 'display_name') ?? undefined,
    description: extractYamlField(raw, 'short_description') ?? extractYamlField(raw, 'description') ?? undefined,
  };
}

async function loadPluginIconDataUrl(versionPath: string, pluginName: string): Promise<string | null> {
  const assetsDir = join(versionPath, 'assets');
  if (!existsSync(assetsDir)) return null;
  const entries = await readdir(assetsDir, { withFileTypes: true });
  const pngs = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
    .map(entry => entry.name)
    .sort((a, b) => iconRank(a, pluginName) - iconRank(b, pluginName) || a.localeCompare(b));
  const first = pngs[0];
  if (!first) return null;
  const bytes = await readFile(join(assetsDir, first));
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function iconRank(name: string, pluginName: string): number {
  const lower = name.toLowerCase();
  const plugin = pluginName.toLowerCase();
  if (lower === `${plugin}.png`) return 0;
  if (lower === 'logo.png') return 1;
  if (lower.includes('icon')) return 2;
  return 3;
}

function extractYamlField(frontmatter: string, key: string): string | null {
  const regex = new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm');
  const match = frontmatter.match(regex);
  if (!match) return null;
  return match[1]!.trim().replace(/^["']|["']$/g, '');
}

/**
 * Extract tool/action names referenced in the skill body.
 * Looks for backtick-quoted identifiers in "Relevant Actions" and similar sections,
 * filtering out non-alphanumeric patterns (e.g. links, Markdown formatting).
 */
function extractReferencedTools(body: string): string[] {
  const tools = new Set<string>();
  // Match backtick-quoted identifiers: `tool_name`, `ToolName`, `camelCase`
  const toolPattern = /`([a-zA-Z_][a-zA-Z0-9_]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = toolPattern.exec(body)) !== null) {
    const name = match[1]!;
    // Filter out common non-tool tokens
    if (/^(http|https|Urgent|Needs|Waiting|FYI|read|write|admin|Task|Owner|Due|Status|Evidence)$/.test(name)) continue;
    tools.add(name);
  }
  return [...tools];
}

/* ── Helpers ─────────────────────────────────────────────── */

/**
 * Search plugins by keyword match against display name, description,
 * and skill descriptions. Returns plugins ranked by relevance (naive scoring).
 */
export function searchPlugins(
  registry: PluginRegistry,
  query: string,
  maxResults = 10,
): PluginDescriptor[] {
  const queryLower = query.toLowerCase();
  // Extract meaningful terms: filter out short/common words
  const rawTerms = queryLower.split(/\s+/).filter(t => t.length > 1);
  const terms = [...new Set(rawTerms)];

  const minScore = 2; // Need at least 2 keyword matches or a name match

  const scored = registry.plugins.map(plugin => {
    let score = 0;
    // Score plugin name and display name separately (higher weight)
    const nameText = (plugin.name + ' ' + plugin.displayName).toLowerCase();
    for (const term of terms) {
      if (nameText.includes(term)) score += 3; // name match = strong signal
    }
    // Score description and skill descriptions (lower weight)
    const descText = (
      plugin.description + ' ' +
      plugin.skills.map(s => s.name + ' ' + s.description).join(' ')
    ).toLowerCase();
    for (const term of terms) {
      if (descText.includes(term)) score += 1;
    }

    return { plugin, score };
  });

  return scored
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.plugin);
}

/**
 * Search skills by keyword match against name and description.
 */
export function searchSkills(
  registry: PluginRegistry,
  query: string,
  maxResults = 10,
): SkillDescriptor[] {
  const queryLower = query.toLowerCase();
  const rawTerms = queryLower.split(/\s+/).filter(t => t.length > 1);
  const terms = [...new Set(rawTerms)];

  const minScore = 2;

  const scored = [...registry.skillIndex.values()].map(skill => {
    let score = 0;
    const text = (skill.name + ' ' + skill.description).toLowerCase();

    for (const term of terms) {
      if (text.includes(term)) score += 1;
      if (skill.name.includes(term)) score += 2;
    }

    return { skill, score };
  });

  return scored
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.skill);
}

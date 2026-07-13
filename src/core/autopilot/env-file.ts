/**
 * Runtime env-file loader (spec §5).
 *
 * `--runtime-env-file <path>` loads a `.env`-style file BEFORE engine
 * detection / Postgres init / provider init / Minion mode resolution. Only
 * an explicit allowlist of variables may be set; dangerous system vars
 * (PATH, ComSpec, SystemRoot, …) are refused so a misconfigured file can
 * never break the shell or scheduler.
 *
 * The file is a simple `KEY=VALUE` format (`#` comments, optional `export`
 * prefix, single-quoted values). No shell interpolation.
 */

import { readFileSync, existsSync } from 'fs';
import { isAbsolute } from 'path';
import {
  AUTOPILOT_ERRORS,
  AutopilotError,
} from './diagnostics.ts';

/** Variables a runtime env file is allowed to set. */
export const ENV_FILE_ALLOWLIST: readonly string[] = [
  // VoltMind runtime
  'VOLTMIND_DATABASE_URL',
  'VOLTMIND_HOME',
  'VOLTMIND_SOURCE',
  'VOLTMIND_AUTOPILOT_MAX_RECONNECT_FAILS',
  // Generic Postgres envs (postgres.js + Supabase)
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'PGSSL',
  'PGSSLMODE',
  'DIRECT_URL',
  // Supabase
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  // Provider API keys
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'VOYAGE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
];

/** Variables a runtime env file must NEVER override. */
export const ENV_FILE_BLOCKLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'ComSpec',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'SHELL',
  'PSModulePath',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PROCESSOR_ARCHITECTURE',
];

export interface LoadEnvFileResult {
  /** Variables actually set on process.env. */
  set: Record<string, string>;
  /** Variables skipped because they were not on the allowlist. */
  skipped: string[];
  /** The absolute path that was loaded. */
  path: string;
}

/**
 * Parse a `.env`-style file into a `KEY=VALUE` record. Pure; no env mutation.
 * Throws `AutopilotError` (stage `env-file`) on malformed input.
 */
export function parseEnvFile(content: string, source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let body = line;
    if (body.startsWith('export ') || body.startsWith('export\t')) {
      body = body.slice('export'.length).trim();
    }
    const eq = body.indexOf('=');
    if (eq < 0) {
      throw new AutopilotError({
        code: AUTOPILOT_ERRORS.ENV_FILE_INVALID,
        stage: 'env-file',
        message: `Malformed line ${i + 1} in ${source}: expected KEY=VALUE, got: ${raw}`,
      });
    }
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (!key) {
      throw new AutopilotError({
        code: AUTOPILOT_ERRORS.ENV_FILE_INVALID,
        stage: 'env-file',
        message: `Empty key on line ${i + 1} in ${source}`,
      });
    }
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load and apply a runtime env file to `process.env`. Enforces the allowlist
 * and blocklist. Returns what was set / skipped. The file MUST exist.
 *
 * Call this BEFORE engine detection / Postgres init. Existing `process.env`
 * values are NOT overwritten by the file unless the key is on the allowlist
 * and not on the blocklist — file values take precedence within the allowlist
 * (operators point `--runtime-env-file` at the authoritative secret store).
 */
export function loadRuntimeEnvFile(filePath: string, opts: { blocklist?: readonly string[]; allowlist?: readonly string[] } = {}): LoadEnvFileResult {
  if (!filePath) {
    return { set: {}, skipped: [], path: '' };
  }
  const abs = isAbsolute(filePath) ? filePath : resolvePath(filePath);
  if (!existsSync(abs)) {
    throw new AutopilotError({
      code: AUTOPILOT_ERRORS.ENV_FILE_INVALID,
      stage: 'env-file',
      message: `Runtime env file not found: ${abs}`,
      actionableHint: 'Create the file or omit --runtime-env-file.',
    });
  }
  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch (e) {
    throw new AutopilotError({
      code: AUTOPILOT_ERRORS.ENV_FILE_INVALID,
      stage: 'env-file',
      message: `Could not read runtime env file ${abs}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  const parsed = parseEnvFile(content, abs);
  const block = opts.blocklist ?? ENV_FILE_BLOCKLIST;
  const allow = new Set(opts.allowlist ?? ENV_FILE_ALLOWLIST);
  const set: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (block.includes(key)) {
      skipped.push(`${key} (blocklisted)`);
      continue;
    }
    if (!allow.has(key)) {
      skipped.push(`${key} (not on allowlist)`);
      continue;
    }
    process.env[key] = value;
    set[key] = value;
  }
  return { set, skipped, path: abs };
}

function resolvePath(p: string): string {
  // Resolve relative to cwd (matches how the CLI parses --repo / --runtime-env-file).
  return p;
}

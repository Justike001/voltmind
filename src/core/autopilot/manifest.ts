/**
 * Autopilot install manifest (spec §6).
 *
 * A single local JSON file at `<VOLTMIND_HOME>/autopilot-install.json`
 * records what was installed, for which target, with which CLI invocation
 * and optional env file. It is the reconcilable record of "the user opted
 * into autopilot on this host".
 *
 * Hard rules (spec §6 / §20):
 *   - No secrets. Only the env-file PATH is recorded, never its contents.
 *   - Never written to the database.
 *   - Windows paths / Task XML never enter the shared DB.
 *   - `install` vs `reconcile` are distinct: only an explicit `--install`
 *     may create a new manifest; upgrades / normal CLI starts never
 *     auto-enable autopilot for a never-installed user.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { voltmindPath } from '../config.ts';
import type { InstallTarget } from './diagnostics.ts';
import type { CliInvocation } from './cli-invocation.ts';

export interface AutopilotInstallManifest {
  schemaVersion: number;
  installVersion: string;
  target: InstallTarget;
  repoPath: string;
  cliInvocation: {
    executable: string;
    prefixArgs: string[];
    source: CliInvocation['source'];
  };
  runtimeEnvFile?: string;
  scheduler?: {
    taskName?: string;
    serviceName?: string;
  };
  installedAt: string;
  reconciledAt: string;
}

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FILENAME = 'autopilot-install.json';

export function manifestPath(): string {
  return voltmindPath(MANIFEST_FILENAME);
}

export function loadManifest(): AutopilotInstallManifest | null {
  const p = manifestPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as AutopilotInstallManifest;
    if (typeof parsed.schemaVersion !== 'number' || typeof parsed.target !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveManifest(manifest: AutopilotInstallManifest): void {
  const dir = voltmindPath();
  mkdirSync(dir, { recursive: true });
  // Atomic-ish write: write to temp then rename would be ideal, but a
  // direct write is acceptable for a local metadata file. We at least
  // guarantee the directory exists and the JSON is well-formed.
  writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + '\n');
}

export function deleteManifest(): void {
  const p = manifestPath();
  if (existsSync(p)) {
    try { unlinkSync(p); } catch { /* best-effort */ }
  }
}

export interface ManifestUpdate {
  repoPath?: string;
  cliInvocation?: { executable: string; prefixArgs: string[]; source: CliInvocation['source'] };
  runtimeEnvFile?: string;
  scheduler?: { taskName?: string; serviceName?: string };
  installVersion?: string;
}

/**
 * Reconcile an existing manifest. Only updates fields the caller supplies;
 * never creates a manifest if none exists (returns null). Does not change the
 * user's "is autopilot enabled" intent.
 */
export function reconcileManifest(
  existing: AutopilotInstallManifest,
  update: ManifestUpdate,
): AutopilotInstallManifest {
  const next: AutopilotInstallManifest = {
    ...existing,
    repoPath: update.repoPath ?? existing.repoPath,
    cliInvocation: update.cliInvocation ?? existing.cliInvocation,
    runtimeEnvFile: update.runtimeEnvFile ?? existing.runtimeEnvFile,
    scheduler: update.scheduler ?? existing.scheduler,
    installVersion: update.installVersion ?? existing.installVersion,
    reconciledAt: new Date().toISOString(),
  };
  return next;
}

/** Create a brand-new manifest (install path). */
export function createManifest(input: {
  target: InstallTarget;
  repoPath: string;
  cliInvocation: { executable: string; prefixArgs: string[]; source: CliInvocation['source'] };
  runtimeEnvFile?: string;
  scheduler?: { taskName?: string; serviceName?: string };
  installVersion: string;
}): AutopilotInstallManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    installVersion: input.installVersion,
    target: input.target,
    repoPath: input.repoPath,
    cliInvocation: input.cliInvocation,
    runtimeEnvFile: input.runtimeEnvFile,
    scheduler: input.scheduler,
    installedAt: now,
    reconciledAt: now,
  };
}

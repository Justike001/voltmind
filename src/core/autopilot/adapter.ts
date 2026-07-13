/**
 * Autopilot process-manager adapter contract (spec §2.2).
 *
 * Every platform's install/uninstall/status path implements this interface.
 * The platform-agnostic `runAutopilot()`, `ChildWorkerSupervisor`,
 * `MinionQueue`, and `jobs work` are NOT part of this adapter — the adapter
 * only ensures the autopilot process keeps running.
 *
 * Windows Task Scheduler must NOT directly submit jobs, run `jobs work`,
 * create a second worker, manage Postgres leases, or persist business state.
 */

import type { InstallTarget, AutopilotFailureStage } from './diagnostics.ts';
import type { CliInvocation } from './cli-invocation.ts';

export interface AdapterDetectionContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  forcedTarget?: string;
}

export interface AdapterDetectionResult {
  target: InstallTarget;
  warnings?: string[];
}

export interface AutopilotInstallContext {
  target: InstallTarget;
  repoPath: string;
  cliInvocation: CliInvocation;
  runtimeEnvFile?: string;
  /** Working directory for the task action (usually repo root). */
  workingDirectory?: string;
  /** Windows user id for the task principal (optional). */
  userId?: string;
  /** Whether to auto-inject bootstrap for ephemeral containers. */
  injectBootstrap?: boolean;
  noInject?: boolean;
}

export interface AutopilotInstallResult {
  target: InstallTarget;
  registered: boolean;
  started: boolean;
  schedulerName?: string;
  detail?: string;
  warnings?: string[];
}

export interface AutopilotUninstallContext {
  manifest?: import('./manifest.ts').AutopilotInstallManifest;
}

export interface AutopilotUninstallResult {
  stopped: boolean;
  removed: boolean;
  detail?: string;
}

export interface AutopilotStatusContext {
  manifest?: import('./manifest.ts').AutopilotInstallManifest | null;
}

export interface AutopilotProcessManagerStatus {
  target: InstallTarget | 'unknown';
  registered: boolean;
  running: boolean;
  lastResult?: string;
  lastStartedAt?: string;
  currentState?: string;
  detail?: string;
}

export interface AutopilotProcessManagerAdapter {
  target: InstallTarget;
  detect(context: AdapterDetectionContext): Promise<AdapterDetectionResult>;
  install(context: AutopilotInstallContext): Promise<AutopilotInstallResult>;
  uninstall(context: AutopilotUninstallContext): Promise<AutopilotUninstallResult>;
  status(context: AutopilotStatusContext): Promise<AutopilotProcessManagerStatus>;
}

export function isStage(v: string): v is AutopilotFailureStage {
  return [
    'target-detection', 'preflight', 'config-load', 'env-file', 'repo-access',
    'cli-resolution', 'cli-validation', 'database-connection', 'manifest',
    'task-xml', 'task-registration', 'task-start', 'autopilot-start',
    'runtime-readiness', 'worker-spawn', 'worker-registration', 'uninstall',
  ].includes(v);
}

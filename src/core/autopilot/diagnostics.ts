/**
 * Autopilot diagnostics — structured error model.
 *
 * Every install / status / uninstall failure is classified by stage so the
 * operator (and `--json` consumers) can route to the right fix. Errors are
 * never bare strings; `AutopilotDiagnosticError` carries a stable code,
 * the stage that failed, a human message, an optional cause, and an
 * actionable hint.
 *
 * This module is platform-agnostic and has zero runtime side effects so it
 * can be unit-tested in isolation.
 */

export type InstallTarget =
  | 'macos'
  | 'linux-systemd'
  | 'linux-cron'
  | 'ephemeral-container'
  | 'windows-task';

export const ALL_INSTALL_TARGETS: readonly InstallTarget[] = [
  'macos',
  'linux-systemd',
  'linux-cron',
  'ephemeral-container',
  'windows-task',
];

export function isInstallTarget(value: string): value is InstallTarget {
  return (ALL_INSTALL_TARGETS as readonly string[]).includes(value);
}

export type AutopilotFailureStage =
  | 'target-detection'
  | 'preflight'
  | 'config-load'
  | 'env-file'
  | 'repo-access'
  | 'cli-resolution'
  | 'cli-validation'
  | 'database-connection'
  | 'manifest'
  | 'task-xml'
  | 'task-registration'
  | 'task-start'
  | 'autopilot-start'
  | 'runtime-readiness'
  | 'worker-spawn'
  | 'worker-registration'
  | 'uninstall';

export interface AutopilotDiagnosticError {
  code: string;
  stage: AutopilotFailureStage;
  message: string;
  cause?: string;
  actionableHint?: string;
}

export class AutopilotError extends Error {
  readonly code: string;
  readonly stage: AutopilotFailureStage;
  readonly causeMessage?: string;
  readonly actionableHint?: string;

  constructor(diag: AutopilotDiagnosticError) {
    super(diag.message);
    this.name = 'AutopilotError';
    this.code = diag.code;
    this.stage = diag.stage;
    this.causeMessage = diag.cause;
    this.actionableHint = diag.actionableHint;
  }

  toDiagnostic(): AutopilotDiagnosticError {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      cause: this.causeMessage,
      actionableHint: this.actionableHint,
    };
  }
}

/** Stable error codes (see spec §12). */
export const AUTOPILOT_ERRORS = {
  WINDOWS_TASK_REGISTER_FAILED: 'AUTOPILOT_WINDOWS_TASK_REGISTER_FAILED',
  WINDOWS_TASK_START_FAILED: 'AUTOPILOT_WINDOWS_TASK_START_FAILED',
  WINDOWS_TASK_PAUSE_FAILED: 'AUTOPILOT_WINDOWS_TASK_PAUSE_FAILED',
  WINDOWS_TASK_QUERY_FAILED: 'AUTOPILOT_WINDOWS_TASK_QUERY_FAILED',
  CLI_NOT_FOUND: 'AUTOPILOT_CLI_NOT_FOUND',
  CLI_INVOCATION_INVALID: 'AUTOPILOT_CLI_INVOCATION_INVALID',
  CMD_SHIM_FAILED: 'AUTOPILOT_CMD_SHIM_FAILED',
  BUN_NOT_FOUND: 'AUTOPILOT_BUN_NOT_FOUND',
  REPO_NOT_FOUND: 'AUTOPILOT_REPO_NOT_FOUND',
  REPO_ACCESS_DENIED: 'AUTOPILOT_REPO_ACCESS_DENIED',
  POSTGRES_REQUIRED: 'AUTOPILOT_POSTGRES_REQUIRED',
  DATABASE_CONNECTION_FAILED: 'AUTOPILOT_DATABASE_CONNECTION_FAILED',
  ENV_FILE_INVALID: 'AUTOPILOT_ENV_FILE_INVALID',
  MINION_DISABLED: 'AUTOPILOT_MINION_DISABLED',
  WORKER_START_FAILED: 'AUTOPILOT_WORKER_START_FAILED',
  WORKER_NOT_READY: 'AUTOPILOT_WORKER_NOT_READY',
  RUNTIME_HEARTBEAT_TIMEOUT: 'AUTOPILOT_RUNTIME_HEARTBEAT_TIMEOUT',
  ALREADY_RUNNING: 'AUTOPILOT_ALREADY_RUNNING',
} as const;

export function diagnosticError(
  code: string,
  stage: AutopilotFailureStage,
  message: string,
  opts: { cause?: string; actionableHint?: string } = {},
): AutopilotDiagnosticError {
  return {
    code,
    stage,
    message,
    cause: opts.cause,
    actionableHint: opts.actionableHint,
  };
}

/** Overall readiness state (spec §8). */
export type AutopilotOverallState =
  | 'not-installed'
  | 'installed'
  | 'running'
  | 'ready'
  | 'degraded'
  | 'failed';

export function isAutopilotOverallState(v: string): v is AutopilotOverallState {
  return ['not-installed', 'installed', 'running', 'ready', 'degraded', 'failed'].includes(v);
}

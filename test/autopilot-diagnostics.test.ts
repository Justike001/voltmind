/**
 * Unit tests for the autopilot diagnostics error model (spec §12).
 */

import { describe, test, expect } from 'bun:test';
import {
  isInstallTarget,
  isAutopilotOverallState,
  ALL_INSTALL_TARGETS,
  AUTOPILOT_ERRORS,
  AutopilotError,
  diagnosticError,
  type AutopilotFailureStage,
} from '../src/core/autopilot/diagnostics.ts';

describe('diagnostics error model', () => {
  test('AUTOPILOT_ERRORS contains the spec error codes', () => {
    expect(AUTOPILOT_ERRORS.WINDOWS_TASK_REGISTER_FAILED).toBe('AUTOPILOT_WINDOWS_TASK_REGISTER_FAILED');
    expect(AUTOPILOT_ERRORS.WINDOWS_TASK_START_FAILED).toBe('AUTOPILOT_WINDOWS_TASK_START_FAILED');
    expect(AUTOPILOT_ERRORS.CLI_NOT_FOUND).toBe('AUTOPILOT_CLI_NOT_FOUND');
    expect(AUTOPILOT_ERRORS.POSTGRES_REQUIRED).toBe('AUTOPILOT_POSTGRES_REQUIRED');
    expect(AUTOPILOT_ERRORS.DATABASE_CONNECTION_FAILED).toBe('AUTOPILOT_DATABASE_CONNECTION_FAILED');
    expect(AUTOPILOT_ERRORS.ENV_FILE_INVALID).toBe('AUTOPILOT_ENV_FILE_INVALID');
    expect(AUTOPILOT_ERRORS.MINION_DISABLED).toBe('AUTOPILOT_MINION_DISABLED');
    expect(AUTOPILOT_ERRORS.WORKER_START_FAILED).toBe('AUTOPILOT_WORKER_START_FAILED');
    expect(AUTOPILOT_ERRORS.RUNTIME_HEARTBEAT_TIMEOUT).toBe('AUTOPILOT_RUNTIME_HEARTBEAT_TIMEOUT');
    expect(AUTOPILOT_ERRORS.ALREADY_RUNNING).toBe('AUTOPILOT_ALREADY_RUNNING');
  });

  test('AutopilotError carries code + stage + actionableHint', () => {
    const err = new AutopilotError({
      code: AUTOPILOT_ERRORS.POSTGRES_REQUIRED,
      stage: 'preflight',
      message: 'PGLite not supported',
      actionableHint: 'Configure Supabase/Postgres.',
    });
    expect(err.code).toBe(AUTOPILOT_ERRORS.POSTGRES_REQUIRED);
    expect(err.stage).toBe('preflight');
    expect(err.actionableHint).toContain('Supabase');
    const diag = err.toDiagnostic();
    expect(diag.code).toBe(AUTOPILOT_ERRORS.POSTGRES_REQUIRED);
    expect(diag.stage).toBe('preflight');
  });

  test('diagnosticError builds a structured record', () => {
    const d = diagnosticError(AUTOPILOT_ERRORS.CLI_NOT_FOUND, 'cli-resolution', 'no voltmind', { cause: 'which failed' });
    expect(d.code).toBe(AUTOPILOT_ERRORS.CLI_NOT_FOUND);
    expect(d.stage).toBe('cli-resolution');
    expect(d.cause).toBe('which failed');
  });

  test('ALL_INSTALL_TARGETS includes all five targets', () => {
    expect(ALL_INSTALL_TARGETS).toEqual(
      expect.arrayContaining(['macos', 'linux-systemd', 'linux-cron', 'ephemeral-container', 'windows-task']),
    );
  });

  test('isInstallTarget + isAutopilotOverallState validate', () => {
    expect(isInstallTarget('windows-task')).toBe(true);
    expect(isInstallTarget('nope')).toBe(false);
    expect(isAutopilotOverallState('ready')).toBe(true);
    expect(isAutopilotOverallState('degraded')).toBe(true);
    expect(isAutopilotOverallState('bogus')).toBe(false);
  });

  test('every AutopilotFailureStage is a known stage string', () => {
    const stages: AutopilotFailureStage[] = [
      'target-detection', 'preflight', 'config-load', 'env-file', 'repo-access',
      'cli-resolution', 'cli-validation', 'database-connection', 'manifest',
      'task-xml', 'task-registration', 'task-start', 'autopilot-start',
      'runtime-readiness', 'worker-spawn', 'worker-registration', 'uninstall',
    ];
    // Sanity: the spec lists exactly these stages.
    expect(stages.length).toBe(17);
  });
});

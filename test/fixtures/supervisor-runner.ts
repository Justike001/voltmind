/**
 * Test fixture: spawns a MinionSupervisor with options parsed from env vars.
 *
 * Used by test/supervisor.test.ts integration tests. Separate file because
 * the supervisor calls `process.exit()` at the end of its lifecycle — tests
 * spawn this runner as a subprocess to observe exit codes and audit events
 * without killing the test runner itself.
 *
 * Env vars (all optional, sensible defaults for tests):
 *   SUP_CLI_PATH           — worker binary path (default: /bin/sh exit-1 script)
 *   SUP_PID_FILE           — PID file path (REQUIRED; each test uses a unique one)
 *   SUP_MAX_CRASHES        — max consecutive crashes (default: 3)
 *   SUP_BACKOFF_FLOOR_MS   — test-only short backoff (default: 1)
 *   SUP_HEALTH_INTERVAL_MS — how often healthCheck fires (default: 999_999 off)
 *   SUP_ALLOW_SHELL_JOBS   — "1" to set allowShellJobs:true, else false
 *   SUP_QUEUE              — queue name (default: 'default')
 *   SUP_AUDIT_DIR          — VOLTMIND_AUDIT_DIR override (default: tmpdir/supervisor-test)
 */

import { MinionSupervisor } from '../../src/core/minions/supervisor.ts';
import { writeSupervisorEvent } from '../../src/core/minions/handlers/supervisor-audit.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { CliInvocation } from '../../src/core/autopilot/cli-invocation.ts';
import { existsSync } from 'node:fs';

// Mock engine: healthCheck() calls engine.executeRaw; return empty rows so
// the query path exercises without needing Postgres.
const mockEngine: Partial<BrainEngine> = {
  kind: 'postgres' as const,
  executeRaw: async () => [],
} as unknown as BrainEngine;

const pidFile = process.env.SUP_PID_FILE;
if (!pidFile) {
  console.error('SUP_PID_FILE env var is required');
  process.exit(99);
}

const cliPath = process.env.SUP_CLI_PATH ?? '/bin/sh';
let cliInvocation: CliInvocation | undefined;
if (process.env.SUP_CLI_PREFIX) {
  cliInvocation = {
    executable: cliPath,
    prefixArgs: JSON.parse(process.env.SUP_CLI_PREFIX) as string[],
    source: 'native-exe',
  };
}
const maxCrashes = parseInt(process.env.SUP_MAX_CRASHES ?? '3', 10);
const backoffFloor = parseInt(process.env.SUP_BACKOFF_FLOOR_MS ?? '1', 10);
const healthInterval = parseInt(process.env.SUP_HEALTH_INTERVAL_MS ?? '999999', 10);
const allowShellJobs = process.env.SUP_ALLOW_SHELL_JOBS === '1';
const queueName = process.env.SUP_QUEUE ?? 'default';

if (process.env.SUP_AUDIT_DIR) {
  process.env.VOLTMIND_AUDIT_DIR = process.env.SUP_AUDIT_DIR;
}

const supervisorPid = process.pid;

const supervisor = new MinionSupervisor(mockEngine as BrainEngine, {
  concurrency: 1,
  queue: queueName,
  pidFile,
  maxCrashes,
  healthInterval,
  cliPath,
  cliInvocation,
  allowShellJobs,
  json: true,
  _backoffFloorMs: backoffFloor,
  onEvent: (emission) => writeSupervisorEvent(emission, supervisorPid),
});

// Cross-platform test control: Windows process.kill(SIGTERM) terminates the
// child instead of delivering the JS signal handler. A stop-file request
// exercises the same supervisor shutdown path without relying on POSIX signal
// delivery semantics.
const stopFile = process.env.SUP_STOP_FILE;
if (stopFile) {
  const stopPoll = setInterval(() => {
    if (!existsSync(stopFile)) return;
    clearInterval(stopPoll);
    void (supervisor as unknown as { shutdown(reason: string, exitCode: number): Promise<void> })
      .shutdown('SIGTERM', 0);
  }, 10);
}

await supervisor.start();

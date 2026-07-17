/** Runtime heartbeat must not depend on the long Autopilot dispatch interval. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'), 'utf8');

describe('Autopilot independent heartbeat', () => {
  test('refreshes runtime liveness every 30 seconds outside the dispatch loop', () => {
    expect(source).toContain('const refreshRuntimeHeartbeat = () =>');
    expect(source).toContain('heartbeatTimer = setInterval(refreshRuntimeHeartbeat, 30_000)');
    expect(source).toContain('heartbeatTimer.unref?.()');
  });

  test('clears the heartbeat timer during graceful shutdown', () => {
    const shutdownStart = source.indexOf('const shutdown = async');
    const shutdownEnd = source.indexOf("process.on('SIGTERM'", shutdownStart);
    expect(source.slice(shutdownStart, shutdownEnd)).toContain('clearInterval(heartbeatTimer)');
  });

  test('does not rewrite a dead worker as running during a heartbeat', () => {
    const heartbeatStart = source.indexOf('const refreshRuntimeHeartbeat = () =>');
    const heartbeatEnd = source.indexOf('if (spawnManagedWorker)', heartbeatStart);
    const heartbeat = source.slice(heartbeatStart, heartbeatEnd);
    expect(heartbeat).toContain("runtimeStatus.supervisor.state = 'restarting'");
    expect(heartbeat).not.toContain(": (childSupervisor.inBackoff ? 'restarting' : 'running')");
  });

  test('starts the supervisor only after graceful shutdown is available and observes failures', () => {
    expect(source).toContain('let startChildSupervisor: (() => void) | undefined');
    expect(source).toContain("void supervisor.run().catch((error: unknown) =>");
    expect(source).toContain("void shutdown('supervisor_runtime_error')");
    const shutdownInstalled = source.indexOf("process.on('SIGTERM'");
    const start = source.indexOf('startChildSupervisor?.();');
    expect(start).toBeGreaterThan(shutdownInstalled);
  });
});

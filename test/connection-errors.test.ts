import { describe, expect, test } from 'bun:test';
import { isRecoverableConnectionError, reconnectEngine } from '../src/core/connection-errors.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { readFileSync } from 'node:fs';

describe('connection recovery classification', () => {
  test.each([
    'CONNECTION_ENDED',
    'No database connection: connect() has not been called',
    'connection terminated unexpectedly',
    'ECONNRESET while reading from socket',
  ])('recognizes recoverable connection failure: %s', (message) => {
    expect(isRecoverableConnectionError(new Error(message))).toBe(true);
  });

  test('does not mistake a data parse failure for a connection failure', () => {
    expect(isRecoverableConnectionError(new Error('invalid byte sequence for encoding "UTF8"'))).toBe(false);
  });

  test('uses the engine reconnect hook once when available', async () => {
    let calls = 0;
    expect(await reconnectEngine({ reconnect: async () => { calls++; } })).toBe(true);
    expect(calls).toBe(1);
    expect(await reconnectEngine({})).toBe(false);
  });

  test('worker lock renewal has a non-async timer boundary with a final rejection guard', () => {
    const worker = readFileSync(new URL('../src/core/minions/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain('const renewJobLock = async (): Promise<void> =>');
    expect(worker).toContain('setInterval(() => {\n      void renewJobLock().catch');
    expect(worker).not.toContain('const lockTimer = setInterval(async () =>');
  });

  test('terminal queue writes reconnect once and contain a repeated connection failure', async () => {
    let reconnects = 0;
    let writes = 0;
    const worker = new MinionWorker({
      reconnect: async () => { reconnects++; },
    } as any);

    const recovered = await (worker as any).queueWriteWithReconnect(7, 'test write', async () => {
      writes++;
      if (writes === 1) throw new Error('CONNECTION_ENDED');
      return true;
    });
    expect(recovered).toBe(true);
    expect(reconnects).toBe(1);
    expect(writes).toBe(2);

    const contained = await (worker as any).queueWriteWithReconnect(8, 'test write', async () => {
      throw new Error('No database connection: connect() has not been called');
    });
    expect(contained).toBeUndefined();
    expect(reconnects).toBe(2);
  });

  test('worker routes recoverable handler failures through the no-attempt connection release', () => {
    const worker = readFileSync(new URL('../src/core/minions/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain('releaseRecoverableConnectionJob');
    expect(worker).toContain('attempt budget unchanged');
  });

  test('cycle lint reuses its worker engine instead of disconnecting a temporary shared pool', () => {
    const cycle = readFileSync(new URL('../src/core/cycle.ts', import.meta.url), 'utf8');
    const lint = readFileSync(new URL('../src/commands/lint.ts', import.meta.url), 'utf8');
    expect(cycle).toContain('runPhaseLint(opts.brainDir, dryRun, engine ?? undefined)');
    expect(lint).toContain('await resolveLintContentSanity(opts.engine)');
    expect(lint).toContain('if (!sharedEngine && hasEngineConfig)');
  });

  test('Autopilot start returns immediately when the scheduler already owns a live task', () => {
    const adapter = readFileSync(new URL('../src/core/autopilot/windows-task-adapter.ts', import.meta.url), 'utf8');
    expect(adapter).toContain("if (info.state === 'Running')");
    expect(adapter).toContain("['/Run', '/TN', WINDOWS_TASK_NAME]");
    expect(adapter).not.toContain('Start-ScheduledTask -TaskName');
  });
});

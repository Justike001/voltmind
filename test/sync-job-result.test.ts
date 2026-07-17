import { describe, expect, test } from 'bun:test';
import { SyncResultBlockedError, requireCompletedSync } from '../src/core/minions/sync-result.ts';

describe('Minion sync completion semantics', () => {
  test('allows a genuinely complete sync result', () => {
    expect(requireCompletedSync({ status: 'synced', failedFiles: 0 })).toMatchObject({ status: 'synced' });
  });

  test.each(['blocked_by_failures', 'partial'])('does not convert %s into queue completion', (status) => {
    expect(() => requireCompletedSync({ status, failedFiles: 1 })).toThrow(SyncResultBlockedError);
  });
});

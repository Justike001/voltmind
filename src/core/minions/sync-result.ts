/** Queue-facing semantics for a completed sync invocation. */
export interface SyncCompletionLike {
  status: string;
  failedFiles?: number;
}

/**
 * A sync that returned a business-blocked result did run, but it did not
 * complete its contract.  Throwing makes Minion use its delayed retry / dead
 * letter path instead of recording a misleading COMPLETED job.
 */
export class SyncResultBlockedError extends Error {
  readonly code = 'SYNC_RESULT_BLOCKED';

  constructor(readonly result: SyncCompletionLike) {
    super(`sync_${result.status}: ${result.failedFiles ?? 0} file(s) require recovery before sync can complete`);
    this.name = 'SyncResultBlockedError';
  }
}

export function requireCompletedSync<T extends SyncCompletionLike>(result: T): T {
  if (result.status === 'blocked_by_failures' || result.status === 'partial') {
    throw new SyncResultBlockedError(result);
  }
  return result;
}

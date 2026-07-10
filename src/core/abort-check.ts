/** Cooperative abort helpers for long-running loops. */

export function isAborted(signal?: AbortSignal | null): boolean {
  return !!signal?.aborted;
}

export class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal?: AbortSignal | null, label?: string): void {
  if (!signal?.aborted) return;
  const reason =
    signal.reason instanceof Error
      ? signal.reason.message
      : String(signal.reason ?? 'aborted');
  throw new AbortError(label ? `${label}: ${reason}` : reason);
}

export function anySignal(
  internal: AbortSignal,
  external?: AbortSignal | null,
): AbortSignal {
  if (!external) return internal;
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any(signals: AbortSignal[]): AbortSignal }).any([
      internal,
      external,
    ]);
  }

  const ac = new AbortController();
  const relay = (signal: AbortSignal) => ac.abort(signal.reason);
  if (internal.aborted) relay(internal);
  else internal.addEventListener('abort', () => relay(internal), { once: true });
  if (external.aborted) relay(external);
  else external.addEventListener('abort', () => relay(external), { once: true });
  return ac.signal;
}

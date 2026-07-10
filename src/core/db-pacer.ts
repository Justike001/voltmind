/**
 * Cooperative DB-contention pacing primitive.
 *
 * Disabled by default through `pace-mode`; when enabled it caps simultaneous
 * DB writes and adds jittered sleeps after high observed latency.
 */

import { AbortError, anySignal } from './abort-check.ts';
import type { PaceBundle } from './pace-mode.ts';

export interface PaceSnapshot {
  enabled: boolean;
  maxConcurrency: number;
  active: number;
  ewmaMs: number | null;
  totalSleptMs: number;
  sleepCount: number;
  maxWaiters: number;
  sampleCount: number;
}

export interface Permit {
  release(): void;
}

export interface DbPacer {
  acquire(signal?: AbortSignal): Promise<Permit>;
  observe(latencyMs: number): void;
  pace(signal?: AbortSignal): Promise<void>;
  snapshot(): PaceSnapshot;
  dispose(): void;
}

export interface DbPacerSeams {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rng?: () => number;
}

export interface CreateDbPacerOpts extends DbPacerSeams {
  bundle: PaceBundle;
}

interface Waiter {
  resolve: (permit: Permit) => void;
  reject: (error: unknown) => void;
  cleanup?: () => void;
  signal?: AbortSignal;
}

function abortReason(signal?: AbortSignal | null): string {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message;
  return String(reason ?? 'aborted');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortError(abortReason(signal)));
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new AbortError(abortReason(signal)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const NOOP_PERMIT: Permit = { release() {} };

export function createNoopPacer(): DbPacer {
  return {
    acquire: () => Promise.resolve(NOOP_PERMIT),
    observe: () => {},
    pace: () => Promise.resolve(),
    snapshot: () => ({
      enabled: false,
      maxConcurrency: 0,
      active: 0,
      ewmaMs: null,
      totalSleptMs: 0,
      sleepCount: 0,
      maxWaiters: 0,
      sampleCount: 0,
    }),
    dispose: () => {},
  };
}

export function createDbPacer(opts: CreateDbPacerOpts): DbPacer {
  const { bundle } = opts;
  if (!bundle.enabled) return createNoopPacer();

  const max = Math.max(1, Math.floor(bundle.maxConcurrency));
  const paceAtMs = Math.max(0, bundle.paceAtMs);
  const maxSleepMs = Math.max(0, bundle.maxSleepMs);
  const alpha = bundle.ewmaAlpha > 0 && bundle.ewmaAlpha <= 1 ? bundle.ewmaAlpha : 0.3;
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;

  let active = 0;
  let disposed = false;
  let ewma: number | null = null;
  let totalSleptMs = 0;
  let sleepCount = 0;
  let maxWaiters = 0;
  let sampleCount = 0;
  const waiters: Waiter[] = [];

  function makePermit(): Permit {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const next = waiters.shift();
        if (next) {
          next.cleanup?.();
          next.resolve(makePermit());
        } else {
          active = Math.max(0, active - 1);
        }
      },
    };
  }

  async function acquire(signal?: AbortSignal): Promise<Permit> {
    try {
      if (signal?.aborted) throw new AbortError(abortReason(signal));
      if (disposed) return NOOP_PERMIT;
      if (active < max) {
        active++;
        return makePermit();
      }
      return await new Promise<Permit>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new AbortError(abortReason(signal)));
        };
        waiter.cleanup = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
        if (waiters.length > maxWaiters) maxWaiters = waiters.length;
      });
    } catch (error) {
      if (error instanceof AbortError) throw error;
      return NOOP_PERMIT;
    }
  }

  function observe(latencyMs: number): void {
    try {
      if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) return;
      ewma = ewma === null ? latencyMs : alpha * latencyMs + (1 - alpha) * ewma;
      sampleCount++;
    } catch {
      /* fail open */
    }
  }

  async function pace(signal?: AbortSignal): Promise<void> {
    let ms = 0;
    try {
      if (ewma === null || ewma <= paceAtMs || maxSleepMs <= 0) return;
      const base = Math.min(maxSleepMs, ewma);
      const jitter = 0.5 + 0.5 * clamp01(rng());
      ms = Math.round(base * jitter);
      if (ms <= 0) return;
    } catch {
      return;
    }
    try {
      await sleep(ms, signal);
      totalSleptMs += ms;
      sleepCount++;
    } catch (error) {
      if (error instanceof AbortError) throw error;
    }
  }

  function snapshot(): PaceSnapshot {
    return {
      enabled: true,
      maxConcurrency: max,
      active,
      ewmaMs: ewma,
      totalSleptMs,
      sleepCount,
      maxWaiters,
      sampleCount,
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.cleanup?.();
      waiter?.resolve(NOOP_PERMIT);
    }
  }

  return { acquire, observe, pace, snapshot, dispose };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export async function observed<T>(pacer: DbPacer, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    pacer.observe(Date.now() - t0);
  }
}

export { anySignal };

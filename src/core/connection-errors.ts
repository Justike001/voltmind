/**
 * Database connection failures are recoverable at an operation boundary, but
 * never safe to replay blindly at the individual SQL-statement boundary.
 * Keep classification in one small dependency-free module so the worker,
 * cycle runner, and Autopilot agree on which errors need reconnect/requeue.
 */
export function isRecoverableConnectionError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return [
    'connection_ended',
    'connection ended',
    'connection terminated',
    'connection closed',
    'connection reset',
    'connection refused',
    'connection timeout',
    'connect() has not been called',
    'no database connection',
    'terminating connection',
    'server closed the connection',
    'client has encountered a connection error',
    'socket hang up',
    'econnreset',
    'econnrefused',
    'etimedout',
  ].some((pattern) => message.includes(pattern));
}

export type ReconnectableEngine = {
  reconnect?: () => Promise<void>;
};

/** Returns false when this engine cannot perform a configuration-preserving reconnect. */
export async function reconnectEngine(engine: ReconnectableEngine): Promise<boolean> {
  if (typeof engine.reconnect !== 'function') return false;
  await engine.reconnect();
  return true;
}

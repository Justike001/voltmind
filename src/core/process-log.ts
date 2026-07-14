/**
 * Append a process's stdout and stderr to one live diagnostic log.
 *
 * Autopilot is launched directly by Windows Task Scheduler, so there is no
 * shell parent available to perform `> file 2>&1` redirection. This bootstrap
 * keeps the native process tree intact and tees writes to the original
 * streams and to an append-only file. The worker inherits the log path
 * through VOLTMIND_AUTOPILOT_LOG_FILE and installs its own tee too.
 */

import { mkdirSync, openSync, writeSync } from 'fs';
import { dirname } from 'path';
import { format } from 'util';

let installedPath: string | null = null;
let logFd: number | null = null;
let forwardingConsole = false;

function asBuffer(chunk: unknown, encoding?: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  const textEncoding = typeof encoding === 'string' ? encoding : 'utf8';
  return Buffer.from(String(chunk), textEncoding as BufferEncoding);
}

function append(chunk: unknown, encoding?: unknown): void {
  if (logFd === null || forwardingConsole) return;
  try {
    // The file is opened with O_APPEND so Autopilot and its worker can safely
    // write to the same log without coordinating a shared file descriptor.
    writeSync(logFd, asBuffer(chunk, encoding));
  } catch {
    // Logging must never break the original stdout/stderr path.
  }
}

function forwardWrite(
  original: (...args: never[]) => boolean,
  chunk: unknown,
  encoding?: unknown,
  callback?: unknown,
): boolean {
  if (typeof encoding === 'function') {
    return original(chunk as never, encoding as never);
  }
  if (typeof callback === 'function') {
    return original(chunk as never, encoding as never, callback as never);
  }
  if (encoding !== undefined) {
    return original(chunk as never, encoding as never);
  }
  return original(chunk as never);
}

/** Install the stdout/stderr tee once per process. */
export function installProcessLog(filePath: string): void {
  if (!filePath || installedPath === filePath) return;
  if (installedPath !== null) return;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    logFd = openSync(filePath, 'a');
  } catch {
    // Keep the process usable if the log directory is temporarily unavailable.
    return;
  }

  installedPath = filePath;
  const stdout = process.stdout;
  const stderr = process.stderr;
  const originalStdoutWrite = stdout.write.bind(stdout);
  const originalStderrWrite = stderr.write.bind(stderr);

  stdout.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    append(chunk, encoding);
    return forwardWrite(originalStdoutWrite, chunk, encoding, callback);
  }) as typeof stdout.write;

  stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    append(chunk, encoding);
    return forwardWrite(originalStderrWrite, chunk, encoding, callback);
  }) as typeof stderr.write;

  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const method of consoleMethods) {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      append(`${format(...args)}\n`);
      forwardingConsole = true;
      try {
        return original(...args);
      } finally {
        forwardingConsole = false;
      }
    }) as typeof console[typeof method];
  }

  append(
    `[${new Date().toISOString()}] [process-log] attached pid=${process.pid} file=${filePath}\n`,
  );
}

export function installedProcessLogPath(): string | null {
  return installedPath;
}

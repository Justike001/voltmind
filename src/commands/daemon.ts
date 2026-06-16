import { spawn } from 'child_process';
import { mkdirSync, openSync, closeSync } from 'fs';
import { dirname } from 'path';
import {
  callLocalDaemon,
  daemonStatePath,
  isProcessAlive,
  readDaemonState,
  removeDaemonState,
} from '../core/local-daemon.ts';

function printHelp(): void {
  console.log(`Usage: voltmind daemon <start|status|stop|run>

Commands:
  start                 Start a background local daemon
  run --foreground      Run the daemon in the current process
  status [--json]       Show daemon status
  stop                  Stop the running daemon

The daemon owns the local PGLite connection and CLI DB commands forward to it
when it is running.`);
}

export async function runDaemon(args: string[]): Promise<void> {
  const cmd = args[0] || 'status';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'run': {
      if (!args.includes('--foreground')) {
        console.error('Usage: voltmind daemon run --foreground');
        process.exit(2);
      }
      const { runLocalDaemonServer } = await import('../core/local-daemon-server.ts');
      await runLocalDaemonServer();
      return;
    }
    case 'start':
      await startDaemon();
      return;
    case 'status':
      await showDaemonStatus(args.slice(1));
      return;
    case 'stop':
      await stopDaemon();
      return;
    default:
      console.error(`Unknown daemon subcommand: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

async function startDaemon(): Promise<void> {
  const existing = readDaemonState();
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`VoltMind daemon already running (pid ${existing.pid}, port ${existing.port}).`);
    return;
  }
  if (existing) removeDaemonState();

  const entry = process.argv[1];
  const childArgs = entry && /\.(?:mjs|js|ts)$/.test(entry)
    ? [entry, 'daemon', 'run', '--foreground']
    : ['daemon', 'run', '--foreground'];
  const logPath = daemonStatePath().replace(/daemon\.json$/, 'daemon.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const outFd = openSync(logPath, 'a');
  const errFd = openSync(logPath, 'a');
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: { ...process.env, VOLTMIND_DAEMON_BYPASS: '1' },
  });
  closeSync(outFd);
  closeSync(errFd);
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    const state = readDaemonState();
    if (!state) continue;
    try {
      const res = await callLocalDaemon(state, { command: 'status', args: ['--json'] }, { timeoutMs: 2_000 });
      if (res.ok || res.stdout || res.stderr) {
        console.log(`VoltMind daemon started (pid ${state.pid}, port ${state.port}).`);
        console.log(`Log: ${logPath}`);
        return;
      }
    } catch {
      // Keep waiting for the server to accept requests.
    }
  }
  console.error(`Timed out waiting for VoltMind daemon to start. State file: ${daemonStatePath()}`);
  process.exit(1);
}

async function showDaemonStatus(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const state = readDaemonState();
  if (!state) {
    if (json) console.log(JSON.stringify({ running: false, state_path: daemonStatePath() }, null, 2));
    else console.log('VoltMind daemon is not running.');
    return;
  }
  const alive = isProcessAlive(state.pid);
  let healthy = false;
  if (alive) {
    try {
      const res = await callLocalDaemon(state, { command: 'status', args: ['--json'] }, { timeoutMs: 2_000 });
      healthy = Boolean(res.ok || res.stdout || res.stderr);
    } catch {
      healthy = false;
    }
  }
  if (!alive) removeDaemonState();
  const payload = {
    running: alive && healthy,
    process_alive: alive,
    healthy,
    state_path: daemonStatePath(),
    state: alive ? state : null,
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.running) {
    console.log(`VoltMind daemon running (pid ${state.pid}, port ${state.port}, started ${state.started_at}).`);
  } else if (alive) {
    console.log(`VoltMind daemon process exists but did not answer health checks (pid ${state.pid}).`);
  } else {
    console.log('VoltMind daemon is not running.');
  }
}

async function stopDaemon(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    console.log('VoltMind daemon is not running.');
    return;
  }
  if (!isProcessAlive(state.pid)) {
    removeDaemonState();
    console.log('Removed stale daemon state; process is not running.');
    return;
  }
  try {
    const res = await callLocalDaemon(state, { command: '__shutdown', args: [] }, { timeoutMs: 5_000 });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  } catch (err) {
    console.error(`Failed to stop daemon cleanly: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

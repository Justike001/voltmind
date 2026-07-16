/**
 * voltmind autopilot — Self-maintaining brain daemon.
 *
 * v0.11.1 shape:
 *   - Default path (minion_mode != off AND engine == postgres): spawn a
 *     `voltmind jobs work` child process, submit ONE `autopilot-cycle` job
 *     per interval with an idempotency_key so slow cycles don't stack up.
 *     The forked worker drains the queue durably; restart with 10s backoff
 *     on crash (5-crash cap → autopilot stops with a clear error).
 *   - Fallback (minion_mode=off, PGLite, or `--inline`): run sync →
 *     extract → embed inline, same as pre-v0.11.1 behavior.
 *
 * Usage:
 *   voltmind autopilot [--repo <path>] [--interval N] [--json] [--inline]
 *   voltmind autopilot --install [--repo <path>]
 *   voltmind autopilot --uninstall
 *   voltmind autopilot --status [--json]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, utimesSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { BrainEngine } from '../core/engine.ts';
import { loadPreferences } from '../core/preferences.ts';
import { loadConfig, voltmindPath as voltmindHomePath } from '../core/config.ts';
import { ChildWorkerSupervisor } from '../core/minions/child-worker-supervisor.ts';
import { resolveCliInvocation, buildCliArgv, autopilotLockPath, type CliInvocation } from '../core/autopilot/cli-invocation.ts';
import {
  loadManifest, saveManifest, deleteManifest, createManifest, reconcileManifest, manifestPath,
} from '../core/autopilot/manifest.ts';
import {
  initialRuntimeStatus, writeRuntimeStatus, readRuntimeStatus, deleteRuntimeStatus, isHeartbeatStale,
  type AutopilotRuntimeStatus,
} from '../core/autopilot/runtime-status.ts';
import { detectInstallTarget as detectInstallTargetUnified } from '../core/autopilot/detect-target.ts';
import { isInstallTarget, type InstallTarget, type AutopilotOverallState } from '../core/autopilot/diagnostics.ts';
import { windowsTaskSchedulerAdapter, WINDOWS_TASK_NAME } from '../core/autopilot/windows-task-adapter.ts';
import {
  clearAutopilotPauseRequest,
  readAutopilotPauseRequest,
  requestAutopilotPause,
} from '../core/autopilot/pause-control.ts';
import { VERSION } from '../version.ts';
import { reconnectEngine } from '../core/connection-errors.ts';

/**
 * v0.37.7.0 #1162 — classify autopilot reconnect-loop errors.
 *
 * `recoverable` (network blip, Supabase 503, pool saturated, connection
 * refused on a port that may be coming up): retry with backoff up to
 * `VOLTMIND_AUTOPILOT_MAX_RECONNECT_FAILS` (default 30).
 *
 * `unrecoverable` (`database_url` unset/empty/malformed, auth failure,
 * config file unreadable): exit immediately so launchd's 60s
 * `ThrottleInterval` backs off the relaunch instead of thrashing.
 *
 * Exported (string-based signature) so tests drive it without needing
 * a real reconnect error.
 */
export function classifyReconnectError(err: unknown): 'recoverable' | 'unrecoverable' {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (msg.includes('database_url') && (msg.includes('undefined') || msg.includes('missing') || msg.includes('empty') || msg.includes('not set'))) {
    return 'unrecoverable';
  }
  if (msg.includes('invalid url') || msg.includes('malformed') || msg.includes('parse url')) {
    return 'unrecoverable';
  }
  // Auth failures: postgres prints `role "name" does not exist` (with the
  // role name in quotes between role and does), so use a skeleton match.
  if (msg.includes('password authentication failed') || msg.includes('authentication failed')) {
    return 'unrecoverable';
  }
  if (msg.includes('role') && msg.includes('does not exist')) {
    return 'unrecoverable';
  }
  if (msg.includes('no brain configured') || msg.includes('config not found')) {
    return 'unrecoverable';
  }
  return 'recoverable';
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function logError(phase: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const ts = new Date().toISOString().slice(0, 19);
  const line = `[${ts}] [${phase}] ERROR: ${msg}`;
  console.error(line);
  try {
    const logDir = join(process.env.HOME || '', '.voltmind');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'autopilot.log'), line + '\n');
  } catch { /* best-effort */ }
}

/**
 * Resolve the voltmind CLI entrypoint for spawning the worker child.
 *
 * Backward-compatible synchronous wrapper around the unified
 * `resolveCliInvocation()`. Prefer using `resolveCliInvocation()` directly
 * (it returns a structured `CliInvocation` with prefix args + spawn options).
 * This wrapper collapses that to a single executable string for the legacy
 * `cliPath` field and for existing tests.
 *
 * A .ts source path is never a valid spawn target. The canonical install
 * puts a shim at `/usr/local/bin/voltmind`; prefer it.
 */
export function resolveVoltMindCliPath(): string {
  try {
    const which = execSync('which voltmind', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which) return which;
  } catch { /* not on $PATH — fall through */ }

  const exec = process.execPath ?? '';
  if (exec.endsWith('/voltmind') || exec.endsWith('\\voltmind.exe')) {
    return exec;
  }

  const arg1 = process.argv[1] ?? '';
  if (arg1.endsWith('/voltmind') || arg1.endsWith('\\voltmind.exe')) {
    return arg1;
  }

  throw new Error('Could not resolve the voltmind CLI path. Install voltmind so it is on $PATH (e.g. /usr/local/bin/voltmind), or run autopilot from the compiled binary directly.');
}

export function shouldSpawnAutopilotWorker(args: string[]): boolean {
  return !args.includes('--no-worker');
}

/**
 * A force-killed Autopilot leaves its lock file behind. Its mtime cannot tell
 * us whether the owning process is still alive: after a hard kill it remains
 * fresh, which used to make every scheduler retry exit for ten minutes.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM still proves that a process with this PID exists; it only denies
    // signaling it (for example, when it belongs to another security context).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove the autopilot lock left by a force-killed or scheduler-stopped
 * process. Never remove a lock whose owner PID is still alive.
 */
export function removeStaleAutopilotLock(): boolean {
  const lockPath = autopilotLockPath();
  if (!existsSync(lockPath)) return false;

  let ownerPid = Number.NaN;
  try {
    ownerPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
  } catch { /* malformed/unreadable locks are safe to treat as stale */ }

  if (isProcessAlive(ownerPid)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Submit one ordinary full maintenance cycle through the durable Minion queue.
 *
 * This is intentionally not an inline "verification" implementation: it is
 * an operator-controlled way to exercise the same Task Scheduler → Autopilot
 * → ChildWorkerSupervisor → worker path used in production when a source is
 * otherwise fresh and the regular dispatcher has nothing to submit.
 */
export async function submitVerificationCycle(engine: BrainEngine, args: string[]): Promise<void> {
  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  const jsonMode = args.includes('--json');
  if (!repoPath) {
    throw new Error('No repo path. Use --repo or run voltmind sync --repo first.');
  }

  const { MinionQueue } = await import('../core/minions/queue.ts');
  const queue = new MinionQueue(engine);
  const job = await queue.add(
    'autopilot-cycle',
    // Explicitly disable pull for a local verification run. The normal
    // per-source dispatcher enables it only when the source has a remote.
    { repoPath, pull: false },
    {
      queue: 'default',
      idempotency_key: `autopilot-verify:${Date.now()}:${process.pid}`,
      max_attempts: 2,
      timeout_ms: 600_000,
      // A verification request must not create an unbounded backlog while a
      // prior full cycle is waiting; the cycle lock still protects active work.
      maxWaiting: 1,
    },
  );

  const result = { status: 'submitted', job_id: job.id, name: 'autopilot-cycle', queue: 'default' };
  if (jsonMode) console.log(JSON.stringify(result));
  else console.log(`Submitted verification cycle as job #${job.id}.`);
}

export async function runAutopilot(engine: BrainEngine, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: voltmind autopilot [--repo <path>] [--interval N] [--json] [--no-worker] [--log-file <path>]\n' +
      '       voltmind autopilot --install [--paused] [--repo <path>] [--target <target>] [--runtime-env-file <path>]\n' +
      '       voltmind autopilot --uninstall\n' +
      '       voltmind autopilot --status [--json]\n' +
      '       voltmind autopilot --pause|--stop [--force]\n' +
      '       voltmind autopilot --start\n\n' +
      '       voltmind autopilot --verify-once [--repo <path>] [--json]\n\n' +
      'Self-maintaining brain daemon. Runs the full maintenance cycle\n' +
      '(lint + backlinks + sync + extract + embed + orphans) on an interval.\n\n' +
      'On Windows, `--install` registers a Task Scheduler entry (requires\n' +
      'Supabase/Postgres; PGLite is not supported for a supervised worker).\n\n' +
      'For a one-shot cron-triggered cycle, see `voltmind dream`.',
    );
    return;
  }

  if (args.includes('--install')) {
    await installDaemon(engine, args);
    return;
  }
  if (args.includes('--uninstall')) {
    await uninstallDaemonUnified();
    return;
  }
  if (args.includes('--pause') || args.includes('--stop')) {
    await pauseWindowsAutopilot(args.includes('--json'), args.includes('--force'));
    return;
  }
  if (args.includes('--start')) {
    await startWindowsAutopilot(args.includes('--json'));
    return;
  }
  if (args.includes('--status')) {
    await showStatus(engine, args.includes('--json'));
    return;
  }
  if (args.includes('--verify-once')) {
    await submitVerificationCycle(engine, args);
    return;
  }

  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  const baseInterval = parseInt(parseArg(args, '--interval') || '300', 10);
  const jsonMode = args.includes('--json');
  const forceInline = args.includes('--inline');
  const noWorker = !shouldSpawnAutopilotWorker(args);

  if (!repoPath) {
    console.error('No repo path. Use --repo or run voltmind sync --repo first.');
    process.exit(1);
  }

  // Lock file to prevent concurrent instances (#14).
  // v0.37.7.0 #1226: route through voltmindPath() so the lockfile lives
  // under VOLTMIND_HOME when set, not the hardcoded ~/.voltmind. Pre-fix,
  // two brains sharing VOLTMIND_HOME=different-paths still wrote to the
  // same global lockfile and one would silently respawn the other
  // forever.
  const lockPath = autopilotLockPath();
  try {
    mkdirSync(voltmindHomePath(), { recursive: true });
    if (existsSync(lockPath)) {
      const stat = require('fs').statSync(lockPath);
      const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
      const existingPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      if (isProcessAlive(existingPid)) {
        console.error('Another autopilot instance is running (lock owner PID is alive). Exiting.');
        process.exit(0);
      }
      console.log(`Stale lock file found (pid ${Number.isSafeInteger(existingPid) ? existingPid : 'unknown'} is not running; age ${ageMinutes.toFixed(1)} min). Taking over.`);
    }
    writeFileSync(lockPath, String(process.pid));
  } catch { /* best-effort */ }

  console.log(`Autopilot starting. Repo: ${repoPath}, interval: ${baseInterval}s`);

  // Mode resolution: Minions dispatch when the user has opted in AND the
  // worker daemon can actually run (Postgres only; PGLite's exclusive file
  // lock blocks a separate worker process).
  const mode = loadPreferences().minion_mode ?? 'pain_triggered';
  const cfg = loadConfig();
  const engineType = cfg?.engine ?? 'pglite';
  const useMinionsDispatch = mode !== 'off' && engineType === 'postgres' && !forceInline;
  const spawnManagedWorker = useMinionsDispatch && !noWorker;

  // Runtime status file (spec §9): atomic local state so --status doesn't
  // have to guess from process existence. Heartbeat updated every cycle.
  const runtimeStatus = initialRuntimeStatus({
    pid: process.pid,
    repoPath,
    engine: engineType as 'postgres' | 'pglite',
    workerExpected: spawnManagedWorker,
  });
  try { writeRuntimeStatus(runtimeStatus); } catch { /* best-effort */ }

  let stopping = false;
  let childSupervisor: ChildWorkerSupervisor | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  // The dispatch loop intentionally sleeps for as long as `interval` (150s
  // on a healthy deployment). Runtime liveness must not inherit that cadence:
  // the status stale threshold is 120s, so a loop-end-only heartbeat produced
  // a recurring false "autopilot inactive" window. Keep the lightweight
  // heartbeat independent from dispatch and worker activity.
  const refreshRuntimeHeartbeat = () => {
    if (runtimeStatus.state === 'starting') runtimeStatus.state = 'running';
    if (childSupervisor) {
      // A persisted supervisor state must never invent a live worker.  In
      // particular, retain the transition recorded by the lifecycle callback
      // while a replacement is being spawned instead of turning a dead child
      // back into "running" on the next heartbeat.
      if (childSupervisor.childAlive) {
        runtimeStatus.supervisor.state = 'running';
      } else if (childSupervisor.inBackoff) {
        runtimeStatus.supervisor.state = 'restarting';
      }
      runtimeStatus.supervisor.restartCount = childSupervisor.crashCount;
    }
    runtimeStatus.updatedAt = new Date().toISOString();
    runtimeStatus.heartbeatAt = runtimeStatus.updatedAt;
    try { writeRuntimeStatus(runtimeStatus); } catch { /* best-effort */ }
  };

  // The supervisor is started after the shutdown routine is installed.  This
  // avoids an early child failure racing a callback that needs to drain and
  // clean up the parent, and gives its rejected promise a durable error path
  // instead of an unhandled rejection that can terminate Bun silently.
  let startChildSupervisor: (() => void) | undefined;

  if (spawnManagedWorker) {
    const cliInvocation = await resolveCliInvocation({ repoRoot: repoPath });
    // Inject the RSS watchdog default (2048 MB) for the autopilot-supervised
    // worker. Bare `voltmind jobs work` has no default; the supervisor and
    // autopilot are the production paths that opt in.
    childSupervisor = new ChildWorkerSupervisor({
      cliInvocation,
      args: ['jobs', 'work', '--max-rss', '2048'],
      // process.env clone; the worker daemon is a public host-local command
      // and receives the same runtime environment as Autopilot.
      env: { ...process.env },
      maxCrashes: 5,
      isStopping: () => stopping,
      onMaxCrashesExceeded: (count, max) => {
        console.error(`[autopilot] ${count}/${max} consecutive worker crashes, giving up.`);
        void shutdown('max_crashes');
      },
      onEvent: (event) => {
        // Route ChildWorkerSupervisor events to autopilot's stderr log.
        // Matches the prior console output shape so operators reading
        // existing logs see the same lines.
        if (event.kind === 'worker_spawned') {
          runtimeStatus.supervisor.state = 'running';
          runtimeStatus.supervisor.workerPid = event.pid;
          runtimeStatus.supervisor.lastRestartAt = new Date().toISOString();
          runtimeStatus.supervisor.lastError = undefined;
          refreshRuntimeHeartbeat();
          console.log(
            `[autopilot] Minions worker spawned (pid: ${event.pid}, watchdog: 2048MB${event.tini ? ', tini: active' : ''})`,
          );
        } else if (event.kind === 'worker_spawn_failed') {
          runtimeStatus.state = 'degraded';
          runtimeStatus.supervisor.state = 'restarting';
          runtimeStatus.supervisor.workerPid = undefined;
          runtimeStatus.supervisor.lastError = `spawn_${event.phase}: ${event.error}`;
          refreshRuntimeHeartbeat();
          console.error(
            `[autopilot] worker spawn failed (${event.phase}): ${event.error}${event.errnoCode ? ` (code=${event.errnoCode})` : ''}`,
          );
        } else if (event.kind === 'worker_exited') {
          runtimeStatus.state = 'degraded';
          runtimeStatus.supervisor.state = 'restarting';
          runtimeStatus.supervisor.workerPid = undefined;
          runtimeStatus.supervisor.restartCount = event.crashCount;
          runtimeStatus.supervisor.lastError =
            `worker_exit: code=${event.code ?? 'null'} signal=${event.signal ?? 'null'} cause=${event.likelyCause}`;
          refreshRuntimeHeartbeat();
          console.error(
            `[autopilot] worker exited code=${event.code} signal=${event.signal} after ${event.runDurationMs}ms, crashCount=${event.crashCount}, cause=${event.likelyCause}`,
          );
        } else if (event.kind === 'backoff') {
          runtimeStatus.supervisor.state = 'restarting';
          runtimeStatus.supervisor.restartCount = event.crashCount;
          refreshRuntimeHeartbeat();
          if (event.reason === 'budget_exceeded') {
            console.error(
              `[autopilot] clean-restart budget exceeded; backing off ${event.ms}ms before next spawn`,
            );
          } else if (event.reason === 'crash') {
            console.error(
              `[autopilot] crash backoff ${event.ms}ms (crashCount=${event.crashCount})`,
            );
          }
          // reason='clean_exit' with ms:0 is the steady-state watchdog drain;
          // logging every iteration would be noisy. Keep silent (the
          // worker_exited line already covers the user-visible signal).
        } else if (event.kind === 'health_warn') {
          console.error(
            `[autopilot] health_warn: ${event.reason} count=${event.count} window=${event.windowMs}ms`,
          );
        }
      },
    });
    startChildSupervisor = () => {
      const supervisor = childSupervisor;
      if (!supervisor) return;
      void supervisor.run().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        runtimeStatus.state = 'failed';
        runtimeStatus.supervisor.state = 'failed';
        runtimeStatus.supervisor.workerPid = undefined;
        runtimeStatus.supervisor.lastError = `supervisor_runtime_error: ${message}`;
        refreshRuntimeHeartbeat();
        console.error(`[autopilot] FATAL: child worker supervisor crashed: ${message}`);
        void shutdown('supervisor_runtime_error');
      });
    };
  } else if (!useMinionsDispatch) {
    const why = mode === 'off'
      ? 'minion_mode=off'
      : (engineType !== 'postgres' ? 'engine=pglite' : 'flag=--inline');
    console.log(`[autopilot] running steps inline (${why})`);
  } else {
    console.log('[autopilot] --no-worker set: dispatch loop only (worker managed externally)');
  }

  // Async shutdown with a 35s initial drain window for the worker child. The worker
  // has its own SIGTERM handler (minions/worker.ts:79-85) that drains
  // in-flight jobs for up to 30s before exit. We give it 35s here to
  // account for signal-delivery latency. Operator pauses stay in drain mode
  // unless their marker explicitly authorizes --force; OS stop signals retain
  // the historical SIGKILL escalation as a last resort.
  //
  // No `process.on('exit')` handler — its callback runs synchronously and
  // cannot await the worker's drain.
  let pausePoll: ReturnType<typeof setInterval> | undefined;
  const shutdown = async (sig: string, forceAfterDrain = sig !== 'operator_pause') => {
    if (stopping) return;
    stopping = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    console.log(`Autopilot stopping (${sig}).`);
    runtimeStatus.state = 'stopping';
    runtimeStatus.updatedAt = new Date().toISOString();
    runtimeStatus.heartbeatAt = runtimeStatus.updatedAt;
    try { writeRuntimeStatus(runtimeStatus); } catch { /* best-effort */ }
    if (childSupervisor) {
      childSupervisor.killChild('SIGTERM');
      await childSupervisor.awaitChildExit(35_000);
      if (childSupervisor.childAlive && forceAfterDrain) {
        childSupervisor.killChild('SIGKILL');
      } else {
        while (childSupervisor.childAlive) {
          console.warn('Autopilot drain is still running; task remains disabled. Use `autopilot --pause --force` only when termination is intended.');
          await childSupervisor.awaitChildExit(30_000);
        }
      }
    }
    if (pausePoll) clearInterval(pausePoll);
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    try { deleteRuntimeStatus(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  startChildSupervisor?.();
  // `autopilot --pause` first disables the Windows task, then writes this
  // marker. The running daemon observes it and uses the graceful drain above;
  // only a marker written by `autopilot --pause --force` permits escalation.
  pausePoll = setInterval(() => {
    const pauseRequest = readAutopilotPauseRequest();
    if (pauseRequest) void shutdown('operator_pause', pauseRequest.force === true);
  }, 2000);
  heartbeatTimer = setInterval(refreshRuntimeHeartbeat, 30_000);
  heartbeatTimer.unref?.();

  let consecutiveErrors = 0;
  // v0.37.7.0 #1162 — counter for consecutive reconnect failures.
  // Reset on every successful health probe or reconnect. Threshold
  // controlled by VOLTMIND_AUTOPILOT_MAX_RECONNECT_FAILS env (default 30).
  let autopilotReconnectFails = 0;
  const AUTOPILOT_MAX_RECONNECT_FAILS = Math.max(
    1,
    Number(process.env.VOLTMIND_AUTOPILOT_MAX_RECONNECT_FAILS) || 30,
  );
  // Peer-worker liveness for --no-worker mode. The probe is a proxy, not
  // ground truth: SELECT count(*) of active jobs with a recent lock_until
  // refresh. A queue with only waiting jobs and a healthy idle worker
  // reads as "no worker" (false positive); a worker that died 110s ago
  // while holding a lock reads as "alive" until lock_until expires.
  // Good enough for V1 — a ground-truth minion_workers heartbeat table
  // is tracked as v0.19.1 follow-up B7. When the probe sees no signal
  // for NO_WORKER_WARN_TICKS consecutive cycles, log a loud warning so
  // the operator can spot "I set --no-worker but forgot to start one"
  // before the queue piles up.
  const NO_WORKER_WARN_TICKS = 3;
  let noWorkerConsecutiveIdle = 0;
  // v0.36+ T8: track time since last full cycle for the 60-min floor.
  // Initialized to "long ago" so the first tick on a healthy brain still
  // runs the full cycle (phase-coupling exercise) before settling into
  // targeted-submit mode.
  let lastFullCycleAt = 0;

  while (!stopping) {
    const cycleStart = Date.now();
    let cycleOk = true;

    // Refresh the lock mtime so another cron-fired autopilot doesn't
    // declare the instance stale after 10 minutes (Codex C).
    try { utimesSync(lockPath, new Date(), new Date()); } catch { /* best-effort */ }

    // DB health check (reconnect if needed).
    //
    // v0.37.7.0 #1162: classify reconnect failures. Pre-fix, the
    // catch logged the error and looped forever — when `database_url`
    // was unset/malformed the loop spammed `config.database_url
    // undefined` until launchd was killed manually. Now:
    //   - Recoverable transient (network blip, pool saturated, 503) →
    //     log + retry next tick. Up to VOLTMIND_AUTOPILOT_MAX_RECONNECT_FAILS
    //     consecutive failures before exit (default 30 = ~5min at
    //     10s ticks).
    //   - Unrecoverable (database_url unset, malformed URL, auth
    //     failure) → exit immediately with a clear stderr line.
    //     ThrottleInterval=60 in the launchd plist (v0.37.7.0) ensures
    //     launchd's KeepAlive backoff actually backs off instead of
    //     thrashing.
    try {
      await engine.getConfig('version');
      autopilotReconnectFails = 0; // reset on success
      runtimeStatus.database.state = 'connected';
      runtimeStatus.database.lastConnectedAt = new Date().toISOString();
    } catch (probeErr) {
      try {
        // Rebuild using the engine's saved connection config. Calling
        // disconnect() followed by a no-argument connect() leaves the
        // module-level Postgres singleton disconnected and causes the next
        // cycle/extract to fail with "connect() has not been called".
        if (!await reconnectEngine(engine as any)) {
          throw new Error('engine does not support configuration-preserving reconnect');
        }
        autopilotReconnectFails = 0;
        runtimeStatus.database.state = 'connected';
        runtimeStatus.database.lastConnectedAt = new Date().toISOString();
      } catch (e) {
        logError('reconnect', e);
        autopilotReconnectFails++;
        runtimeStatus.database.state = 'error';
        runtimeStatus.database.lastError = e instanceof Error ? e.message : String(e);
        const klass = classifyReconnectError(e);
        if (klass === 'unrecoverable') {
          console.error(
            `[autopilot] FATAL: unrecoverable DB error (${(e as Error).message ?? 'unknown'}). ` +
            `Exiting so launchd ThrottleInterval can apply backoff.`,
          );
          stopping = true;
          process.exitCode = 1;
          break;
        }
        if (autopilotReconnectFails >= AUTOPILOT_MAX_RECONNECT_FAILS) {
          console.error(
            `[autopilot] FATAL: ${autopilotReconnectFails} consecutive reconnect failures. ` +
            `Last error: ${(e as Error).message ?? 'unknown'}. Exiting.`,
          );
          stopping = true;
          process.exitCode = 1;
          break;
        }
      }
    }

    // --no-worker peer-liveness probe (v0.19.1). Runs every cycle, cheap
    // (single SELECT). See NO_WORKER_WARN_TICKS comment above for caveats.
    if (noWorker && useMinionsDispatch) {
      try {
        const rows = await (engine as any).executeRaw?.(
          `SELECT count(*)::int AS n FROM minion_jobs
             WHERE status = 'active'
               AND lock_until IS NOT NULL
               AND lock_until > now() - interval '2 minutes'`,
        );
        const liveWorkerSignal = Number((rows as Array<{ n: number }>)?.[0]?.n ?? 0);
        if (liveWorkerSignal === 0) {
          noWorkerConsecutiveIdle++;
          if (noWorkerConsecutiveIdle === NO_WORKER_WARN_TICKS) {
            // Fire loud on the Nth consecutive idle tick; don't repeat on every
            // subsequent cycle (the operator already saw it), re-arm once a
            // live worker is seen again.
            console.error(
              `[autopilot] WARNING: --no-worker set and no worker has claimed a job in ~${NO_WORKER_WARN_TICKS * baseInterval}s. ` +
              `Jobs will pile up in 'waiting' until a worker starts. ` +
              `Probe is a proxy (lock_until refresh) and can false-positive on idle queues — see B7 for ground-truth follow-up.`,
            );
          }
        } else {
          if (noWorkerConsecutiveIdle >= NO_WORKER_WARN_TICKS) {
            console.log('[autopilot] --no-worker probe: live worker signal detected; warning re-armed.');
          }
          noWorkerConsecutiveIdle = 0;
        }
      } catch (e) {
        // Probe failures never block the main dispatch loop. Log once per
        // failure class; ignore repeated errors (common shape: DB reconnect
        // blip between ticks).
        logError('no-worker-probe', e);
      }
    }

    if (useMinionsDispatch) {
      // v0.36+ brain-health-100 wave (T8): targeted-submit loop.
      //
      // Pre-fix: every tick submitted ONE autopilot-cycle job, full phase
      // set, regardless of brain state. On a healthy brain this was pure
      // overhead. On a degraded brain it bundled fast wins (embed) with
      // slow phases (synthesize) so the user waited for the slowest.
      //
      // New logic: compute the remediation plan (cheap; no full doctor
      // walk), then route to the right level of intervention:
      //   - Score >= 95 + empty plan: full cycle every 60min (phase-
      //     coupling exercise), otherwise sleep.
      //   - Small plan (<=3 steps, <5min): submit individual handlers.
      //   - Large plan or low score: full autopilot-cycle (the hammer).
      //
      // D10 cycle-lock invariant ensures targeted-submit and
      // autopilot-cycle can never run concurrently (both acquire
      // voltmind-cycle), so the "60-min floor double-processes queued
      // targeted jobs" failure mode is closed by the lock.
      //
      // v0.40 D17 layered on top: per-source freshness check fires BEFORE
      // the score gate so a healthy brain that happens to have a stale
      // federated source still picks up new commits. brain_score reflects
      // internal data quality (embed coverage, link density, orphans),
      // NOT whether GitHub has new commits on the source repo. Decoupling
      // the two closes the silent-stale-source bug class on
      // poll-only deployments.
      try {
        const { MinionQueue } = await import('../core/minions/queue.ts');
        const { computeRecommendations, embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG } = await import('../core/brain-score-recommendations.ts');
        const queue = new MinionQueue(engine);
        const slotMs = Math.floor(Date.now() / (baseInterval * 1000)) * baseInterval * 1000;
        const slot = new Date(slotMs).toISOString();
        const timeoutMs = Math.max(baseInterval * 2 * 1000, 300_000);

        // ── v0.40 D17: per-source freshness check ────────────────────
        // Runs first; independent of score gate. Submits a 'sync' job per
        // source whose last_sync_at is older than the interval. The sync
        // handler (T6/T7) auto-enqueues embed-backfill on completion if
        // pages changed.
        try {
          const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
          if (await isFederatedV2Enabled(engine)) {
            const { loadAllSources } = await import('../core/sources-load.ts');
            const sources = await loadAllSources(engine);
            const intervalMs = baseInterval * 1000;
            const now = Date.now();
            for (const src of sources) {
              if (!src.local_path) continue;
              const lastSyncMs = src.last_sync_at ? new Date(src.last_sync_at).getTime() : 0;
              const ageMs = now - lastSyncMs;
              if (ageMs < intervalMs) continue; // fresh enough
              try {
                const job = await queue.add(
                  'sync',
                  {
                    sourceId: src.id,
                    repoPath: src.local_path,
                    auto_embed_backfill: true,
                    embed_reason: 'autopilot_freshness',
                  },
                  {
                    queue: 'default',
                    idempotency_key: `autopilot-sync:${src.id}:${slot}`,
                    max_attempts: 2,
                    timeout_ms: timeoutMs,
                    maxWaiting: 1,
                  },
                );
                if (jsonMode) {
                  process.stderr.write(JSON.stringify({
                    event: 'dispatched', job_id: job.id, mode: 'freshness',
                    source_id: src.id, age_ms: ageMs,
                  }) + '\n');
                } else {
                  console.log(`[dispatch] job #${job.id} sync (freshness: ${src.id}; age=${Math.floor(ageMs / 60000)}min)`);
                }
              } catch (e) {
                logError('dispatch.freshness', e);
              }
            }
          }
        } catch (e) {
          logError('dispatch.freshness-gate', e);
        }

        // Cheap path: engine.getHealth() is a single SQL count query.
        const health = await engine.getHealth();
        const score = health.brain_score;
        // v0.40.x: recipe-aware embedding-provider check shared with doctor.ts.
        // Resolve the configured model (gateway → DB fallback), then pre-await
        // the handful of hosted-key config values so the resolveKey closure
        // passed to embeddingProviderConfigured() can stay synchronous.
        let embeddingModel: string | undefined;
        try {
          const gw = await import('../core/ai/gateway.ts');
          embeddingModel = gw.getEmbeddingModel();
        } catch {
          embeddingModel = (await engine.getConfig('embedding_model')) ?? undefined;
        }
        const embedKeyCfg: Record<string, string | null> = {};
        for (const field of Object.values(HOSTED_EMBED_KEY_CONFIG)) {
          embedKeyCfg[field] = await engine.getConfig(field);
        }
        const ctx = {
          repoPath,
          embeddingModel,
          embeddingProviderConfigured: embeddingProviderConfigured(embeddingModel, (envVar) => {
            const cfgField = HOSTED_EMBED_KEY_CONFIG[envVar];
            return !!(process.env[envVar] || (cfgField ? embedKeyCfg[cfgField] : undefined));
          }),
          hasChatApiKey: !!(process.env.ANTHROPIC_API_KEY || await engine.getConfig('anthropic_api_key')),
        };
        // v0.41.18.0 (A5 + A19 + A22, T15): consult onboard recommendations
        // ALONGSIDE doctor's brain-score recommendations. Onboard's 4 new
        // checks (embed_staleness, link_coverage, timeline_coverage,
        // takes_count) supply extraRemediations into computeRecommendations.
        // Per A19 fail-open: any throw in the onboard path falls through
        // to legacy doctor-only plan (no crash).
        let extraRemediations: ReturnType<typeof computeRecommendations> = [];
        try {
          const { runAllOnboardChecks } = await import('../core/onboard/checks.ts');
          const onboardResults = await runAllOnboardChecks(engine);
          extraRemediations = onboardResults.flatMap((r) => r.remediations);
        } catch (err) {
          process.stderr.write(
            `[autopilot] onboard checks failed (fail-open per A19): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        const plan = computeRecommendations(health, ctx, extraRemediations).filter((r) => r.status === 'remediable');
        const estTotal = plan.reduce((s, r) => s + r.est_seconds, 0);

        // Track time since last full cycle for the 60-min floor.
        const FULL_CYCLE_FLOOR_MIN = 60;
        const minutesSinceLastFull = (Date.now() - lastFullCycleAt) / 60000;

        const shouldFullCycle =
          (score >= 95 && plan.length === 0 && minutesSinceLastFull >= FULL_CYCLE_FLOOR_MIN) ||
          plan.length > 3 ||
          estTotal >= 300 ||
          score < 70;

        const shouldSleep = score >= 95 && plan.length === 0 && minutesSinceLastFull < FULL_CYCLE_FLOOR_MIN;

        if (shouldSleep) {
          if (jsonMode) {
            process.stderr.write(JSON.stringify({ event: 'skip_healthy', score, plan_size: 0 }) + '\n');
          }
        } else if (shouldFullCycle) {
          // v0.38: per-source fan-out replaces the single-job dispatch.
          // dispatchPerSource enumerates sources via listAllSources
          // ({ localPathOnly: true }), gates each on per-source
          // `last_full_cycle_at` from sources.config JSONB, and fans out
          // up to `fanoutMax` per tick (default 4 Postgres, 1 PGLite per
          // codex P1-3). Fresh-install brains with no sources rows fall
          // back to the legacy single autopilot-cycle so existing
          // behavior is preserved.
          const { dispatchPerSource, resolveFanoutMax } = await import('./autopilot-fanout.ts');
          const fanoutMax = await resolveFanoutMax(engine);
          const result = await dispatchPerSource(engine, queue, {
            repoPath,
            slot,
            timeoutMs,
            fanoutMax,
            jsonMode,
          });
          if (result.dispatched.length > 0 || result.legacy_fallback) {
            lastFullCycleAt = Date.now();
          }
          if (jsonMode) {
            process.stderr.write(JSON.stringify({
              event: 'fanout_summary',
              dispatched: result.dispatched,
              skipped_fresh: result.skipped_fresh,
              skipped_cap: result.skipped_cap,
              legacy_fallback: result.legacy_fallback,
              fanout_max: fanoutMax,
              score,
            }) + '\n');
          } else if (!result.legacy_fallback) {
            console.log(
              `[dispatch] fanout: ${result.dispatched.length} dispatched, ` +
              `${result.skipped_fresh.length} fresh, ${result.skipped_cap.length} capped ` +
              `(score=${score}, max=${fanoutMax})`,
            );
          }
        } else {
          // Small targeted plan — submit individual handlers per step.
          // D9 content-hash idempotency keys (from computeRecommendations).
          // maxWaiting:1 per submit per codex #17 (closes the backpressure
          // gap the prior implementation had for targeted submits).
          for (const step of plan) {
            try {
              const isProtected = !!step.protected;
              const submitOpts = {
                queue: 'default',
                idempotency_key: step.idempotency_key,
                max_attempts: 2,
                timeout_ms: timeoutMs,
                maxWaiting: 1,
              };
              const job = await queue.add(
                step.job,
                step.params,
                submitOpts,
                isProtected ? { allowProtectedSubmit: true } : undefined,
              );
              if (jsonMode) {
                process.stderr.write(JSON.stringify({ event: 'dispatched', job_id: job.id, mode: 'targeted', step: step.id, score, plan_size: plan.length }) + '\n');
              } else {
                console.log(`[dispatch] job #${job.id} ${step.job} (targeted: ${step.id}; score=${score})`);
              }
            } catch (e) {
              logError('dispatch.step', e);
            }
          }
        }
      } catch (e) { logError('dispatch', e); cycleOk = false; }
    } else {
      // Inline fallback — delegate to runCycle so lint + backlinks +
      // orphan sweep run too (previously this path only did sync +
      // extract + embed, which didn't match the Minions-dispatch
      // path's phase set). Now both converge on the same primitive.
      try {
        const { runCycle } = await import('../core/cycle.ts');
        const report = await runCycle(engine, {
          brainDir: repoPath,
          // Autopilot daemon path: pulls by default (matches
          // pre-v0.17 autopilot behavior). CLI dream defaults false
          // for cron safety; that choice is scoped to dream only.
          pull: true,
          yieldBetweenPhases: async () => {
            await new Promise(r => setImmediate(r));
          },
        });
        // Only 'failed' (every attempted phase failed) trips the autopilot
        // circuit breaker. 'partial' means at least one phase warned or
        // failed while others ran — that's a soft signal, not a fatal
        // condition. Treating 'partial' as failure here caused respawn
        // storms under KeepAlive=true on brains where a single phase
        // (typically `orphans`) emits a 'warn' every cycle in steady state.
        if (report.status === 'failed') {
          cycleOk = false;
        }
        if (jsonMode) {
          process.stderr.write(JSON.stringify({ event: 'cycle-inline', status: report.status, duration_ms: report.duration_ms, totals: report.totals }) + '\n');
        } else {
          const t = report.totals;
          console.log(`[cycle-inline ${report.status}] lint=${t.lint_fixes} backlinks=${t.backlinks_added} synced=${t.pages_synced} extracted=${t.pages_extracted} embedded=${t.pages_embedded} orphans=${t.orphans_found}`);
        }
      } catch (e) { logError('cycle-inline', e); cycleOk = false; }
    }

    // 4. Health check + adaptive interval (same for both paths)
    let interval = baseInterval;
    try {
      const health = await engine.getHealth();
      const score = (health as any).brain_score ?? 50;
      interval = score >= 90 ? baseInterval * 2
               : score < 70 ? Math.max(Math.floor(baseInterval / 2), 60)
               : baseInterval;

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0);
      const line = `[cycle] score=${score} elapsed=${elapsed}s next=${interval}s`;
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'cycle', brain_score: score, elapsed_s: Number(elapsed), next_s: interval }) + '\n');
      } else {
        console.log(line);
      }
    } catch (e) { logError('health', e); }

    if (cycleOk) {
      consecutiveErrors = 0;
    } else {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        console.error('5 consecutive cycle failures. Stopping autopilot.');
        void shutdown('cycle-failure-cap');
        break;
      }
    }

    // 4.5 — Nightly quality probe (v0.41).
    // Per D10: trust the phase's internal 24h rate-limit (via shouldRunNightly
    // reading the audit JSONL). No scheduler-side precheck — one source of
    // truth for the rate-limit. Feature flag gates the probe entirely.
    // Wrapped in try/catch — a probe failure NEVER crashes the autopilot
    // loop. Probe runs even when cycleOk=false (probe may surface signal
    // explaining why the cycle is failing).
    try {
      const probeEnabled = cfg?.autopilot?.nightly_quality_probe?.enabled === true;
      if (probeEnabled) {
        const { runNightlyQualityProbe } = await import('../core/cycle/nightly-quality-probe.ts');
        const { runLongMemEvalForProbe, runCrossModalBatchForProbe } = await import('../core/cycle/nightly-probe-adapters.ts');
        const { isAvailable } = await import('../core/ai/gateway.ts');
        const maxUsd = Number(cfg?.autopilot?.nightly_quality_probe?.max_usd ?? 5);
        await runNightlyQualityProbe({
          isEnabled: () => true, // already gated above; phase re-checks for defense-in-depth
          hasEmbeddingProvider: () => isAvailable('embedding'),
          resolveMaxUsd: () => maxUsd,
          resolveRepoRoot: () => repoPath ?? voltmindHomePath('.'),
          runLongMemEval: runLongMemEvalForProbe,
          runCrossModalBatch: runCrossModalBatchForProbe,
          now: () => new Date(),
        });
      }
    } catch (e) {
      logError('autopilot.nightly_probe', e);
      // Intentional: do NOT bump consecutiveErrors. Probe failure is
      // informational; autopilot loop continues.
    }

    // Keep the loop-end write as an immediate status refresh. The separate
    // 30-second timer above covers the subsequent long sleep.
    refreshRuntimeHeartbeat();

    // Wait for next cycle
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

// --- Install/Uninstall ---

function plistPath(): string {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.voltmind.autopilot.plist');
}

function systemdUnitPath(): string {
  return join(process.env.HOME || '', '.config', 'systemd', 'user', 'voltmind-autopilot.service');
}

function ephemeralStartScriptPath(): string {
  return join(process.env.HOME || '', '.voltmind', 'start-autopilot.sh');
}

// Re-export the unified InstallTarget (now includes 'windows-task') for
// backward compatibility. Existing imports of `InstallTarget` from this
// module keep working.
export type { InstallTarget } from '../core/autopilot/diagnostics.ts';

/**
 * Detect the right supervisor for this host.
 *
 *   - win32  → windows-task (NEVER falls back to linux-cron).
 *   - macos   → launchd (always, when platform === 'darwin').
 *   - ephemeral-container → Render / Railway / Fly / Docker. Crontab is
 *                           unreliable here (wiped on deploy); we hand
 *                           the user a start script instead.
 *   - linux-systemd → systemd user scope actually works (is-system-running
 *                     probe succeeds). Codex hardened from the naive
 *                     /run/systemd/system check.
 *   - linux-cron  → fallback.
 *
 * Delegates to the unified detector in core/autopilot/detect-target.ts so
 * the CLI entry and the adapter registry share one source of truth.
 */
export function detectInstallTarget(): InstallTarget {
  const forced = (process.env as Record<string, string | undefined>).VOLTMIND_AUTOPILOT_TARGET;
  const result = detectInstallTargetUnified({ platform: process.platform, env: process.env, forcedTarget: forced });
  return result.target;
}

function detectOpenClaw(): { detected: boolean; bootstrapCandidates: string[] } {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.OPENCLAW_HOME ? join(process.env.OPENCLAW_HOME, 'hooks', 'bootstrap', 'ensure-services.sh') : '',
    join(process.cwd(), 'hooks', 'bootstrap', 'ensure-services.sh'),
    join(home, '.claude', 'hooks', 'bootstrap', 'ensure-services.sh'),
  ].filter(Boolean) as string[];
  const existing = candidates.filter(p => existsSync(p));
  const signal = !!process.env.OPENCLAW_HOME
    || existsSync(join(process.cwd(), 'openclaw.json'))
    || existsSync(join(home, 'openclaw.json'))
    || existing.length > 0;
  return { detected: signal, bootstrapCandidates: existing };
}

function writeWrapperScript(repoPath: string): string {
  const home = process.env.HOME || '';
  const voltmindDir = join(home, '.voltmind');
  mkdirSync(voltmindDir, { recursive: true });

  // Wrapper sources the user's shell profile for API keys so nothing is
  // baked into plist/crontab/systemd unit files (#2).
  const wrapperPath = join(voltmindDir, 'autopilot-run.sh');
  const voltmindPath = resolveVoltMindCliPath();
  const safeRepoPath = repoPath.replace(/'/g, "'\\''");
  const safeVoltMindPath = voltmindPath.replace(/'/g, "'\\''");
  const wrapper = `#!/bin/bash
# Auto-generated by voltmind autopilot --install
# Sources shell profile for API keys, then runs autopilot.
# zshenv is the canonical place for env vars in zsh on macOS (zshrc is for
# interactive shells only — vars defined there don't reach this non-interactive
# subprocess). Source it first so secrets like VOLTMIND_DATABASE_URL or any
# OPENAI/ANTHROPIC keys exported in zshenv reach autopilot.
[ -f ~/.zshenv ] && source ~/.zshenv 2>/dev/null
source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
exec '${safeVoltMindPath}' autopilot --repo '${safeRepoPath}'
`;
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  return wrapperPath;
}

async function installDaemon(engine: BrainEngine, args: string[]) {
  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  if (!repoPath) {
    console.error('No repo path. Use --repo or run voltmind sync --repo first.');
    process.exit(1);
  }

  const forcedTarget = parseArg(args, '--target');
  if (forcedTarget && !isInstallTarget(forcedTarget)) {
    console.error(`Unknown --target "${forcedTarget}". Allowed: macos, linux-systemd, ephemeral-container, linux-cron, windows-task.`);
    process.exit(2);
  }
  const detection = detectInstallTargetUnified({
    platform: process.platform,
    env: process.env,
    forcedTarget: forcedTarget,
  });
  const target: InstallTarget = detection.target;

  // The CLI dispatcher loads --runtime-env-file once before connectEngine.
  // Keep this function focused on target detection and preflight; reloading
  // here would mutate process.env a second time after engine initialization.
  const runtimeEnvFile = parseArg(args, '--runtime-env-file');

  // Preflight (spec §7). On Windows, a supervised Minion worker requires
  // Postgres/Supabase; PGLite is an embedded single-process engine and only
  // supports inline execution. Do not silently downgrade.
  const cfg = loadConfig();
  const engineType = cfg?.engine ?? 'pglite';
  if (target === 'windows-task' && engineType !== 'postgres') {
    console.error(
      'Autopilot with a supervised Minion worker cannot be installed\n' +
      'with PGLite on Windows.\n\n' +
      'PGLite is an embedded single-process engine and only supports\n' +
      'the inline execution path. Configure Supabase/Postgres before\n' +
      'running `voltmind autopilot --install`.',
    );
    process.exit(1);
  }

  const injectBootstrap = args.includes('--inject-bootstrap');
  const noInject = args.includes('--no-inject');

  if (target === 'windows-task') {
    await installWindowsTask(engine, repoPath, runtimeEnvFile, !args.includes('--paused'));
    return;
  }

  const wrapperPath = writeWrapperScript(repoPath);
  const home = process.env.HOME || '';

  switch (target) {
    case 'macos':
      installLaunchd(wrapperPath, home, repoPath);
      writeInstallManifest('macos', repoPath, wrapperPath, runtimeEnvFile);
      break;
    case 'linux-systemd':
      installSystemd(wrapperPath, repoPath);
      writeInstallManifest('linux-systemd', repoPath, wrapperPath, runtimeEnvFile, { serviceName: 'voltmind-autopilot.service' });
      break;
    case 'ephemeral-container':
      installEphemeralContainer(wrapperPath, home, repoPath, { injectBootstrap, noInject });
      writeInstallManifest('ephemeral-container', repoPath, wrapperPath, runtimeEnvFile);
      break;
    case 'linux-cron':
      installCrontab(wrapperPath, home);
      writeInstallManifest('linux-cron', repoPath, wrapperPath, runtimeEnvFile);
      break;
    default: {
      console.error(`Unknown --target "${forcedTarget}". Allowed: macos, linux-systemd, ephemeral-container, linux-cron, windows-task.`);
      process.exit(2);
    }
  }
}

/** Resolve the CLI invocation for the install manifest (shared resolver). */
async function writeInstallManifest(target: InstallTarget, repoPath: string, wrapperPath: string, runtimeEnvFile?: string, scheduler?: { taskName?: string; serviceName?: string }): Promise<void> {
  try {
    const existing = loadManifest();
    // Reconcile existing install; never auto-create for never-installed users
    // outside the explicit --install path. We are inside --install here so
    // create is allowed.
    const cliInvocation = await resolveCliInvocation({ repoRoot: repoPath });
    const base = existing ?? createManifest({
      target,
      repoPath,
      cliInvocation: { executable: wrapperPath, prefixArgs: [], source: 'unix-shim' },
      runtimeEnvFile,
      scheduler,
      installVersion: VERSION,
    });
    const reconciled = reconcileManifest(base, {
      repoPath,
      cliInvocation: { executable: wrapperPath, prefixArgs: [], source: 'unix-shim' },
      runtimeEnvFile,
      scheduler,
      installVersion: VERSION,
    });
    if (base !== existing) reconciled.target = target;
    saveManifest(reconciled);
  } catch { /* manifest is best-effort metadata; never fail install on it */ }
}

/** Windows install path: resolve CLI, register Task Scheduler task, start, write manifest. */
async function installWindowsTask(engine: BrainEngine, repoPath: string, runtimeEnvFile?: string, startImmediately = true): Promise<void> {
  const cliInvocation = await resolveCliInvocation({ repoRoot: repoPath });
  const result = await windowsTaskSchedulerAdapter.install({
    target: 'windows-task',
    repoPath,
    cliInvocation,
    runtimeEnvFile,
    workingDirectory: repoPath,
    startImmediately,
  });
  console.log(`Installed Windows Task Scheduler entry: ${result.schedulerName ?? 'VoltMind Autopilot'}`);
  console.log(`  Repo: ${repoPath}`);
  console.log(`  Target: windows-task`);
  console.log(`  Worker: supervised (minion_mode must not be off)`);
  if (!startImmediately) console.log('  State: disabled (start later with voltmind autopilot --start)');
  console.log('  Uninstall: voltmind autopilot --uninstall');
  // Write manifest.
  try {
    const existing = loadManifest();
    const base = existing ?? createManifest({
      target: 'windows-task',
      repoPath,
      cliInvocation: { executable: cliInvocation.executable, prefixArgs: cliInvocation.prefixArgs, source: cliInvocation.source },
      runtimeEnvFile,
      scheduler: { taskName: result.schedulerName },
      installVersion: VERSION,
    });
    const reconciled = reconcileManifest(base, {
      repoPath,
      cliInvocation: { executable: cliInvocation.executable, prefixArgs: cliInvocation.prefixArgs, source: cliInvocation.source },
      runtimeEnvFile,
      scheduler: { taskName: result.schedulerName },
      installVersion: VERSION,
    });
    if (base !== existing) reconciled.target = 'windows-task';
    saveManifest(reconciled);
  } catch { /* best-effort */ }
}

// v0.37.7.0 #1162 — pure function for plist generation so tests can
// assert ThrottleInterval/KeepAlive shape without an installed daemon.
export function generateLaunchdPlist(wrapperPath: string, home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.voltmind.autopilot</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(wrapperPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!--
    v0.37.7.0 #1162: ThrottleInterval=60 forces launchd to wait at
    least 60s between relaunches. Combined with the in-process
    classifier (recoverable vs unrecoverable in the supervisor loop),
    this prevents the spinning respawn pattern where an unrecoverable
    error (missing database_url, malformed config) immediately
    relaunched and re-hit the same error. ThrottleInterval is a hard
    floor; launchd would have applied a default of 10s if unset.
  -->
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${escapeXml(home)}/.voltmind/autopilot.log</string>
  <key>StandardErrorPath</key><string>${escapeXml(home)}/.voltmind/autopilot.err</string>
</dict>
</plist>`;
}

function installLaunchd(wrapperPath: string, home: string, repoPath: string) {
  const plist = generateLaunchdPlist(wrapperPath, home);

  try {
    const agentsDir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(plistPath(), plist);
    execSync(`launchctl load "${plistPath()}"`, { stdio: 'pipe' });
    console.log('Installed launchd service: com.voltmind.autopilot');
    console.log(`  Repo: ${repoPath}`);
    console.log(`  Log: ~/.voltmind/autopilot.log`);
    console.log('  Uninstall: voltmind autopilot --uninstall');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('EACCES') || msg.includes('Permission')) {
      console.error('Permission denied writing plist. Try: mkdir -p ~/Library/LaunchAgents');
    } else {
      console.error(`Failed to install: ${msg}`);
    }
    process.exit(1);
  }
}

function installSystemd(wrapperPath: string, repoPath: string) {
  const unit = `[Unit]
Description=VoltMind Autopilot
After=network-online.target

[Service]
Type=simple
ExecStart=${wrapperPath}
Restart=on-failure
RestartSec=30
StandardOutput=append:%h/.voltmind/autopilot.log
StandardError=append:%h/.voltmind/autopilot.err

[Install]
WantedBy=default.target
`;
  try {
    const unitPath = systemdUnitPath();
    mkdirSync(join(process.env.HOME || '', '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unitPath, unit);
    execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 10_000 });
    execSync('systemctl --user enable --now voltmind-autopilot.service', { stdio: 'pipe', timeout: 15_000 });
    console.log('Installed systemd user service: voltmind-autopilot.service');
    console.log(`  Repo: ${repoPath}`);
    console.log('  Log: ~/.voltmind/autopilot.log');
    console.log('  Uninstall: voltmind autopilot --uninstall');
  } catch (e: unknown) {
    console.error(`Failed to install systemd unit: ${e instanceof Error ? e.message : e}`);
    console.error('You may need: `loginctl enable-linger $USER` so the unit runs without a login session.');
    process.exit(1);
  }
}

function installEphemeralContainer(
  wrapperPath: string,
  home: string,
  repoPath: string,
  opts: { injectBootstrap: boolean; noInject: boolean },
) {
  // Write a start script the agent's bootstrap can source on every container start.
  const safeWrapperPath = wrapperPath.replace(/'/g, "'\\''");
  const script = `#!/bin/bash
# Auto-generated by voltmind autopilot --install (ephemeral-container target)
# Ephemeral filesystems lose crontab on every deploy; source this from
# your agent's bootstrap instead.
nohup '${safeWrapperPath}' > ~/.voltmind/autopilot.log 2>&1 &
echo \$! > ~/.voltmind/autopilot.pid
`;
  const scriptPath = ephemeralStartScriptPath();
  mkdirSync(join(home, '.voltmind'), { recursive: true });
  writeFileSync(scriptPath, script, { mode: 0o755 });

  console.log('Ephemeral container detected (Render / Railway / Fly / Docker).');
  console.log(`Repo: ${repoPath}`);
  console.log(`Start script: ${scriptPath}`);
  console.log('');
  console.log('Crontab is unreliable here (wiped on deploy). Add ONE LINE to your');
  console.log('agent bootstrap to launch autopilot on every start:');
  console.log('');
  console.log(`  bash ${scriptPath}`);
  console.log('');

  // OpenClaw detection + optional auto-injection into ensure-services.sh.
  const { detected, bootstrapCandidates } = detectOpenClaw();
  if (detected) {
    console.log(`OpenClaw detected. Bootstrap candidates found:`);
    for (const p of bootstrapCandidates) console.log(`  - ${p}`);
    console.log('');
  }

  const shouldInject = (injectOpts: { detected: boolean; injectBootstrap: boolean; noInject: boolean }) => {
    if (injectOpts.noInject) return false;
    // Auto-inject by default when OpenClaw is detected + at least one
    // candidate exists. Users can explicitly opt in with --inject-bootstrap
    // on other hosts (uncommon).
    if (injectOpts.detected && bootstrapCandidates.length > 0) return true;
    return injectOpts.injectBootstrap;
  };

  if (shouldInject({ detected, injectBootstrap: opts.injectBootstrap, noInject: opts.noInject })) {
    for (const candidate of bootstrapCandidates) {
      try {
        const existing = readFileSync(candidate, 'utf-8');
        const marker = '# voltmind:autopilot v0.11.0';
        if (existing.includes(marker)) {
          console.log(`  [skip] ${candidate} already has the voltmind marker`);
          continue;
        }
        // Backup before edit
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const bakPath = `${candidate}.bak.${stamp}`;
        writeFileSync(bakPath, existing);
        const snippet = `\n${marker}\nbash ${scriptPath}\n`;
        writeFileSync(candidate, existing.trimEnd() + snippet);
        console.log(`  [injected] ${candidate} (.bak at ${bakPath})`);
      } catch (e) {
        console.error(`  [warn] failed to inject ${candidate}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.log('  Uninstall: voltmind autopilot --uninstall');
}

function installCrontab(wrapperPath: string, home: string) {
  // Linux/WSL without systemd — crontab runs the wrapper every 5 minutes.
  const safeWrapperPath = wrapperPath.replace(/'/g, "'\\''");
  const cronLine = `*/5 * * * * '${safeWrapperPath}' >> '${home.replace(/'/g, "'\\''")}/.voltmind/autopilot.log' 2>&1`;
  try {
    const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    if (existing.includes('voltmind autopilot') || existing.includes('autopilot-run.sh')) {
      console.log('Crontab entry already exists. Remove with: voltmind autopilot --uninstall');
      return;
    }
    // Use a temp file instead of echo pipe to avoid shell escaping issues (#1)
    const tmpFile = join(home, '.voltmind', 'crontab.tmp');
    writeFileSync(tmpFile, existing.trimEnd() + '\n' + cronLine + '\n');
    execSync(`crontab '${tmpFile.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    try { unlinkSync(tmpFile); } catch { /* best-effort */ }
    console.log('Installed crontab entry for voltmind autopilot (every 5 minutes)');
    console.log('  Uninstall: voltmind autopilot --uninstall');
  } catch (e: unknown) {
    console.error(`Failed to install crontab: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

function uninstallDaemon() {
  const home = process.env.HOME || '';
  const wrapperPath = join(home, '.voltmind', 'autopilot-run.sh');

  // Always try all four targets — the user might have run `--install` under
  // one target earlier and moved hosts (e.g. macOS laptop → Linux server).
  // Each path is idempotent (missing files = skip silently).

  let removed = 0;

  // macOS launchd
  if (existsSync(plistPath())) {
    try {
      execSync(`launchctl unload "${plistPath()}" 2>/dev/null || true`, { stdio: 'pipe' });
      unlinkSync(plistPath());
      console.log('Removed launchd service: com.voltmind.autopilot');
      removed++;
    } catch (e) {
      console.error(`  [warn] launchd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Linux systemd user unit
  if (existsSync(systemdUnitPath())) {
    try {
      execSync('systemctl --user disable --now voltmind-autopilot.service 2>/dev/null || true', { stdio: 'pipe', timeout: 10_000 });
      unlinkSync(systemdUnitPath());
      try { execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 5_000 }); } catch { /* best-effort */ }
      console.log('Removed systemd user service: voltmind-autopilot.service');
      removed++;
    } catch (e) {
      console.error(`  [warn] systemd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Ephemeral container start script + bootstrap marker injection
  if (existsSync(ephemeralStartScriptPath())) {
    try {
      unlinkSync(ephemeralStartScriptPath());
      console.log('Removed ephemeral start script: ~/.voltmind/start-autopilot.sh');
      removed++;
    } catch (e) {
      console.error(`  [warn] start script: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Remove marker-line from any OpenClaw bootstrap we previously injected.
  try {
    const { bootstrapCandidates } = detectOpenClaw();
    for (const candidate of bootstrapCandidates) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        if (!content.includes('# voltmind:autopilot v0.11.0')) continue;
        const lines = content.split('\n');
        const cleaned: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('# voltmind:autopilot v0.11.0')) {
            // Skip this marker line AND the next line (the bash start-script call).
            i++;
            continue;
          }
          cleaned.push(lines[i]);
        }
        // Backup before edit
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        writeFileSync(`${candidate}.bak.${stamp}`, content);
        writeFileSync(candidate, cleaned.join('\n'));
        console.log(`Removed bootstrap marker from: ${candidate}`);
        removed++;
      } catch (e) {
        console.error(`  [warn] bootstrap ${candidate}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch { /* OpenClaw detection best-effort */ }

  // Linux crontab (don't gate on platform — the user may have run `--install
  // --target linux-cron` on a different machine that now has the crontab).
  try {
    const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    if (existing.includes('voltmind autopilot') || existing.includes('autopilot-run.sh')) {
      const filtered = existing.split('\n').filter(l =>
        !l.includes('voltmind autopilot') && !l.includes('autopilot-run.sh'),
      ).join('\n');
      const tmpFile = join(home, '.voltmind', 'crontab.tmp');
      mkdirSync(join(home, '.voltmind'), { recursive: true });
      writeFileSync(tmpFile, filtered);
      execSync(`crontab '${tmpFile.replace(/'/g, "'\\''")}' 2>/dev/null || true`, { stdio: 'pipe' });
      try { unlinkSync(tmpFile); } catch { /* best-effort */ }
      console.log('Removed crontab entry for voltmind autopilot');
      removed++;
    }
  } catch (e) {
    console.error(`  [warn] crontab: ${e instanceof Error ? e.message : e}`);
  }

  // Wrapper script — shared by all targets
  if (existsSync(wrapperPath)) {
    try {
      unlinkSync(wrapperPath);
    } catch { /* best-effort */ }
  }

  if (removed === 0) {
    console.log('No autopilot install found on this host. Nothing to uninstall.');
  }
}

/** Unified uninstall (spec §3.3). Calls the legacy uninstaller for Unix targets,
 * delegates to the Windows adapter on Windows, then deletes VoltMind-owned
 * manifest + runtime status. Never touches the user repo, config, env file,
 * or Supabase/Postgres data. */
async function uninstallDaemonUnified(): Promise<void> {
  if (process.platform === 'win32') {
    const manifest = loadManifest() ?? undefined;
    try {
      const res = await windowsTaskSchedulerAdapter.uninstall({ manifest });
      if (res.removed) console.log(`Removed Windows scheduled task: ${WINDOWS_TASK_NAME}`);
      else console.log('No Windows scheduled task found. Nothing to uninstall.');
    } catch (e) {
      console.error(`  [warn] Windows task: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    uninstallDaemon();
  }
  // Task Scheduler termination is not guaranteed to run Autopilot's signal
  // handler. Clean up only a lock whose recorded owner is no longer alive;
  // this preserves the singleton guard if a stop request is still draining.
  removeStaleAutopilotLock();
  // Delete VoltMind-owned manifest + runtime status (never user data).
  deleteManifest();
  deleteRuntimeStatus();
}

async function pauseWindowsAutopilot(json: boolean, force: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('autopilot --pause/--stop is currently supported on Windows Task Scheduler only.');
  }
  const paused = await windowsTaskSchedulerAdapter.pause();
  if (!paused.registered) {
    throw new Error(`Windows scheduled task "${WINDOWS_TASK_NAME}" is not installed.`);
  }
  const request = requestAutopilotPause({ force });
  const deadline = Date.now() + 40_000;
  let stopped = false;
  while (Date.now() < deadline) {
    const runtime = readRuntimeStatus();
    if (!runtime || !isProcessAlive(runtime.pid)) {
      stopped = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const result = {
    status: stopped ? 'paused' : 'pause_pending',
    scheduler_disabled: paused.disabled,
    graceful_stop_requested_at: request.requested_at,
    force_requested: force,
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (stopped) console.log('Autopilot paused: scheduled task disabled and running worker drained.');
  else console.error('Autopilot task is disabled and graceful stop is pending. It was not force-terminated.');
  if (!stopped) process.exitCode = 1;
}

async function startWindowsAutopilot(json: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('autopilot --start is currently supported on Windows Task Scheduler only.');
  }
  const manifest = loadManifest();
  if (!manifest || manifest.target !== 'windows-task') {
    throw new Error('No Windows Autopilot installation found. Run `voltmind autopilot --install` first.');
  }
  // Clear before enabling so a just-started daemon cannot observe a stale
  // pause request and immediately drain itself.
  const clearedPauseRequest = clearAutopilotPauseRequest();
  const started = await windowsTaskSchedulerAdapter.start();
  if (!started.registered || !started.started) {
    throw new Error(`Windows scheduled task "${WINDOWS_TASK_NAME}" could not be started.`);
  }
  const result = {
    status: 'started',
    scheduler_enabled: started.enabled,
    pause_request_cleared: clearedPauseRequest,
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log('Autopilot started: scheduled task enabled and start requested.');
}

type BusinessReadiness = {
  state: 'ready' | 'degraded' | 'unknown';
  reasons: string[];
  dead_jobs: number | null;
  consecutive_cycle_skips: number | null;
  last_successful_cycle_at: string | null;
};

/**
 * Runtime liveness alone is not proof that the worker is consuming useful
 * work. Read the durable queue so `autopilot --status` can distinguish a
 * healthy scheduler from a brain stalled behind dead sync jobs or repeated
 * cycle-lock skips.
 */
async function readBusinessReadiness(engine: BrainEngine): Promise<BusinessReadiness> {
  try {
    type JobRow = {
      name: string;
      status: string;
      result: unknown;
      finished_at: string | Date | null;
      created_at: string | Date | null;
    };
    const rows = await engine.executeRaw<JobRow>(
      `SELECT name, status, result, finished_at, created_at
         FROM minion_jobs
        WHERE name IN ('sync', 'autopilot-cycle')
        ORDER BY COALESCE(finished_at, created_at) DESC
        LIMIT 100`,
    );
    const asObject = (value: unknown): Record<string, unknown> => {
      if (value && typeof value === 'object') return value as Record<string, unknown>;
      if (typeof value === 'string') {
        try { return JSON.parse(value) as Record<string, unknown>; } catch { /* fall through */ }
      }
      return {};
    };
    const asIso = (value: string | Date | null): string | null =>
      value instanceof Date ? value.toISOString() : value;
    const timestamp = (row: JobRow): number => {
      const raw = row.finished_at ?? row.created_at;
      return raw instanceof Date ? raw.getTime() : raw ? new Date(raw).getTime() : 0;
    };
    const completedCycles = rows.filter((r) => r.name === 'autopilot-cycle' && r.status === 'completed');
    const successfulCycle = completedCycles.find((r) => {
      const status = asObject(r.result).status;
      return status === 'ok' || status === 'clean';
    });
    const lastSuccessful = successfulCycle ? asIso(successfulCycle.finished_at) : null;
    const recoveredAfter = successfulCycle ? timestamp(successfulCycle) : 0;
    const deadJobs = rows.filter((r) => r.status === 'dead' && timestamp(r) >= recoveredAfter).length;
    const consecutiveSkips = completedCycles.slice(0, 3).filter((r) => {
      const result = asObject(r.result);
      const report = asObject(result.report);
      return result.status === 'skipped' && report.reason === 'cycle_already_running';
    }).length;
    const latestCycle = completedCycles[0];
    const latestReport = latestCycle ? asObject(asObject(latestCycle.result).report) : {};
    const latestPhases = Array.isArray(latestReport.phases) ? latestReport.phases : [];
    const latestSyncFailed = latestPhases.some((phase) => {
      const data = asObject(phase);
      const details = asObject(data.details);
      return data.phase === 'sync' && (
        data.status === 'fail' ||
        details.syncStatus === 'blocked_by_failures' ||
        details.syncStatus === 'partial'
      );
    });
    const reasons: string[] = [];
    if (deadJobs > 0) reasons.push(`unrecovered_dead_jobs:${deadJobs}`);
    if (consecutiveSkips >= 2) reasons.push(`consecutive_cycle_skips:${consecutiveSkips}`);
    if (latestSyncFailed) reasons.push('latest_cycle_sync_failed');
    if (!lastSuccessful) reasons.push('no_successful_full_cycle');
    return {
      state: reasons.length === 0 ? 'ready' : 'degraded',
      reasons,
      dead_jobs: deadJobs,
      consecutive_cycle_skips: consecutiveSkips,
      last_successful_cycle_at: lastSuccessful,
    };
  } catch {
    return {
      state: 'unknown',
      reasons: ['business_queue_unavailable'],
      dead_jobs: null,
      consecutive_cycle_skips: null,
      last_successful_cycle_at: null,
    };
  }
}

async function showStatus(engine: BrainEngine, json: boolean) {
  const logFile = join(process.env.HOME || '', '.voltmind', 'autopilot.log');
  let lastLine = '';
  try {
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    lastLine = lines[lines.length - 1] || '';
  } catch { /* no log */ }

  // Scheduler state (spec §3.3 status). On Windows, query Task Scheduler;
  // on Unix, fall back to file presence (existing behavior).
  let schedulerRegistered = false;
  let schedulerEnabled: boolean | undefined;
  let schedulerRunning = false;
  let schedulerTarget: string = 'unknown';
  let schedulerLastResult: string | undefined;
  let schedulerLastStartedAt: string | undefined;
  let schedulerCurrentState: string | undefined;
  if (process.platform === 'win32') {
    schedulerTarget = 'windows-task';
    try {
      const s = await windowsTaskSchedulerAdapter.status({ manifest: loadManifest() });
      schedulerRegistered = s.registered;
      schedulerEnabled = s.enabled;
      schedulerRunning = s.running;
      schedulerLastResult = s.lastResult;
      schedulerLastStartedAt = s.lastStartedAt;
      schedulerCurrentState = s.currentState;
    } catch { /* best-effort */ }
  } else {
    if (process.platform === 'darwin') {
      schedulerRegistered = existsSync(plistPath());
      schedulerTarget = 'macos';
    } else {
      try {
        const crontab = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
        schedulerRegistered = crontab.includes('voltmind autopilot');
        schedulerTarget = 'linux-cron';
      } catch { /* no crontab */ }
    }
  }

  // Runtime status file (spec §9) — autopilot pid, heartbeat, supervisor, DB.
  const rt = readRuntimeStatus();
  const heartbeatStale = rt ? isHeartbeatStale(rt.heartbeatAt, 120_000) : true;
  const autopilotProcessAlive = !!rt && isProcessAlive(rt.pid);
  const autopilotActive = !!rt && autopilotProcessAlive && !heartbeatStale && rt.state !== 'failed' && rt.state !== 'stopping';
  const manifest = loadManifest();
  if (manifest) schedulerTarget = manifest.target;

  const workerExpected = rt?.supervisor.workerExpected ?? false;
  const workerPidAlive = !!rt?.supervisor.workerPid && isProcessAlive(rt.supervisor.workerPid);
  const workerRunning = !!rt && rt.supervisor.state === 'running' && workerPidAlive;
  const runtimeReady = autopilotActive && schedulerRunning;
  const databaseReady = rt?.database.state === 'connected';
  const workerReady = !workerExpected || workerRunning;
  const business = await readBusinessReadiness(engine);
  const queueReady = business.dead_jobs === 0;

  // "ready" is an end-to-end assertion.  A stale status file, an inactive
  // Task, or a vanished worker must degrade it even when the last successful
  // business cycle is still recorded in Postgres.
  let overall: AutopilotOverallState = 'not-installed';
  if (manifest || schedulerRegistered) {
    overall = autopilotActive ? 'running' : 'installed';
    if (rt?.state === 'failed') {
      overall = 'failed';
    } else if (!runtimeReady || !databaseReady || !workerReady || !queueReady || business.state !== 'ready') {
      overall = 'degraded';
    } else if (rt && rt.engine === 'postgres' && workerExpected) {
      overall = 'ready';
    }
  }

  const summary = {
    install_target: schedulerTarget,
    scheduler_registered: schedulerRegistered,
    scheduler_enabled: schedulerEnabled,
    operator_paused: !!readAutopilotPauseRequest(),
    scheduler_running: schedulerRunning,
    scheduler_last_result: schedulerLastResult,
    scheduler_last_started_at: schedulerLastStartedAt,
    scheduler_current_state: schedulerCurrentState,
    autopilot_active: autopilotActive,
    autopilot_pid: rt?.pid,
    autopilot_started_at: rt?.startedAt,
    autopilot_heartbeat_at: rt?.heartbeatAt,
    autopilot_heartbeat_stale: heartbeatStale,
    singleton_lock: existsSync(autopilotLockPath()),
    supervisor_state: rt?.supervisor.state,
    worker_expected: workerExpected,
    worker_running: workerRunning,
    worker_pid: rt?.supervisor.workerPid,
    worker_restart_count: rt?.supervisor.restartCount,
    database_state: rt?.database.state,
    database_last_connected_at: rt?.database.lastConnectedAt,
    engine: rt?.engine,
    repo_path: rt?.repoPath ?? manifest?.repoPath,
    last_log: lastLine,
    last_error: rt?.supervisor.lastError ?? rt?.database.lastError,
    runtime_ready: runtimeReady,
    database_ready: databaseReady,
    worker_ready: workerReady,
    queue_ready: queueReady,
    business_ready: business.state,
    business_reasons: business.reasons,
    last_successful_cycle_at: business.last_successful_cycle_at,
    overall,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Autopilot: ${summary.overall}`);
    console.log(`  Target: ${schedulerTarget}`);
    console.log(`  Scheduler: ${schedulerRegistered ? 'registered' : 'not registered'}${schedulerRunning ? ', running' : ''}`);
    if (rt) {
      console.log(`  Autopilot PID: ${rt.pid} (active=${autopilotActive})`);
      console.log(`  Heartbeat: ${rt.heartbeatAt}${heartbeatStale ? ' (stale)' : ''}`);
      console.log(`  Supervisor: ${rt.supervisor.state}`);
      console.log(`  Worker: expected=${workerExpected}, running=${workerRunning}`);
      console.log(`  Database: ${rt.database.state}`);
    }
    console.log(`  Business: ${business.state}${business.reasons.length ? ` (${business.reasons.join(', ')})` : ''}`);
    if (lastLine) console.log(`Last log: ${lastLine}`);
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

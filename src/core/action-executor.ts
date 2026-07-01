/**
 * ActionExecutor — the execution backend layer.
 *
 * This layer knows how to spawn an external agent runtime (Codex CLI, browser,
 * email client, API, etc.) and return structured results. It does NOT understand
 * Action domain objects, policy gates, skill loading, or outcome writeback.
 *
 * Semantic conventions (defined here so every consumer shares them):
 *   mode:     user-involvement level       manual | agent_assisted | agent_executable
 *   runtime:  execution backend            codex | browser | email | vault | api
 *   agent:    harness behaviour strategy   default | meeting_brief_agent | email_reply_agent | ...
 *   skill:    reusable procedure doc       meeting-brief | email-reply | project-memory-update
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendInteractiveActionEvent, writeInteractiveJsonFile } from './action-interactive-observability.ts';

/* ── ToolScope ──────────────────────────────────────────── */

export interface ToolScope {
  /** length === 0 means no allowlist (all tools available), NOT deny-all */
  allowed: string[];
  /** length === 0 means no blocklist */
  blocked: string[];
}

/* ── Execution request / result ─────────────────────────── */

export interface ActionExecutionRequest {
  prompt: string;
  workDir?: string;
  toolScope: ToolScope;
  timeoutMs?: number;
  interactiveRun?: InteractiveActionRunEnvelope;
  /** Frozen at Admin /run launch; injected into request.json so detached Codex
   *  does not need to re-query VoltMind and hit the PGLite lock. */
  planRuntimeContext?: unknown;
}

export interface ActionExecutionResult {
  kind: string;
  exitCode: number;
  args?: string[];
  stdout: string;
  stderr: string;
  wallMs: number;
  actionRunId?: number;
  writebackStatus?: string;
  actionDir?: string;
  requestPath?: string;
  resultPath?: string;
  promptPath?: string;
  eventsPath?: string;
  launcherPath?: string;
  executionContextPath?: string;
}

export interface InteractiveActionRunEnvelope {
  runId: number;
  sourceId: string;
  slug: string;
  nonce: string;
  actionDir: string;
  requestPath: string;
  resultPath: string;
  promptPath: string;
  eventsPath: string;
  launcherPath: string;
  executionContextPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  transcriptPath: string;
  initiator?: 'admin-ui' | 'cli' | 'daemon' | 'mcp' | string;
}

/* ── Executor interface ──────────────────────────────────── */

export interface ActionExecutor {
  readonly kind: string;
  execute(req: ActionExecutionRequest): Promise<ActionExecutionResult>;
}

/* ── CodexExecutor ───────────────────────────────────────── */

const DEFAULT_CODEX_TIMEOUT_MS = 600_000; // 10 minutes

export class CodexExecutor implements ActionExecutor {
  readonly kind = 'codex';

  async execute(req: ActionExecutionRequest): Promise<ActionExecutionResult> {
    const workDir = await mkdtemp(join(tmpdir(), 'voltmind-action-run-'));
    try {
      const args = [
        ...buildCodexExecArgs(process.cwd(), process.env),
      ];
      const child = spawn('codex', args, {
        cwd: process.cwd(),
        env: process.env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.stdin.end(req.prompt, 'utf8');

      const timeoutMs = req.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
      const start = Date.now();
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('codex exec timed out while executing action'));
        }, timeoutMs);
        child.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
      });

      return {
        kind: 'codex_exec',
        exitCode,
        args,
        stdout,
        stderr,
        wallMs: Date.now() - start,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/* ── CodexInteractiveExecutor ────────────────────────────── */

/**
 * Spawns Codex in interactive TUI mode.
 *
 * CRITICAL RULES (empirically validated 2026-06-24):
 *
 * 1. MUST use independent real console (Path B: cmd /k, not detached /c).
 *    Codex Apps MCP hydration (connector read vs write tool surface) depends
 *    on launch context. A detached pseudo-console may only hydrate read tools.
 *
 * 2. MUST specify working directory (Path B: /D "cwd"; Path A: --cd cwd).
 *    Codex resolves workspace trust, sandbox policy, and config from cwd.
 *
 * 3. MUST NOT pass --sandbox, --enable apps, -c overrides, or approval_policy.
 *    Rely entirely on user's ~/.codex/config.toml. Extra args interfere with
 *    connector initialization and can cause write tool surface to go missing.
 *
 * 4. MUST do capability preflight (via ToolSearchBootstrap) before spawning.
 *    The orchestrator should confirm the required plugin/skill is available.
 *
 * 5. MUST fail closed. If the connector surface is incomplete (read-only),
 *    report the gap rather than silently succeeding with degraded capability.
 *
 * Two paths:
 *   Path A (TTY available):      spawn codex with stdio:'inherit' — TUI inline
 *   Path B (no TTY, sandbox/CI): cmd /c start "" /D "cwd" cmd /k codex "prompt"
 */
export class CodexInteractiveExecutor implements ActionExecutor {
  readonly kind = 'codex_interactive';

  async execute(req: ActionExecutionRequest): Promise<ActionExecutionResult> {
    const workDir = req.interactiveRun?.actionDir ?? await mkdtemp(join(process.cwd(), '.voltmind-codex-interactive-'));
    const promptPath = req.interactiveRun?.promptPath ?? join(workDir, 'action-prompt.md');
    const shouldCleanup = !req.interactiveRun;

  try {
      if (req.interactiveRun) {
        await writeInteractiveActionPromptFiles(req.prompt, req.interactiveRun, req.planRuntimeContext);
        await appendInteractiveActionEvent(req.interactiveRun.eventsPath, 'launcher_prepared', {
          run_id: req.interactiveRun.runId,
          source_id: req.interactiveRun.sourceId,
          slug: req.interactiveRun.slug,
          prompt_path: req.interactiveRun.promptPath,
          request_path: req.interactiveRun.requestPath,
          result_path: req.interactiveRun.resultPath,
        });
      } else {
        await mkdir(workDir, { recursive: true });
        await writeFile(promptPath, req.prompt, 'utf-8');
      }

      const args = buildCodexInteractiveArgs(process.cwd(), promptPath);
      const hasTTY = process.stdin.isTTY && process.stdout.isTTY;
      const shouldUseInlineTTY = hasTTY && !req.interactiveRun;
      const childEnv = buildCodexInteractiveEnv(process.env, req.interactiveRun);

      if (shouldUseInlineTTY) {
        // Path A: real terminal — inherit stdio, Codex TUI opens inline
        const launch = buildCodexInteractiveLaunch(args, childEnv);
        const start = Date.now();
        await appendInteractiveActionEvent(req.interactiveRun?.eventsPath, 'launcher_spawn_start', {
          run_id: req.interactiveRun?.runId,
          source_id: req.interactiveRun?.sourceId,
          slug: req.interactiveRun?.slug,
          mode: 'inline_tty',
          command: launch.command,
          args: launch.args,
          cwd: process.cwd(),
        });
        await writeInteractiveJsonFile(req.interactiveRun?.launcherPath, {
          version: 1,
          mode: 'inline_tty',
          command: launch.command,
          args: launch.args,
          cwd: process.cwd(),
          started_at: new Date().toISOString(),
        });
        const child = spawn(launch.command, launch.args, {
          cwd: process.cwd(),
          env: childEnv,
          shell: false,
          stdio: 'inherit',
          windowsHide: false,
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          child.on('error', (err: Error) => reject(err));
          child.on('close', (code: number | null) => resolve(code ?? 1));
        });
        await appendInteractiveActionEvent(req.interactiveRun?.eventsPath, 'launcher_process_closed', {
          run_id: req.interactiveRun?.runId,
          source_id: req.interactiveRun?.sourceId,
          slug: req.interactiveRun?.slug,
          mode: 'inline_tty',
          exit_code: exitCode,
          wall_ms: Date.now() - start,
        });

        return {
          kind: 'codex_interactive',
          exitCode,
          args: [launch.command, ...launch.args],
          stdout: '',
          stderr: '',
          wallMs: Date.now() - start,
          actionRunId: req.interactiveRun?.runId,
          writebackStatus: req.interactiveRun ? 'interactive_pending' : undefined,
          actionDir: req.interactiveRun?.actionDir,
          requestPath: req.interactiveRun?.requestPath,
          resultPath: req.interactiveRun?.resultPath,
          promptPath,
          eventsPath: req.interactiveRun?.eventsPath,
          launcherPath: req.interactiveRun?.launcherPath,
          executionContextPath: req.interactiveRun?.executionContextPath,
        };
      }

      // Path B: no TTY (sandbox, CI, pipe). On Windows, launch Codex
      // in a REAL interactive console via "cmd /k".
      //
      // CRITICAL: Codex Apps MCP hydration (connector read vs write tool
      // surface) depends on launch context. A detached "cmd /c start codex"
      // creates a pseudo-console that may only hydrate read tools.
      // A proper "cmd /k" with explicit cwd gives the connector a real
      // interactive channel, matching the user's manual test environment.
      //
      // Rules (empirically validated):
      // - Must use independent real console (cmd /k, not detached /c)
      // - Must specify cwd (/D flag)
      // - Must NOT pass exec/sandbox/approval_policy params (rely on user config)
      // - The prompt (last arg) must be double-quoted for cmd /c start
      if (process.platform === 'win32') {
        const codexBin = resolveCodexInteractiveCommand(childEnv);
        const promptText = args[args.length - 1] || '';
        const quotedPrompt = '"' + promptText + '"';
        // Build the inner command for "cmd /k".  If Codex is installed as a
        // .ps1 shim (npm global on Windows), wrap it through powershell so the
        // real console honours VOLTMIND_CODEX_BIN.
        let innerCmd: string;
        if (codexBin.toLowerCase().endsWith('.ps1')) {
          const psExe = (childEnv.ComSpec && childEnv.ComSpec.toLowerCase().endsWith('powershell.exe'))
            ? childEnv.ComSpec
            : 'powershell.exe';
          innerCmd = `${psExe} -NoProfile -ExecutionPolicy Bypass -File "${codexBin}" ${quotedPrompt}`;
        } else {
          innerCmd = `${codexBin} ${quotedPrompt}`;
        }

        const startArgs = [
          '/c', 'start', '""',
          '/D', '"' + process.cwd() + '"',
          'cmd', '/k',
          innerCmd,
        ];

        // Sandbox note: on Codex sandboxed Windows, CreateProcessW may be
        // blocked even with detached:true. The spawn itself is synchronous
        // in Bun and the sandbox may hang it. If the Admin API /run handler
        // is called from a non-escalated serve process, this spawn will time
        // out the HTTP response. The pending interactive run is already
        // persisted in action_runs by this point; the writeback result.json
        // can be dropped in the action directory without Codex.
        await appendInteractiveActionEvent(req.interactiveRun?.eventsPath, 'launcher_spawn_start', {
          run_id: req.interactiveRun?.runId,
          source_id: req.interactiveRun?.sourceId,
          slug: req.interactiveRun?.slug,
          mode: 'windows_detached_real_console',
          command: 'cmd',
          args: startArgs,
          codex_binary: codexBin,
          cwd: process.cwd(),
        });
        const startedAt = new Date().toISOString();
        const child = spawn('cmd', startArgs, {
          cwd: process.cwd(),
          env: childEnv,
          shell: false,
          stdio: 'ignore',
          detached: true,
          windowsHide: false,
        });
        await writeInteractiveJsonFile(req.interactiveRun?.launcherPath, {
          version: 1,
          mode: 'windows_detached_real_console',
          command: 'cmd',
          args: startArgs,
          codex_binary: codexBin,
          cwd: process.cwd(),
          pid: child.pid ?? null,
          pid_note: 'pid of cmd /c start staging process; the real Codex runtime lives in a new console window and will be detected by a post-spawn scan.',
          started_at: startedAt,
          capture: {
            stdout_log_path: req.interactiveRun?.stdoutLogPath,
            stderr_log_path: req.interactiveRun?.stderrLogPath,
            transcript_path: req.interactiveRun?.transcriptPath,
            status: 'capture_unavailable_real_console',
            reason: 'Codex TUI must run in an independent cmd /k console so connector write tools hydrate correctly.',
          },
        });
        // The pid here is the short-lived "cmd /c start" wrapper — NOT the
        // real Codex runtime.  A fire-and-forget post-spawn scan runs next
        // and will emit runtime_process_detected / runtime_process_missing.
        await appendInteractiveActionEvent(req.interactiveRun?.eventsPath, 'launcher_staging_spawned', {
          run_id: req.interactiveRun?.runId,
          source_id: req.interactiveRun?.sourceId,
          slug: req.interactiveRun?.slug,
          mode: 'windows_detached_real_console',
          pid: child.pid ?? null,
          pid_note: 'cmd /c start staging pid — not the Codex runtime',
        });
        await appendInteractiveActionEvent(req.interactiveRun?.eventsPath, 'capture_unavailable_real_console', {
          run_id: req.interactiveRun?.runId,
          source_id: req.interactiveRun?.sourceId,
          slug: req.interactiveRun?.slug,
          stdout_log_path: req.interactiveRun?.stdoutLogPath,
          stderr_log_path: req.interactiveRun?.stderrLogPath,
          transcript_path: req.interactiveRun?.transcriptPath,
        });

        // ── Post-spawn runtime scan (background, fire-and-forget) ──
        const eventsPath = req.interactiveRun?.eventsPath;
        const runId = req.interactiveRun?.runId;
        if (eventsPath && runId != null) {
          const scan = scanForCodexRuntimeProcess(promptPath, eventsPath, runId);
          scan.catch(() => {
            // Best-effort; failure must not crash the launcher.
          });
        }

        return {
          kind: 'codex_interactive_detached',
          exitCode: 0,
          args: [codexBin, quotedPrompt],
          stdout: 'Codex launched in a real interactive cmd console (cmd /k).',
          stderr: '',
          wallMs: 0,
          actionRunId: req.interactiveRun?.runId,
          writebackStatus: req.interactiveRun ? 'interactive_pending' : undefined,
          actionDir: req.interactiveRun?.actionDir,
          requestPath: req.interactiveRun?.requestPath,
          resultPath: req.interactiveRun?.resultPath,
          promptPath,
          eventsPath: req.interactiveRun?.eventsPath,
          launcherPath: req.interactiveRun?.launcherPath,
          executionContextPath: req.interactiveRun?.executionContextPath,
        };
      }

      // Unix without TTY: prompt file available for manual run
      return {
        kind: 'codex_interactive_no_tty',
        exitCode: 1,
        args: args,
        stdout: '',
        stderr: 'No TTY available. Prompt saved to: ' + promptPath + '\nRun: codex --cd "' + process.cwd() + '" --sandbox workspace-write "' + promptPath + '"',
        wallMs: 0,
        actionRunId: req.interactiveRun?.runId,
        writebackStatus: req.interactiveRun ? 'interactive_pending' : undefined,
        actionDir: req.interactiveRun?.actionDir,
        requestPath: req.interactiveRun?.requestPath,
        resultPath: req.interactiveRun?.resultPath,
        promptPath,
        eventsPath: req.interactiveRun?.eventsPath,
        launcherPath: req.interactiveRun?.launcherPath,
        executionContextPath: req.interactiveRun?.executionContextPath,
      };
    } catch (err) {
      await appendInteractiveActionEvent(req.interactiveRun?.eventsPath, 'launcher_spawn_failed', {
        run_id: req.interactiveRun?.runId,
        source_id: req.interactiveRun?.sourceId,
        slug: req.interactiveRun?.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      await writeInteractiveJsonFile(req.interactiveRun?.launcherPath, {
        version: 1,
        mode: process.platform === 'win32' ? 'windows_detached_real_console' : 'unknown',
        cwd: process.cwd(),
        failed_at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        kind: 'codex_interactive_error',
        exitCode: 1,
        args: [],
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        wallMs: 0,
        actionRunId: req.interactiveRun?.runId,
        writebackStatus: req.interactiveRun ? 'interactive_pending' : undefined,
        actionDir: req.interactiveRun?.actionDir,
        requestPath: req.interactiveRun?.requestPath,
        resultPath: req.interactiveRun?.resultPath,
        promptPath,
        eventsPath: req.interactiveRun?.eventsPath,
        launcherPath: req.interactiveRun?.launcherPath,
        executionContextPath: req.interactiveRun?.executionContextPath,
      };
    } finally {
      if (shouldCleanup) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

/* ── CraftHeadlessExecutor ───────────────────────────────── */

const DEFAULT_CRAFT_TIMEOUT_MS = 600_000; // 10 minutes

export type CraftHeadlessWritebackStatus = 'done' | 'blocked' | 'failed';

export interface CraftHeadlessEvent {
  type?: string;
  event?: string;
  [key: string]: unknown;
}

export interface CraftHeadlessWriteback {
  status: CraftHeadlessWritebackStatus;
  summary: string;
  artifactRefs: string[];
  errors: string[];
}

export interface CraftHeadlessExecutorOptions {
  command?: string;
  baseArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configDir?: string;
}

export class CraftHeadlessExecutor implements ActionExecutor {
  readonly kind = 'craft_headless';

  constructor(private readonly options: CraftHeadlessExecutorOptions = {}) {}

  async execute(req: ActionExecutionRequest): Promise<ActionExecutionResult> {
    if (!req.interactiveRun) {
      throw new Error('craft_headless requires an interactive writeback envelope');
    }

    const envelope = req.interactiveRun;
    const cwd = this.options.cwd ?? process.cwd();
    const baseEnv = { ...process.env, ...(this.options.env ?? {}) };
    const configDir = this.options.configDir ?? join(envelope.actionDir, '.craft-config');
    const childEnv = {
      ...buildCodexInteractiveEnv(baseEnv, envelope),
      CRAFT_CONFIG_DIR: configDir,
      VOLTMIND_ACTION_RUNTIME: 'craft_headless',
    };
    const launch = this.options.command
      ? { command: this.options.command, baseArgs: this.options.baseArgs ?? [] }
      : resolveCraftHeadlessLaunch(childEnv);
    const runArgs = buildCraftHeadlessArgs(envelope.actionDir, childEnv);
    const args = [...launch.baseArgs, ...runArgs];
    const start = Date.now();

    await writeInteractiveActionPromptFiles(req.prompt, envelope, req.planRuntimeContext);
    await writeFile(envelope.promptPath, renderCraftHeadlessPrompt(req.prompt, envelope), 'utf-8');
    await mkdir(configDir, { recursive: true });
    await appendInteractiveActionEvent(envelope.eventsPath, 'craft_started', {
      run_id: envelope.runId,
      source_id: envelope.sourceId,
      slug: envelope.slug,
      command: launch.command,
      args,
      cwd,
      craft_config_dir: configDir,
      workspace_dir: envelope.actionDir,
    });
    await writeInteractiveJsonFile(envelope.launcherPath, {
      version: 1,
      mode: 'craft_headless',
      command: launch.command,
      args,
      cwd,
      craft_config_dir: configDir,
      workspace_dir: envelope.actionDir,
      started_at: new Date().toISOString(),
      capture: {
        stdout_log_path: envelope.stdoutLogPath,
        stderr_log_path: envelope.stderrLogPath,
        transcript_path: envelope.transcriptPath,
        events_path: envelope.eventsPath,
      },
    });

    const events: CraftHeadlessEvent[] = [];
    const pendingWrites: Array<Promise<unknown>> = [];
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let timedOut = false;

    const appendLog = (path: string, text: string) => {
      pendingWrites.push(appendFile(path, text, 'utf-8').catch(() => {}));
    };
    const observeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const event = parseCraftStreamEvent(trimmed);
      if (!event) {
        appendLog(envelope.transcriptPath, `[stdout] ${trimmed}\n`);
        return;
      }
      events.push(event);
      const type = craftEventType(event);
      pendingWrites.push(appendInteractiveActionEvent(envelope.eventsPath, 'craft_event_seen', {
        run_id: envelope.runId,
        source_id: envelope.sourceId,
        slug: envelope.slug,
        craft_event_type: type,
        session_id: stringField(event, 'sessionId') ?? stringField(event, 'session_id') ?? null,
      }).catch(() => {}));
      const transcriptLine = craftTranscriptLine(event);
      if (transcriptLine) appendLog(envelope.transcriptPath, transcriptLine);
    };
    const observeStdout = (chunk: string) => {
      stdout += chunk;
      appendLog(envelope.stdoutLogPath, chunk);
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        observeLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
      }
    };

    try {
      const child = spawn(launch.command, args, {
        cwd,
        env: childEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => observeStdout(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        appendLog(envelope.stderrLogPath, chunk);
      });
      child.stdin.end(renderCraftHeadlessPrompt(req.prompt, envelope), 'utf8');

      const timeoutMs = req.timeoutMs ?? DEFAULT_CRAFT_TIMEOUT_MS;
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
          pendingWrites.push(appendInteractiveActionEvent(envelope.eventsPath, 'craft_timeout', {
            run_id: envelope.runId,
            source_id: envelope.sourceId,
            slug: envelope.slug,
            timeout_ms: timeoutMs,
          }).catch(() => {}));
        }, timeoutMs);
        child.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
      });

      if (stdoutBuffer.trim()) observeLine(stdoutBuffer);
      stdoutBuffer = '';
      await Promise.allSettled(pendingWrites);
      const writeback = summarizeCraftHeadlessEvents(events, {
        exitCode,
        timedOut,
        stderr,
      });
      await writeCraftHeadlessResult(envelope, writeback);
      await appendInteractiveActionEvent(envelope.eventsPath, writeback.status === 'done' ? 'craft_complete' : 'craft_error', {
        run_id: envelope.runId,
        source_id: envelope.sourceId,
        slug: envelope.slug,
        status: writeback.status,
        exit_code: exitCode,
        wall_ms: Date.now() - start,
        errors: writeback.errors,
      });

      return {
        kind: 'craft_headless',
        exitCode,
        args: [launch.command, ...args],
        stdout,
        stderr,
        wallMs: Date.now() - start,
        actionRunId: envelope.runId,
        writebackStatus: 'result_written',
        actionDir: envelope.actionDir,
        requestPath: envelope.requestPath,
        resultPath: envelope.resultPath,
        promptPath: envelope.promptPath,
        eventsPath: envelope.eventsPath,
        launcherPath: envelope.launcherPath,
        executionContextPath: envelope.executionContextPath,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stderr = stderr ? `${stderr}\n${message}` : message;
      await Promise.allSettled(pendingWrites);
      const writeback: CraftHeadlessWriteback = {
        status: 'failed',
        summary: `Craft headless runner failed before completion: ${message}`.slice(0, 500),
        artifactRefs: [],
        errors: [message],
      };
      await writeCraftHeadlessResult(envelope, writeback);
      await appendInteractiveActionEvent(envelope.eventsPath, 'craft_error', {
        run_id: envelope.runId,
        source_id: envelope.sourceId,
        slug: envelope.slug,
        error: message,
        wall_ms: Date.now() - start,
      });
      return {
        kind: 'craft_headless',
        exitCode: 1,
        args: [launch.command, ...args],
        stdout,
        stderr,
        wallMs: Date.now() - start,
        actionRunId: envelope.runId,
        writebackStatus: 'result_written',
        actionDir: envelope.actionDir,
        requestPath: envelope.requestPath,
        resultPath: envelope.resultPath,
        promptPath: envelope.promptPath,
        eventsPath: envelope.eventsPath,
        launcherPath: envelope.launcherPath,
        executionContextPath: envelope.executionContextPath,
      };
    }
  }
}

export function resolveCraftHeadlessLaunch(env: NodeJS.ProcessEnv = process.env): { command: string; baseArgs: string[] } {
  if (env.VOLTMIND_CRAFT_CLI) {
    return { command: env.VOLTMIND_CRAFT_CLI, baseArgs: [] };
  }
  const bun = env.VOLTMIND_CRAFT_BUN_BIN || 'bun';
  if (env.VOLTMIND_CRAFT_CLI_ENTRY) {
    return { command: bun, baseArgs: ['run', env.VOLTMIND_CRAFT_CLI_ENTRY] };
  }
  if (env.VOLTMIND_CRAFT_REPO) {
    return { command: bun, baseArgs: ['run', join(env.VOLTMIND_CRAFT_REPO, 'apps', 'cli', 'src', 'index.ts')] };
  }
  return { command: 'craft-cli', baseArgs: [] };
}

export function buildCraftHeadlessArgs(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    'run',
    '--workspace-dir', workspaceDir,
    '--output-format', 'stream-json',
    '--no-cleanup',
  ];
  for (const source of craftSourcesFromEnv(env)) {
    args.push('--source', source);
  }
  return args;
}

export function parseCraftStreamEvent(line: string): CraftHeadlessEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as CraftHeadlessEvent;
  } catch {
    return null;
  }
}

export function summarizeCraftHeadlessEvents(
  events: CraftHeadlessEvent[],
  opts: { exitCode?: number; timedOut?: boolean; stderr?: string } = {},
): CraftHeadlessWriteback {
  const markers = {
    status: undefined as CraftHeadlessWritebackStatus | undefined,
    summary: '',
    artifactRefs: [] as string[],
    errors: [] as string[],
  };
  const textChunks: string[] = [];
  const artifactRefs: string[] = [];
  const errors: string[] = [];
  let completeSeen = false;
  let errorSeen = false;
  let interruptedSeen = false;

  for (const event of events) {
    const type = craftEventType(event);
    if (type === 'complete' || type === 'completed') completeSeen = true;
    if (type === 'error' || type === 'failed') errorSeen = true;
    if (type === 'interrupted' || type === 'interrupt') interruptedSeen = true;
    const text = craftTextFromEvent(event);
    if (text) {
      textChunks.push(text);
      mergeMarkers(markers, parseCraftResultMarkers(text));
    }
    artifactRefs.push(...artifactRefsFromUnknown(event.artifact_refs));
    artifactRefs.push(...artifactRefsFromUnknown(event.artifactRefs));
    artifactRefs.push(...artifactRefsFromUnknown(event.artifacts));
    const eventError = errorTextFromUnknown(event.error ?? event.message);
    if ((type === 'error' || type === 'failed') && eventError) errors.push(eventError);
  }

  const stderr = (opts.stderr ?? '').trim();
  if (stderr) errors.push(stderr.slice(0, 1000));

  let status: CraftHeadlessWritebackStatus;
  if (markers.status) {
    status = markers.status;
  } else if (opts.timedOut || errorSeen || (opts.exitCode != null && opts.exitCode !== 0)) {
    status = 'failed';
  } else if (interruptedSeen) {
    status = 'blocked';
  } else if (completeSeen) {
    status = 'done';
  } else {
    status = 'failed';
  }

  const summary = firstNonEmpty(
    markers.summary,
    lastNonEmpty(textChunks)?.slice(0, 500),
    status === 'done'
      ? 'Craft headless run completed.'
      : status === 'blocked'
        ? 'Craft headless run was interrupted or blocked.'
        : 'Craft headless run failed before producing a completion event.',
  ).slice(0, 500);

  const mergedArtifacts = uniqueStrings([
    ...markers.artifactRefs,
    ...artifactRefs,
  ]);
  const mergedErrors = uniqueStrings([
    ...markers.errors,
    ...errors,
  ]).filter(Boolean);
  if (status !== 'done' && mergedErrors.length === 0) {
    mergedErrors.push(opts.timedOut ? 'craft_headless_timeout' : `craft_headless_${status}`);
  }

  return {
    status,
    summary,
    artifactRefs: mergedArtifacts,
    errors: status === 'done' ? [] : mergedErrors,
  };
}

export async function writeCraftHeadlessResult(
  envelope: InteractiveActionRunEnvelope,
  writeback: CraftHeadlessWriteback,
): Promise<void> {
  const result = {
    action_run_id: envelope.runId,
    source_id: envelope.sourceId,
    slug: envelope.slug,
    nonce: envelope.nonce,
    status: writeback.status,
    summary: writeback.summary,
    artifact_refs: writeback.artifactRefs,
    errors: writeback.status === 'done' ? [] : writeback.errors,
  };
  const tmpPath = `${envelope.resultPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, envelope.resultPath);
}

export function renderCraftHeadlessPrompt(
  prompt: string,
  envelope: InteractiveActionRunEnvelope,
): string {
  return [
    prompt.trimEnd(),
    '',
    '## VoltMind Craft Headless Runtime Contract',
    '',
    'Craft is running as the headless agent runner. VoltMind is the writeback harness.',
    'Do not write result.json directly. VoltMind will consume Craft stream-json events and atomically write result.json after the run.',
    '',
    'Read request.json when you need launch metadata, especially plan_context_snapshot:',
    envelope.requestPath,
    '',
    'Prefer plan_context_snapshot over a fresh VoltMind query. Only query again if the snapshot is missing or insufficient.',
    '',
    'Create any reviewable drafts or files in the action workspace. Keep connector actions draft-only unless the prompt explicitly says a confirmed send/write is allowed.',
    '',
    'When you finish, include these short machine-readable lines in the final response so the adapter can summarize accurately:',
    '',
    'VOLTMIND_RESULT_STATUS: done | blocked | failed',
    'VOLTMIND_RESULT_SUMMARY: one concise sentence',
    'VOLTMIND_ARTIFACT_REF: optional artifact path, slug, URL, or connector draft id',
    'VOLTMIND_ERROR: optional short error or blocking reason',
    '',
    'Status rules:',
    '- Use done only when the requested draft/artifact was created and is safe for review.',
    '- Use blocked when user input, missing credentials, or external approval is required.',
    '- Use failed when execution hit an unrecoverable runtime or tool error.',
    '',
  ].join('\n');
}

function craftSourcesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.VOLTMIND_CRAFT_SOURCE_SLUGS ?? env.VOLTMIND_CRAFT_SOURCES ?? '';
  return uniqueStrings(raw.split(',')
    .map(part => part.trim())
    .filter(part => /^[A-Za-z0-9._-]+$/.test(part)));
}

function craftEventType(event: CraftHeadlessEvent): string {
  return stringField(event, 'type') ?? stringField(event, 'event') ?? 'unknown';
}

function stringField(event: CraftHeadlessEvent, field: string): string | undefined {
  const value = event[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function craftTranscriptLine(event: CraftHeadlessEvent): string {
  const type = craftEventType(event);
  const text = craftTextFromEvent(event);
  if (text) return `[${type}] ${text}\n`;
  const toolName = stringField(event, 'toolName') ?? stringField(event, 'tool_name') ?? stringField(event, 'name');
  if (toolName) return `[${type}] ${toolName}\n`;
  return `[${type}]\n`;
}

function craftTextFromEvent(event: CraftHeadlessEvent): string {
  const direct = stringField(event, 'delta')
    ?? stringField(event, 'text')
    ?? stringField(event, 'content')
    ?? stringField(event, 'message');
  if (direct) return direct;
  const result = event.result;
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const nested = result as Record<string, unknown>;
    for (const key of ['text', 'content', 'summary', 'message']) {
      const value = nested[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return '';
}

function parseCraftResultMarkers(text: string): {
  status?: CraftHeadlessWritebackStatus;
  summary?: string;
  artifactRefs: string[];
  errors: string[];
} {
  const markers: {
    status?: CraftHeadlessWritebackStatus;
    summary?: string;
    artifactRefs: string[];
    errors: string[];
  } = { artifactRefs: [], errors: [] };
  for (const line of text.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toUpperCase();
    const value = rest.join(':').trim();
    if (!value) continue;
    if (key === 'VOLTMIND_RESULT_STATUS') {
      const status = value.toLowerCase();
      if (status === 'done' || status === 'blocked' || status === 'failed') markers.status = status;
    } else if (key === 'VOLTMIND_RESULT_SUMMARY') {
      markers.summary = value;
    } else if (key === 'VOLTMIND_ARTIFACT_REF') {
      markers.artifactRefs.push(value);
    } else if (key === 'VOLTMIND_ERROR') {
      markers.errors.push(value);
    }
  }
  return markers;
}

function mergeMarkers(
  target: {
    status?: CraftHeadlessWritebackStatus;
    summary: string;
    artifactRefs: string[];
    errors: string[];
  },
  incoming: {
    status?: CraftHeadlessWritebackStatus;
    summary?: string;
    artifactRefs: string[];
    errors: string[];
  },
): void {
  if (incoming.status) target.status = incoming.status;
  if (incoming.summary) target.summary = incoming.summary;
  target.artifactRefs.push(...incoming.artifactRefs);
  target.errors.push(...incoming.errors);
}

function artifactRefsFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => artifactRefsFromUnknown(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['ref', 'path', 'slug', 'url', 'id']) {
      const item = record[key];
      if (typeof item === 'string' && item.trim()) return [item];
    }
  }
  return [];
}

function errorTextFromUnknown(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason']) {
      const item = record[key];
      if (typeof item === 'string' && item.trim()) return item;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return '';
}

function lastNonEmpty(values: string[]): string | undefined {
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index]?.trim();
    if (value) return value;
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export async function writeInteractiveActionPromptFiles(
  prompt: string,
  envelope: InteractiveActionRunEnvelope,
  planRuntimeContext?: unknown,
): Promise<void> {
  await mkdir(envelope.actionDir, { recursive: true });
  const request = {
    version: 1,
    protocol: 'voltmind-admin-action-writeback',
    action_run_id: envelope.runId,
    source_id: envelope.sourceId,
    slug: envelope.slug,
    nonce: envelope.nonce,
    initiator: envelope.initiator ?? 'unknown',
    prompt_path: envelope.promptPath,
    request_path: envelope.requestPath,
    result_path: envelope.resultPath,
    events_path: envelope.eventsPath,
    launcher_path: envelope.launcherPath,
    execution_context_path: envelope.executionContextPath,
    stdout_log_path: envelope.stdoutLogPath,
    stderr_log_path: envelope.stderrLogPath,
    transcript_path: envelope.transcriptPath,
    plan_context_snapshot: planRuntimeContext ?? null,
    status_values: ['done', 'blocked', 'failed'],
    result_schema: {
      action_run_id: 'number',
      source_id: 'string',
      slug: 'string',
      nonce: 'string',
      status: 'done | blocked | failed',
      summary: 'string',
      artifact_refs: 'string[]',
      errors: 'string[]',
      plan_done: 'optional object',
    },
  };
  await writeFile(envelope.requestPath, JSON.stringify(request, null, 2) + '\n', 'utf-8');
  await writeFile(envelope.promptPath, renderInteractiveWritebackPrompt(prompt, envelope), 'utf-8');
  for (const logPath of [envelope.stdoutLogPath, envelope.stderrLogPath, envelope.transcriptPath]) {
    if (!existsSync(logPath)) await writeFile(logPath, '', 'utf-8');
  }
}

export function renderInteractiveWritebackPrompt(
  prompt: string,
  envelope: InteractiveActionRunEnvelope,
): string {
  const example = {
    action_run_id: envelope.runId,
    source_id: envelope.sourceId,
    slug: envelope.slug,
    nonce: envelope.nonce,
    status: 'done',
    summary: 'One concise summary of the completed action.',
    artifact_refs: [] as string[],
    errors: [] as string[],
  };
  return [
    prompt.trimEnd(),
    '',
    '## VoltMind Interactive Writeback',
    '',
    'This action was started by VoltMind Admin. Before ending the Codex interactive session, write the final result as UTF-8 JSON to:',
    '',
    envelope.resultPath,
    '',
    'The JSON must match this shape exactly:',
    '',
    '```json',
    JSON.stringify(example, null, 2),
    '```',
    '',
    'Rules:',
    '- Keep action_run_id, source_id, slug, and nonce exactly as shown.',
    '- Use status "done" only when the action is complete and safe to archive.',
    '- Use status "blocked" when user input or an external approval is needed.',
    '- Use status "failed" when execution ended with an error.',
    '- Include artifact_refs as file paths, slugs, URLs, or connector object IDs created during the run.',
    '- Include errors as an empty array for done, and a non-empty array for blocked or failed.',
    '- You may include optional plan_done metadata if you updated a persisted plan.',
    '',
    '## Runtime Context And Observability',
    '',
    'VoltMind already ran Admin /plan context lookup before this run. The request.json file contains the plan_context_snapshot captured at launch.',
    'Prefer the plan_context_snapshot over running a fresh VoltMind query. Only query VoltMind again if the snapshot is missing or insufficient.',
    '',
    `Request file: ${envelope.requestPath}`,
    `Events JSONL: ${envelope.eventsPath}`,
    `Execution context JSON: ${envelope.executionContextPath}`,
    `Best-effort stdout log: ${envelope.stdoutLogPath}`,
    `Best-effort stderr log: ${envelope.stderrLogPath}`,
    `Best-effort transcript log: ${envelope.transcriptPath}`,
    '',
    'Append one UTF-8 JSON object per line to events.jsonl as the run progresses. Use these event names where applicable:',
    '- started',
    '- context_loaded',
    '- tool_route_observed',
    '- draft_created',
    '- writeback_written',
    '- blocked',
    '- failed',
    '',
    'Before writing result.json, write execution-context.json with this shape:',
    '',
    '```json',
    JSON.stringify({
      plan_context_used: true,
      runtime_query_attempted: false,
      runtime_query_result: 'not_attempted',
      fallback_files_read: [],
      artifact_refs: [],
    }, null, 2),
    '```',
    '',
    'VoltMind will validate this file and write the outcome back to the action database.',
    '',
  ].join('\n');
}

function buildCodexInteractiveEnv(
  env: NodeJS.ProcessEnv,
  envelope?: InteractiveActionRunEnvelope,
): NodeJS.ProcessEnv {
  if (!envelope) return env;
  return {
    ...env,
    VOLTMIND_ADMIN_ACTION_RUN_ID: String(envelope.runId),
    VOLTMIND_ADMIN_ACTION_DIR: envelope.actionDir,
    VOLTMIND_ADMIN_ACTION_REQUEST: envelope.requestPath,
    VOLTMIND_ADMIN_ACTION_RESULT: envelope.resultPath,
    VOLTMIND_ADMIN_ACTION_EVENTS: envelope.eventsPath,
    VOLTMIND_ADMIN_ACTION_LAUNCHER: envelope.launcherPath,
    VOLTMIND_ADMIN_ACTION_EXECUTION_CONTEXT: envelope.executionContextPath,
    VOLTMIND_ADMIN_ACTION_STDOUT_LOG: envelope.stdoutLogPath,
    VOLTMIND_ADMIN_ACTION_STDERR_LOG: envelope.stderrLogPath,
    VOLTMIND_ADMIN_ACTION_TRANSCRIPT: envelope.transcriptPath,
    VOLTMIND_ADMIN_ACTION_SOURCE_ID: envelope.sourceId,
    VOLTMIND_ADMIN_ACTION_SLUG: envelope.slug,
  };
}

/* ── Executor factory ────────────────────────────────────── */

/**
 * Resolve an ActionExecutor from the action's `runtime` field.
 * Phase 1 implements `codex` (or null/undefined → codex), `codex_interactive`,
 * and `craft_headless`.
 * Other runtimes throw; the caller (ActionRunner) catches and returns blocked.
 */
export function resolveExecutor(runtime: string | null | undefined): ActionExecutor {
  if (!runtime || runtime === 'codex') return new CodexExecutor();
  if (runtime === 'codex_interactive') return new CodexInteractiveExecutor();
  if (runtime === 'craft_headless') return new CraftHeadlessExecutor();
  throw new Error(`Runtime "${runtime}" is not implemented in Phase 1`);
}

export function buildCodexExecArgs(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    'exec',
    '--enable', 'apps',
    '--json',
    ...codexConfigArgs(env),
    '--cd', cwd,
    '--sandbox', 'read-only',
    '-',
  ];
}

export function buildCodexInteractiveArgs(
  cwd: string = process.cwd(),
  promptPath: string,
): string[] {
  // The interactive executor deliberately does not pin --sandbox or --enable
  // here. Codex's own config ( ~/.codex/config.toml or env) controls sandbox
  // level and app enablement for the TUI session. Pinning them inline
  // conflicted with connector hydration (apps._default.* config overrides)
  // and prevented Codex from loading its own plugin/app runtime config.
  // The non-interactive path (buildCodexExecArgs) still uses explicit flags.
  return [
    '--cd', cwd,
    `Read and execute the VoltMind action prompt from this file: ${promptPath}`,
  ];
}

export function resolveCodexInteractiveCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VOLTMIND_CODEX_BIN) return env.VOLTMIND_CODEX_BIN;
  return process.platform === 'win32' ? resolveWindowsCodexScript(env) : 'codex';
}

/** Post-spawn scan: wait a few seconds then search for the real Codex runtime
 *  process whose command line references the action prompt file.  Writes
 *  runtime_process_detected or runtime_process_missing to events.jsonl. */
export async function scanForCodexRuntimeProcess(
  promptPath: string,
  eventsPath: string,
  runId: number,
): Promise<void> {
  const initialDelayMs = positiveIntegerFromEnv('VOLTMIND_ACTION_RUNTIME_SCAN_DELAY_MS', 5000);
  const attempts = positiveIntegerFromEnv('VOLTMIND_ACTION_RUNTIME_SCAN_ATTEMPTS', 3);
  const retryMs = positiveIntegerFromEnv('VOLTMIND_ACTION_RUNTIME_SCAN_RETRY_MS', 3000);
  await new Promise(resolve => setTimeout(resolve, initialDelayMs));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const escaped = promptPath.replace(/\\/g, '\\\\');
      const psScript = [
        `$found = Get-CimInstance Win32_Process | Where-Object {`,
        `  $_.CommandLine -like '*${escaped}*' -and (`,
        `    $_.Name -like 'node.exe' -or`,
        `    $_.Name -like 'codex.exe' -or`,
        `    $_.Name -like 'codex.cmd'`,
        `  )`,
        `} | Select-Object -First 1 ProcessId, Name, CommandLine`,
        `if ($found) {`,
        `  ConvertTo-Json @{ pid = $found.ProcessId; name = $found.Name; cmd = $found.CommandLine }`,
        `} else {`,
        `  'null'`,
        `}`,
      ].join(' ');
      const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', psScript], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      const trimmed = stdout.trim();
      if (trimmed && trimmed !== 'null') {
        const info = JSON.parse(trimmed) as { pid: number; name: string; cmd: string };
        await appendInteractiveActionEvent(eventsPath, 'runtime_process_detected', {
          run_id: runId,
          pid: info.pid,
          process_name: info.name,
          command_line: info.cmd?.slice(0, 500) ?? null,
        });
        return;
      }
    } catch {
      // Retry after a short wait.
    }
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, retryMs));
  }
  await appendInteractiveActionEvent(eventsPath, 'runtime_process_missing', {
    run_id: runId,
    prompt_path: promptPath,
  });
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function buildCodexInteractiveLaunch(
  codexArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const command = resolveCodexInteractiveCommand(env);
  if (process.platform === 'win32' && command.toLowerCase().endsWith('.ps1')) {
    return {
      command: env.ComSpec && env.ComSpec.toLowerCase().endsWith('powershell.exe')
        ? env.ComSpec
        : 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...codexArgs],
    };
  }
  return { command, args: codexArgs };
}

function resolveWindowsCodexScript(env: NodeJS.ProcessEnv): string {
  const appData = env.APPDATA;
  if (appData) {
    const ps1 = join(appData, 'npm', 'codex.ps1');
    if (existsSync(ps1)) return ps1;
  }
  return 'codex.cmd';
}

export function codexConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];

  args.push('-c', 'approval_policy="never"');
  args.push('-c', 'apps._default.enabled=true');
  args.push('-c', 'apps._default.destructive_enabled=false');
  args.push('-c', 'apps._default.open_world_enabled=false');

  const outlookEmailAppId = (env.VOLTMIND_CODEX_OUTLOOK_EMAIL_APP_ID ?? 'microsoft_outlook_email').trim();
  if (outlookEmailAppId) {
    args.push('-c', `apps.${outlookEmailAppId}.enabled=true`);
    args.push('-c', `apps.${outlookEmailAppId}.default_tools_enabled=true`);
    args.push('-c', `apps.${outlookEmailAppId}.default_tools_approval_mode="approve"`);

    const sendToolId = env.VOLTMIND_CODEX_OUTLOOK_EMAIL_SEND_TOOL_ID?.trim();
    if (sendToolId) {
      args.push('-c', `apps.${outlookEmailAppId}.tools.${sendToolId}.approval_mode="approve"`);
    }

    const draftToolId = env.VOLTMIND_CODEX_OUTLOOK_EMAIL_DRAFT_TOOL_ID?.trim();
    if (draftToolId) {
      args.push('-c', `apps.${outlookEmailAppId}.tools.${draftToolId}.approval_mode="approve"`);
    }
  }

  const serviceTier = env.VOLTMIND_CODEX_SERVICE_TIER?.trim();
  if (serviceTier) {
    args.push('-c', `service_tier=${JSON.stringify(serviceTier)}`);
  }
  const model = env.VOLTMIND_CODEX_MODEL?.trim();
  if (model) {
    args.push('-m', model);
  }

  if (args.includes('--ask-for-approval')) {
    throw new Error('CodexExecutor must not mix --ask-for-approval with approval_policy config override');
  }
  if (args.includes('apps._default.default_tools_approval_mode="approve"')) {
    throw new Error('CodexExecutor must use app-specific approval mode, not apps._default.default_tools_approval_mode');
  }

  return args;
}


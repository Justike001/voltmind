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
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

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
}

export interface ActionExecutionResult {
  kind: string;
  exitCode: number;
  args?: string[];
  stdout: string;
  stderr: string;
  wallMs: number;
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
    const workDir = await mkdtemp(join(process.cwd(), '.voltmind-codex-interactive-'));
    const promptPath = join(workDir, 'action-prompt.md');
    await writeFile(promptPath, req.prompt, 'utf-8');

    try {
      const args = buildCodexInteractiveArgs(process.cwd(), promptPath, process.env);
      const hasTTY = process.stdin.isTTY && process.stdout.isTTY;

      if (hasTTY) {
        // Path A: real terminal — inherit stdio, Codex TUI opens inline
        const launch = buildCodexInteractiveLaunch(args, process.env);
        const start = Date.now();
        const child = spawn(launch.command, launch.args, {
          cwd: process.cwd(),
          env: process.env,
          shell: false,
          stdio: 'inherit',
          windowsHide: false,
        });

        const exitCode = await new Promise<number>((resolve, reject) => {
          child.on('error', (err: Error) => reject(err));
          child.on('close', (code: number | null) => resolve(code ?? 1));
        });

        return {
          kind: 'codex_interactive',
          exitCode,
          args: [launch.command, ...launch.args],
          stdout: '',
          stderr: '',
          wallMs: Date.now() - start,
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
        // Get the prompt text (last arg) and quote it for cmd
        const promptText = args[args.length - 1] || '';
        const quotedPrompt = '"' + promptText + '"';

        // cmd /c start "" /D "cwd" cmd /k codex "prompt"
        // start ""  → empty window title, avoids argument misalignment
        // /D "cwd"  → explicit working directory (codex uses this as --cd implicitly)
        // cmd /k    → keep window open after codex exits (real interactive console)
        // NO extra args: no --enable apps, no --sandbox, no -c overrides.
        // Rely entirely on user's ~/.codex/config.toml for connector/sandbox config.
        const startArgs = [
          '/c', 'start', '""',
          '/D', '"' + process.cwd() + '"',
          'cmd', '/k',
          'codex',
          quotedPrompt,
        ];

        spawn('cmd', startArgs, {
          cwd: process.cwd(),
          shell: true,
          stdio: 'ignore',
          detached: true,
          windowsHide: false,
        }).unref();

        return {
          kind: 'codex_interactive_detached',
          exitCode: 0,
          args: ['codex', quotedPrompt],
          stdout: 'Codex launched in a real interactive cmd console (cmd /k).',
          stderr: '',
          wallMs: 0,
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
      };
    } catch (err) {
      return {
        kind: 'codex_interactive_error',
        exitCode: 1,
        args: [],
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        wallMs: 0,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/* ── Executor factory ────────────────────────────────────── */

/**
 * Resolve an ActionExecutor from the action's `runtime` field.
 * Phase 1 only implements `codex` (or null/undefined → codex).
 * Other runtimes throw; the caller (ActionRunner) catches and returns blocked.
 */
export function resolveExecutor(runtime: string | null | undefined): ActionExecutor {
  if (!runtime || runtime === 'codex') return new CodexExecutor();
  if (runtime === 'codex_interactive') return new CodexInteractiveExecutor();
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
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    '--enable', 'apps',
    ...codexInteractiveConfigArgs(env),
    '--cd', cwd,
    '--sandbox', 'read-only',
    `Read and execute the VoltMind action prompt from this file: ${promptPath}`,
  ];
}

export function resolveCodexInteractiveCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VOLTMIND_CODEX_BIN) return env.VOLTMIND_CODEX_BIN;
  return process.platform === 'win32' ? resolveWindowsCodexScript(env) : 'codex';
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

function codexInteractiveConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  args.push('-c', 'apps._default.enabled=true');
  args.push('-c', 'apps._default.destructive_enabled=false');
  args.push('-c', 'apps._default.open_world_enabled=false');

  const outlookEmailAppId = (env.VOLTMIND_CODEX_OUTLOOK_EMAIL_APP_ID ?? 'microsoft_outlook_email').trim();
  if (outlookEmailAppId) {
    args.push('-c', `apps.${outlookEmailAppId}.enabled=true`);
    args.push('-c', `apps.${outlookEmailAppId}.default_tools_enabled=true`);
    args.push('-c', `apps.${outlookEmailAppId}.default_tools_approval_mode="prompt"`);
  }

  const model = env.VOLTMIND_CODEX_MODEL?.trim();
  if (model) {
    args.push('-m', model);
  }
  return args;
}

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
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
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
  interactiveRun?: InteractiveActionRunEnvelope;
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
        await writeInteractiveActionPromptFiles(req.prompt, req.interactiveRun);
      } else {
        await mkdir(workDir, { recursive: true });
        await writeFile(promptPath, req.prompt, 'utf-8');
      }

      const args = buildCodexInteractiveArgs(process.cwd(), promptPath);
      const hasTTY = process.stdin.isTTY && process.stdout.isTTY;
      const childEnv = buildCodexInteractiveEnv(process.env, req.interactiveRun);

      if (hasTTY) {
        // Path A: real terminal — inherit stdio, Codex TUI opens inline
        const launch = buildCodexInteractiveLaunch(args, childEnv);
        const start = Date.now();
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
        const promptText = args[args.length - 1] || '';
        const quotedPrompt = '"' + promptText + '"';

        const startArgs = [
          '/c', 'start', '""',
          '/D', '"' + process.cwd() + '"',
          'cmd', '/k',
          'codex',
          quotedPrompt,
        ];

        // Sandbox note: on Codex sandboxed Windows, CreateProcessW may be
        // blocked even with detached:true. The spawn itself is synchronous
        // in Bun and the sandbox may hang it. If the Admin API /run handler
        // is called from a non-escalated serve process, this spawn will time
        // out the HTTP response. The pending interactive run is already
        // persisted in action_runs by this point; the writeback result.json
        // can be dropped in the action directory without Codex.
        spawn('cmd', startArgs, {
          cwd: process.cwd(),
          env: childEnv,
          shell: false,
          stdio: 'ignore',
          detached: true,
          windowsHide: false,
        });

        return {
          kind: 'codex_interactive_detached',
          exitCode: 0,
          args: ['codex', quotedPrompt],
          stdout: 'Codex launched in a real interactive cmd console (cmd /k).',
          stderr: '',
          wallMs: 0,
          actionRunId: req.interactiveRun?.runId,
          writebackStatus: req.interactiveRun ? 'interactive_pending' : undefined,
          actionDir: req.interactiveRun?.actionDir,
          requestPath: req.interactiveRun?.requestPath,
          resultPath: req.interactiveRun?.resultPath,
          promptPath,
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
      };
    } catch (err) {
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
      };
    } finally {
      if (shouldCleanup) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

export async function writeInteractiveActionPromptFiles(
  prompt: string,
  envelope: InteractiveActionRunEnvelope,
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
    VOLTMIND_ADMIN_ACTION_SOURCE_ID: envelope.sourceId,
    VOLTMIND_ADMIN_ACTION_SLUG: envelope.slug,
  };
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


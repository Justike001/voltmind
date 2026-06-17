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
import { mkdtemp, rm } from 'fs/promises';
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
      const child = spawn('codex', [
        'exec',
        '--cd', process.cwd(),
        '--sandbox', 'workspace-write',
        '-',
      ], {
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
        stdout,
        stderr,
        wallMs: Date.now() - start,
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
  throw new Error(`Runtime "${runtime}" is not implemented in Phase 1`);
}

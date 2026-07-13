/**
 * Unified CLI invocation resolver (spec §4).
 *
 * Replaces the legacy `resolveGbrainCliPath()` single-string resolver with a
 * structured `CliInvocation` that captures executable + prefix args + spawn
 * options. Both the Windows Task Scheduler action and the
 * ChildWorkerSupervisor worker spawn share this resolver so there is one
 * source of truth for "how do I launch voltmind".
 *
 * Design rules (spec §4 / §20):
 *   - `.ts` files are NEVER treated as an executable. Source entry points
 *     are converted to `bun <entry-file.ts> <args>`.
 *   - Windows `.cmd` shims are invoked via `ComSpec /d /s /c "..."` (never
 *     spawned as a native binary).
 *   - Windows command discovery uses `where.exe`; Unix uses `which`.
 *   - No shell string concatenation of user paths into XML / spawn args.
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { isAbsolute, join } from 'path';
import { voltmindPath } from '../config.ts';
import {
  AUTOPILOT_ERRORS,
  AutopilotError,
  type AutopilotFailureStage,
} from './diagnostics.ts';

export type CliInvocationSource =
  | 'native-exe'
  | 'windows-cmd-shim'
  | 'bun-source'
  | 'unix-binary'
  | 'unix-shim';

export interface CliInvocation {
  /** Executable to spawn (or, for .cmd, the ComSpec path). */
  executable: string;
  /** Args to prepend before the user-facing command (e.g. ['jobs','work']). */
  prefixArgs: string[];
  /** Working directory for the spawn. */
  cwd?: string;
  /** Env override (undefined = inherit). */
  env?: NodeJS.ProcessEnv;
  /** Where the executable was resolved from. */
  source: CliInvocationSource;
  /** Spawn options the caller SHOULD apply for a stable spawn. */
  spawnOptions?: {
    shell?: boolean;
    windowsVerbatimArguments?: boolean;
  };
}

export interface ResolveCliInvocationContext {
  /**
   * Optional explicit override path. When provided, the resolver validates
   * it and tags the source accordingly (it is NOT passed through blindly).
   */
  explicitPath?: string;
  /**
   * Repo root for resolving a dev-mode `bun src/cli.ts` entry. Defaults to
   * `process.cwd()`.
   */
  repoRoot?: string;
  /**
   * When true, the resolver prefers a Bun source entry (`bun <entry.ts>`)
   * over a PATH lookup. Useful for dev/test environments.
   */
  preferBunSource?: boolean;
}

const isWindows = process.platform === 'win32';

function fail(
  code: string,
  stage: AutopilotFailureStage,
  message: string,
  cause?: string,
  hint?: string,
): never {
  throw new AutopilotError({
    code,
    stage,
    message,
    cause,
    actionableHint: hint,
  });
}

/** Run `where.exe voltmind` (Windows) or `which voltmind` (Unix). */
function whichCli(): string | undefined {
  const bin = isWindows ? 'where.exe' : 'which';
  try {
    const out = execFileSync(bin, ['voltmind'], {
      encoding: 'utf8',
      timeout: 3000,
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `where.exe` may return multiple lines (all matches). Take the first.
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}

/** Run `where.exe bun` / `which bun`. */
function whichBun(): string | undefined {
  const bin = isWindows ? 'where.exe' : 'which';
  try {
    const out = execFileSync(bin, ['bun'], {
      encoding: 'utf8',
      timeout: 3000,
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}

function looksLikeCompiledBinary(p: string): boolean {
  const lower = p.toLowerCase();
  if (lower.endsWith('.exe')) return true;
  // Compiled Bun binary on Unix: no extension, basename === 'voltmind'.
  if (!lower.includes('.')) return /(^|\/|\\)voltmind$/.test(lower);
  return false;
}

function looksLikeBunRuntime(p: string): boolean {
  const base = p.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return base === 'bun' || base === 'bun.exe';
}

function looksLikeCmdShim(p: string): boolean {
  return p.toLowerCase().endsWith('.cmd');
}

function looksLikeTsEntry(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith('.ts') || lower.endsWith('.tsx');
}

/**
 * Resolve a `bun <entry.ts>` invocation for dev mode. `bun` is discovered on
 * PATH (where.exe/which). Throws `AUTOPILOT_BUN_NOT_FOUND` if absent.
 */
function resolveBunSource(entryFile: string): CliInvocation {
  const bunPath = whichBun();
  if (!bunPath) {
    fail(
      AUTOPILOT_ERRORS.BUN_NOT_FOUND,
      'cli-resolution',
      `Could not resolve 'bun' on PATH to run the source entry ${entryFile}.`,
      undefined,
      'Install Bun (https://bun.sh) or build the compiled voltmind binary so it is on PATH.',
    );
  }
  return {
    executable: bunPath,
    prefixArgs: [entryFile],
    source: 'bun-source',
  };
}

/**
 * Build a stable `CliInvocation` for a Windows `.cmd` shim. `.cmd` files must
 * be run through `cmd.exe` (ComSpec) with `/d /s /c "..."` — they are not
 * native executables and direct spawn fails with EACCES/ENOENT on Node.
 */
function resolveCmdShim(cmdPath: string): CliInvocation {
  const comSpec = process.env.ComSpec || 'cmd.exe';
  // `/d /s /c "<cmd>"` — the argument itself is the single quoted invocation.
  // The caller spawns `executable=comSpec` with `prefixArgs=['/d','/s','/c', cmdPath]`.
  // We keep the cmd path as a separate arg element (NOT concatenated) so the
  // supervisor / scheduler can pass it to spawn() verbatim without shell
  // injection.
  return {
    executable: comSpec,
    prefixArgs: ['/d', '/s', '/c', `"${cmdPath}"`],
    source: 'windows-cmd-shim',
    spawnOptions: { shell: false, windowsVerbatimArguments: false },
  };
}

/**
 * The canonical resolver. Resolution order (spec §4.1):
 *   native .exe (current process) → PATH native .exe → stable installed CLI
 *   → .cmd shim → bun source entry
 *
 * On Windows the installed CLI is typically a `.cmd` shim (npm/bun global
 * install). A compiled `.exe` wins if present.
 */
export async function resolveCliInvocation(
  context: ResolveCliInvocationContext = {},
): Promise<CliInvocation> {
  const repoRoot = context.repoRoot ?? process.cwd();

  // 1. Explicit path override — validate + tag source.
  if (context.explicitPath) {
    return classifyExplicitPath(context.explicitPath, repoRoot);
  }

  // 2. A compiled process must spawn the same native executable that is
  // already running. Checking PATH first can select a stale global install
  // when a repo-local `bin/voltmind.exe` launched Autopilot.
  const exec = process.execPath ?? '';
  if (exec && looksLikeCompiledBinary(exec) && !looksLikeBunRuntime(exec)) {
    return {
      executable: exec,
      prefixArgs: [],
      source: isWindows ? 'native-exe' : 'unix-binary',
    };
  }

  // 3. PATH lookup (where.exe / which) — the canonical installed shape.
  const onPath = whichCli();
  if (onPath && existsSync(onPath)) {
    if (looksLikeCompiledBinary(onPath)) {
      return {
        executable: onPath,
        prefixArgs: [],
        source: isWindows ? 'native-exe' : 'unix-binary',
      };
    }
    if (looksLikeCmdShim(onPath)) {
      return resolveCmdShim(onPath);
    }
    // A non-binary, non-.cmd PATH entry (e.g. a shell shim script). Treat as
    // a unix-shim on Unix; on Windows only .cmd shims are expected.
    if (!isWindows) {
      return { executable: onPath, prefixArgs: [], source: 'unix-shim' };
    }
  }

  // 4. argv[1] — direct invocation of compiled binary (no PATH).
  const arg1 = process.argv[1] ?? '';
  if (arg1) {
    if (looksLikeCompiledBinary(arg1)) {
      return {
        executable: arg1,
        prefixArgs: [],
        source: isWindows ? 'native-exe' : 'unix-binary',
      };
    }
    if (looksLikeTsEntry(arg1)) {
      // Dev mode: `bun src/cli.ts`. Convert to a bun source invocation.
      if (context.preferBunSource || !onPath) {
        return resolveBunSource(arg1);
      }
    }
  }

  // 5. Last resort: repo-local source entry (bun run).
  const localEntry = join(repoRoot, 'src', 'cli.ts');
  if (existsSync(localEntry)) {
    return resolveBunSource(localEntry);
  }

  fail(
    AUTOPILOT_ERRORS.CLI_NOT_FOUND,
    'cli-resolution',
    'Could not resolve the voltmind CLI entrypoint for spawning.',
    undefined,
    'Install voltmind so it is on PATH (e.g. /usr/local/bin/voltmind or a .cmd shim), build the compiled binary, or run from a repo with src/cli.ts using Bun.',
  );
}

function classifyExplicitPath(p: string, repoRoot: string): CliInvocation {
  if (!p) {
    fail(AUTOPILOT_ERRORS.CLI_INVOCATION_INVALID, 'cli-resolution', 'Empty explicit CLI path.');
  }
  if (looksLikeTsEntry(p)) {
    // Source entry — must be run via bun.
    const entry = isAbsolute(p) ? p : join(repoRoot, p);
    if (!existsSync(entry)) {
      fail(
        AUTOPILOT_ERRORS.CLI_INVOCATION_INVALID,
        'cli-resolution',
        `Source entry not found: ${entry}`,
      );
    }
    return resolveBunSource(entry);
  }
  if (!existsSync(p)) {
    fail(
      AUTOPILOT_ERRORS.CLI_NOT_FOUND,
      'cli-resolution',
      `Explicit CLI path does not exist: ${p}`,
    );
  }
  if (looksLikeCmdShim(p)) return resolveCmdShim(p);
  if (looksLikeCompiledBinary(p)) {
    return {
      executable: p,
      prefixArgs: [],
      source: isWindows ? 'native-exe' : 'unix-binary',
    };
  }
  // Generic script shim on Unix.
  if (!isWindows) {
    return { executable: p, prefixArgs: [], source: 'unix-shim' };
  }
  fail(
    AUTOPILOT_ERRORS.CLI_INVOCATION_INVALID,
    'cli-resolution',
    `Unrecognized explicit CLI path on Windows: ${p}`,
  );
}

/**
 * Build the full argv for a `voltmind <subcommand> <args>` invocation from a
 * resolved `CliInvocation`. Pure; no side effects.
 *
 * For a `.cmd` shim the prefix args already include the ComSpec framing
 * (`/d /s /c "<cmd>"`), so the subcommand args are appended after the
 * framed invocation. Callers pass the result to `spawn(invocation.executable,
 * fullArgs, invocation.spawnOptions)`.
 */
export function buildCliArgv(
  invocation: CliInvocation,
  subcommandArgs: string[],
): string[] {
  return [...invocation.prefixArgs, ...subcommandArgs];
}

/**
 * Produce a single shell-safe command string for display / logs. NEVER used
 * to build spawn args (we always use the structured argv). Useful for the
 * Task Scheduler action `<Arguments>` element where the executable and
 * arguments are separate XML elements.
 */
export function formatCliForDisplay(invocation: CliInvocation, subcommandArgs: string[]): string {
  return [invocation.executable, ...invocation.prefixArgs, ...subcommandArgs]
    .map((a) => (a.includes(' ') ? `"${a}"` : a))
    .join(' ');
}

/** Path used for the lock file and runtime state (shared by all callers). */
export function autopilotLockPath(): string {
  return voltmindPath('autopilot.lock');
}

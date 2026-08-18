/**
 * voltmind remote-source git helpers (v0.28).
 *
 * Single source of SSRF-defensive git invocations. parseRemoteUrl delegates
 * to isInternalUrl from src/core/url-safety.ts (covers scheme allowlist,
 * IPv6 loopback, IPv4-mapped IPv6, metadata hostnames, hex/octal bypass,
 * and CGNAT 100.64/10).
 *
 * cloneRepo and pullRepo both spread GIT_SSRF_FLAGS so a future flag added
 * to one path lands on both — single source of truth.
 *
 * Tailscale 100.64/10 trips the integrations.ts allowlist (CGNAT line in
 * url-safety.ts isPrivateIpv4). For self-hosted internal git servers
 * reachable only via Tailscale, set VOLTMIND_ALLOW_PRIVATE_REMOTES=1; loud
 * stderr warning at use site is the operator's signal.
 */
import { execFileSync } from 'child_process';
import { lstatSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { isInternalUrl } from './url-safety.ts';
import { validateAndResolveUrl, type ResolvedTarget } from './ssrf-validate.ts';
export type { ResolvedTarget } from './ssrf-validate.ts';

/**
 * Git CLI accepts two flag positions:
 *   git [global -c flags] <subcommand> [subcommand flags] [args]
 *
 * Global flags (the `-c key=value` config overrides) MUST come before the
 * subcommand. Subcommand-specific flags (like `--no-recurse-submodules`)
 * MUST come after the subcommand. Mixing the two positions makes git fail
 * with `unknown option` (exit 129). Pre-v0.34 the single GIT_SSRF_FLAGS
 * constant spliced both positions before the verb; real git rejected the
 * subcommand flag but the test harness used a fake-git script that didn't
 * validate, so every remote-source clone/pull broke silently in production.
 *
 * Split into two constants so the call-site spread is unambiguous and the
 * type/name signal the position rule.
 */

/**
 * Global git config flags. Spread BEFORE the subcommand verb.
 * - http.followRedirects=false: closes DNS rebinding via redirect chains
 * - protocol.file.allow=never: no local-file URLs (defense in depth)
 * - protocol.ext.allow=never: no external helpers (`git-remote-foo`)
 */
export const GIT_SSRF_FLAGS = [
  '-c', 'http.followRedirects=false',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
] as const;

/**
 * Subcommand-level flags. Spread AFTER the subcommand verb (clone/pull).
 * - --no-recurse-submodules: .gitmodules cannot become a second fetch surface
 */
export const GIT_SSRF_SUBCOMMAND_FLAGS = [
  '--no-recurse-submodules',
] as const;

export type RemoteUrlErrorCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'embedded_credentials'
  | 'path_traversal'
  | 'internal_target'
  | 'dns_resolution_failed'
  | 'dns_resolved_internal';

export class RemoteUrlError extends Error {
  constructor(public code: RemoteUrlErrorCode, message: string) {
    super(message);
    this.name = 'RemoteUrlError';
  }
}

export interface ParsedRemoteUrl {
  url: string;
  hostname: string;
}

export interface ResolvedRemoteUrl extends ParsedRemoteUrl {
  /** DNS-pinned target for HTTP(S); undefined for SSH remotes. */
  resolvedTarget?: ResolvedTarget;
}

export interface ParseUrlOpts {
  /**
   * Accept SSH remote forms (`ssh://git@host/org/repo.git` or scp-style
   * `git@host:org/repo.git`). Opt-in: only the HOST-side trusted provision
   * path sets this — public/remote `sources_add` stays https-only so the
   * SSRF surface isn't widened for untrusted callers. The operator's SSH
   * key (already on the Host) authorizes the clone; no password prompt.
   */
  allowSsh?: boolean;
}

/**
 * Validate a remote git URL for clone safety. https:// by default; with
 * `allowSsh` also accepts ssh:// and scp-style git@host:path forms.
 * Rejects: unsupported schemes, embedded credentials (https), path
 * traversal, and internal/private targets (unless VOLTMIND_ALLOW_PRIVATE_REMOTES=1).
 */
export function parseRemoteUrl(s: string, opts: ParseUrlOpts = {}): ParsedRemoteUrl {
  if (!s || typeof s !== 'string') {
    throw new RemoteUrlError('invalid_url', 'URL is empty or not a string');
  }

  // scp-style SSH form:  git@host:org/repo.git
  const scp = /^([^@/\s]+)@([^:\s]+):(.+)$/.exec(s);
  let url: URL;
  let hostname: string;
  if (scp && opts.allowSsh) {
    hostname = scp[2];
    url = new URL(`ssh://${scp[1]}@${scp[2]}/${scp[3]}`);
  } else {
    try {
      url = new URL(s);
    } catch {
      throw new RemoteUrlError('invalid_url', `URL malformed: ${s}`);
    }
    hostname = url.hostname;
  }

  const proto = url.protocol;
  const isHttp = proto === 'http:' || proto === 'https:';
  const isSsh = opts.allowSsh === true && (proto === 'ssh:' || Boolean(scp));
  if (!isHttp && !isSsh) {
    throw new RemoteUrlError(
      'unsupported_scheme',
      `URL scheme not supported (http(s) only${opts.allowSsh ? ', or ssh:// / git@host:path' : ''}): ${proto}`,
    );
  }
  // Embedded credentials are never allowed. SSH uses the operator's key, not
  // a password in the URL; https must be password-free (key/token via env/helper).
  if (isHttp && (url.username || url.password)) {
    throw new RemoteUrlError(
      'embedded_credentials',
      'URL must not contain embedded credentials (https://user:pass@host)',
    );
  }
  if (s.includes('..')) {
    throw new RemoteUrlError('path_traversal', 'URL must not contain path-traversal (..)');
  }
  if (isInternalUrl(s)) {
    if (process.env.VOLTMIND_ALLOW_PRIVATE_REMOTES === '1') {
      console.error(
        `[voltmind] WARN: VOLTMIND_ALLOW_PRIVATE_REMOTES=1, accepting internal/private URL: ${hostname}`,
      );
    } else {
      throw new RemoteUrlError(
        'internal_target',
        `URL targets internal/private network: ${hostname} ` +
          `(set VOLTMIND_ALLOW_PRIVATE_REMOTES=1 for self-hosted git over Tailscale or similar)`,
      );
    }
  }
  return { url: s, hostname };
}

/**
 * Resolve an HTTP(S) git remote once through the shared DNS-aware SSRF
 * validator. The caller must pass the returned target to git via
 * http.curloptResolve so git never performs a second hostname lookup.
 */
export async function resolveRemoteUrl(
  s: string,
  opts: ParseUrlOpts = {},
): Promise<ResolvedRemoteUrl> {
  const parsed = parseRemoteUrl(s, opts);
  if (!parsed.url.startsWith('http://') && !parsed.url.startsWith('https://')) {
    return parsed;
  }

  try {
    const resolvedTarget = await validateAndResolveUrl(parsed.url, { allowPrivate: false });
    return { ...parsed, resolvedTarget };
  } catch (err) {
    const code = err instanceof Error && 'code' in err
      ? (err as { code?: string }).code
      : undefined;
    if (code === 'DNS_RESOLUTION_FAILED') {
      throw new RemoteUrlError('dns_resolution_failed', err instanceof Error ? err.message : String(err));
    }
    if (code === 'DNS_RESOLVED_INTERNAL' || code === 'INTERNAL_HOST') {
      throw new RemoteUrlError('dns_resolved_internal', err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

export interface CloneOpts {
  depth?: number; // default 1; 0 means full clone
  branch?: string;
  timeoutMs?: number; // default 600_000 (10 min)
  /** Internal seam for callers/tests that already performed shared validation. */
  resolvedTarget?: ResolvedTarget;
}

export class GitOperationError extends Error {
  constructor(
    public op: 'clone' | 'pull' | 'remote_get_url',
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}

const GIT_ENV = {
  // Confine to the voltmind SSRF model — no credential helpers, no SSH askpass,
  // no GUI prompts. Inherit PATH so git itself is findable.
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '/bin/false',
  SSH_ASKPASS: '/bin/false',
} as const;

/**
 * Clone a remote git repo with SSRF-defensive flags.
 * - destDir must NOT exist or must be empty.
 * - Default --depth=1 (no history); pass {depth: 0} for full clone.
 * - Throws GitOperationError on failure; caller is responsible for cleanup.
 */
export async function cloneRepo(url: string, destDir: string, opts: CloneOpts = {}): Promise<void> {
  if (existsSync(destDir)) {
    let entries: string[];
    try {
      entries = readdirSync(destDir);
    } catch (e) {
      throw new GitOperationError(
        'clone',
        `Cannot inspect destination ${destDir}: ${(e as Error).message}`,
        e,
      );
    }
    if (entries.length > 0) {
      throw new GitOperationError(
        'clone',
        `Destination ${destDir} exists and is not empty; refusing to clone`,
      );
    }
  }

  let parsed: ResolvedRemoteUrl;
  try {
    parsed = opts.resolvedTarget
      ? { ...parseRemoteUrl(url, { allowSsh: true }), resolvedTarget: opts.resolvedTarget }
      : await resolveRemoteUrl(url, { allowSsh: true });
  } catch (e) {
    if (e instanceof RemoteUrlError) {
      throw new GitOperationError('clone', `git clone remote rejected: ${e.message}`, e);
    }
    throw e;
  }

  const args: string[] = [...GIT_SSRF_FLAGS];
  if (parsed.resolvedTarget?.originalHost) {
    const source = new URL(parsed.url);
    const port = source.port || (source.protocol === 'https:' ? '443' : '80');
    const ip = parsed.resolvedTarget.ipv6
      ? `[${parsed.resolvedTarget.resolvedIp}]`
      : parsed.resolvedTarget.resolvedIp;
    args.push('-c', `http.curloptResolve=${parsed.resolvedTarget.originalHost}:${port}:${ip}`);
  }
  args.push('clone', ...GIT_SSRF_SUBCOMMAND_FLAGS);
  if (opts.depth !== 0) {
    args.push(`--depth=${opts.depth ?? 1}`);
  }
  if (opts.branch) {
    args.push('--branch', opts.branch);
  }
  args.push(parsed.url, destDir);

  const isSsh = parsed.url.startsWith('ssh://') || /^[^@/\s]+@[^:\s]+:/.test(parsed.url);
  const sshEnv = isSsh
    ? {
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      }
    : {};

  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 600_000,
      env: { ...process.env, ...GIT_ENV, ...sshEnv },
    });
  } catch (e) {
    throw new GitOperationError(
      'clone',
      `git clone failed for ${parsed.url}: ${(e as Error).message}`,
      e,
    );
  }
}

/** Pull a repo with --ff-only and the same SSRF-defensive flags as cloneRepo. */
export async function pullRepo(
  repoPath: string,
  opts: { timeoutMs?: number; remoteUrl?: string; resolvedTarget?: ResolvedTarget } = {},
): Promise<void> {
  let remoteUrl = opts.remoteUrl;
  if (!remoteUrl) {
    try {
      remoteUrl = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        env: { ...process.env, ...GIT_ENV },
      }).toString().trim();
    } catch (e) {
      throw new GitOperationError('pull', `could not read origin remote in ${repoPath}`, e);
    }
  }
  if (!remoteUrl) {
    throw new GitOperationError('pull', `origin remote is empty in ${repoPath}`);
  }

  let parsed: ResolvedRemoteUrl;
  try {
    parsed = opts.resolvedTarget
      ? { ...parseRemoteUrl(remoteUrl, { allowSsh: true }), resolvedTarget: opts.resolvedTarget }
      : await resolveRemoteUrl(remoteUrl, { allowSsh: true });
  } catch (e) {
    if (e instanceof RemoteUrlError) {
      throw new GitOperationError('pull', `git pull remote rejected: ${e.message}`, e);
    }
    throw e;
  }

  const args: string[] = ['-C', repoPath, ...GIT_SSRF_FLAGS];
  if (parsed.resolvedTarget?.originalHost) {
    const source = new URL(parsed.url);
    const port = source.port || (source.protocol === 'https:' ? '443' : '80');
    const ip = parsed.resolvedTarget.ipv6
      ? `[${parsed.resolvedTarget.resolvedIp}]`
      : parsed.resolvedTarget.resolvedIp;
    args.push('-c', `http.curloptResolve=${parsed.resolvedTarget.originalHost}:${port}:${ip}`);
  }
  args.push('pull', ...GIT_SSRF_SUBCOMMAND_FLAGS, '--ff-only');
  try {
    execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 300_000,
      env: { ...process.env, ...GIT_ENV },
    });
  } catch (e) {
    throw new GitOperationError(
      'pull',
      `git pull failed in ${repoPath}: ${(e as Error).message}`,
      e,
    );
  }
}

export type RepoState =
  | 'healthy'
  | 'missing'
  | 'not-a-dir'
  | 'no-git'
  | 'url-drift'
  | 'corrupted';

/**
 * Classify the on-disk state of a clone. Used by performSync to decide
 * whether to run pull (healthy), re-clone (missing/no-git/not-a-dir),
 * refuse with corruption error (corrupted), or refuse with rebase-clone
 * hint (url-drift).
 */
export function validateRepoState(
  repoPath: string,
  expectedRemoteUrl?: string,
): RepoState {
  let stat;
  try {
    stat = lstatSync(repoPath);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return 'missing';
    return 'not-a-dir';
  }
  if (!stat.isDirectory()) return 'not-a-dir';
  if (!existsSync(join(repoPath, '.git'))) return 'no-git';

  let remoteUrl: string;
  try {
    const out = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: { ...process.env, ...GIT_ENV },
    });
    remoteUrl = out.toString().trim();
  } catch {
    return 'corrupted';
  }

  if (expectedRemoteUrl !== undefined && remoteUrl !== expectedRemoteUrl) {
    return 'url-drift';
  }
  return 'healthy';
}

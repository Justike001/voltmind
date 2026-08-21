/**
 * Personal-knowledge-base provisioning (v0.43 experimental).
 *
 * Turns a company email into (1) a dedicated, isolated DB `source`, (2) an
 * optional git checkout of the user's knowledge repo, and (3) an OAuth
 * client bound ONLY to that source — the "thin-client" credential a user's
 * agent needs to connect to the Host's MCP server.
 *
 * Email → source contract:
 *   - `alice-example@company.example` -> source id `personal-alice-<digest>`
 *   - one email always derives to exactly one source id (deterministic), so
 *     a re-provision can never create a second source for the same person.
 *
 * Security model:
 *   - The OAuth client is scoped `--source <personal-id> --federated-read
 *     <personal-id>` (+ read/write), so the user can ONLY read/write their own
 *     source. Cross-user isolation is enforced by the OAuth binding and the
 *     app-layer sourceScopeOpts / resolveWriteSourceId filters.
 *   - This is a HOST-side, trusted operation. It must be invoked by the Host
 *     operator / Host agent (CLI or the `/admin/api/*` bootstrap-token
 *     surface), never exposed to an unauthenticated thin client.
 */

import type { BrainEngine } from './engine.ts';
import type { SqlQuery } from './sql-query.ts';
import { addSource } from './sources-ops.ts';
import { VoltMindOAuthProvider } from './oauth-provider.ts';
import { createHash } from 'node:crypto';

/** Company email domain. Overridable for other instances via env. */
export const COMPANY_DOMAIN = process.env.VOLTMIND_COMPANY_DOMAIN || 'company.example';

/**
 * The only SSH host the Host-owned Gogs key is ever allowed to clone from.
 * Reinforces that the key exists for syncing company private repos, not for
 * reaching arbitrary internal hosts. Overridable via env.
 */
export const GOGS_SSH_HOST = process.env.VOLTMIND_GOGS_SSH_HOST || 'gogs.internal.example';

/** Gogs REST API base (for self-provision owner verification). */
export const GOGS_API_URL =
  process.env.VOLTMIND_GOGS_API_URL || `http://${GOGS_SSH_HOST}:3000/api/v1`;

export interface NormalizedCompanyEmail {
  local: string;
  domain: string;
}

/** Normalize + validate a company email (lowercases; enforces the domain). */
export function normalizeCompanyEmail(email: string): NormalizedCompanyEmail {
  if (typeof email !== 'string' || email.trim() === '') {
    throw new Error('company email is required');
  }
  const e = email.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) {
    throw new Error(`Invalid email address: "${email}"`);
  }
  const at = e.lastIndexOf('@');
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain !== COMPANY_DOMAIN) {
    throw new Error(
      `Email domain "${domain}" is not the company domain "${COMPANY_DOMAIN}". ` +
        `Personal sources are only minted for company email addresses.`,
    );
  }
  return { local, domain };
}

/**
 * Derive the deterministic personal source id for a company email.
 *
 * The readable prefix is intentionally NOT the identity boundary: distinct
 * valid email locals such as `a.b`, `a_b`, and `a-b` can collapse to the same
 * slug. A stable digest of the full normalized email keeps those identities
 * isolated while preserving a short human-readable hint.
 */
export function deriveSourceIdFromEmail(email: string): string {
  const { local } = normalizeCompanyEmail(email);
  const stem = local
    .replace(/[._]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'user';
  const normalizedEmail = `${local}@${COMPANY_DOMAIN}`;
  const digest = createHash('sha256').update(normalizedEmail, 'utf8').digest('hex').slice(0, 16);
  const readable = stem.slice(0, 6).replace(/-+$/g, '') || 'user';
  // At most 9 (`personal-`) + 6 readable chars + 1 separator + 16 hex chars = 32.
  return `personal-${readable}-${digest}`;
}

/** Pre-fix id, used only to adopt an already-provisioned source safely. */
function deriveLegacySourceIdFromEmail(email: string): string | null {
  const { local } = normalizeCompanyEmail(email);
  const stem = local
    .replace(/[._]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-');
  const sourceId = `personal-${stem}`;
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(sourceId) ? sourceId : null;
}

function sourceOwnerEmail(config: unknown): string | null {
  let value = config;
  // Postgres rows written by the old `$N::jsonb` + JSON.stringify path may
  // come back as a JSONB string scalar. Decode once for safe adoption.
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const owner = (value as Record<string, unknown>).owner_email;
  return typeof owner === 'string' ? owner.trim().toLowerCase() : null;
}

export interface ProvisionPersonalOpts {
  /** Company email; eg `alice-example@company.example`. */
  email: string;
  /** Knowledge-repo git URL to checkout into the source (eg the user's Gogs repo). */
  repoUrl?: string;
  /**
   * Accepts SSH remote URLs (ssh://git@host/org/repo.git or git@host:org/repo.git),
   * cloned with the Host's Gogs-admin key. Host-side provision only.
   */
  allowSsh?: boolean;
  /** Isolated by default (false) so one person's KB never leaks into shared search. */
  federated?: boolean;
  /** Space-separated OAuth scopes for the minted thin-client. Default `read write`. */
  scopes?: string;
  /** OAuth grant types for the minted client. Default `client_credentials`. */
  grantTypes?: string[];
}

export interface ProvisionPersonalResult {
  alreadyProvisioned: boolean;
  source_id: string;
  source_name: string;
  clone_path: string | null;
  owner_email: string;
  client_id: string;
  client_secret?: string;
}

/**
 * Extract the host from an SSH URL — scp-ish `git@host:path` or `ssh://git@host:port/...`.
 * Returns null if it isn't a recognizable SSH remote.
 */
export function sshHostOf(url: string): string | null {
  const scp = /^[^@/\s]+@([^:\s]+):/.exec(url);
  if (scp) return scp[1];
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Result of a Gogs-owner identity check.
 */
export interface GogsOwnerCheck {
  ok: boolean;
  /** Gogs login (username) of the token owner when ok. */
  user?: string;
  /** Machine code for the failure, e.g. 'gogs_token_invalid' | 'email_owner_mismatch' | 'repo_not_owned'. */
  reason?: string;
}
export interface GogsRepoRef {
  owner: string;
  repo: string;
}

function gogsUserEmail(u: unknown): string {
  const e = (u as Record<string, unknown>)?.email;
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

function gogsUserLogin(u: unknown): string {
  const l = (u as Record<string, unknown>)?.login ?? (u as Record<string, unknown>)?.username;
  return typeof l === 'string' ? l : '';
}

function normLocal(s: string): string {
  return s.replace(/[._]+/g, '-').toLowerCase();
}

/**
 * Parse every git URL form accepted by the self-provision path into the
 * corresponding Gogs REST repository coordinates. Returning null is
 * fail-closed: owner verification must never silently skip the repo check.
 */
export function gogsRepoRef(repoUrl: string): GogsRepoRef | null {
  let path: string;
  const scp = /^[^@/\s]+@[^:\s]+:(.+)$/.exec(repoUrl);
  if (scp) {
    path = scp[1];
  } else {
    try {
      const parsed = new URL(repoUrl);
      if (parsed.protocol !== 'ssh:' && parsed.protocol !== 'https:') return null;
      path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Verify the caller (identified by a Gogs personal-access token) is the OWNER
 * of the claimed company email AND can access the claimed repo. This is the
 * anti-IDOR gate for self-service provisioning: a member can only claim their
 * own personal KB.
 *
 * Checks:
 *   1. token is valid → Gogs `GET /user`
 *   2. token user's email == claimed email; login fallback is allowed only
 *      when Gogs omits the email field
 *   3. token user can read the repo → Gogs `GET /repos/{owner}/{repo}`
 */
export async function verifyGogsOwner(
  email: string,
  repoUrl: string,
  gogsToken: string,
  base: string = GOGS_API_URL,
  fetchFn: typeof fetch = fetch,
): Promise<GogsOwnerCheck> {
  if (!gogsToken || typeof gogsToken !== 'string') {
    return { ok: false, reason: 'gogs_token_required' };
  }

  let userRes: Response;
  try {
    userRes = await fetchFn(`${base}/user`, {
      headers: { Authorization: `token ${gogsToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, reason: 'gogs_unreachable' };
  }
  if (!userRes.ok) return { ok: false, reason: 'gogs_token_invalid' };
  const user = await userRes.json().catch(() => null);
  if (!user) return { ok: false, reason: 'gogs_token_invalid' };

  const claimed = email.trim().toLowerCase();
  const tokenEmail = gogsUserEmail(user);
  const tokenLogin = gogsUserLogin(user);
  const bound = tokenEmail !== ''
    ? tokenEmail === claimed
    : tokenLogin !== '' && normLocal(tokenLogin) === normLocal(claimed.split('@')[0]);
  if (!bound) return { ok: false, reason: 'email_owner_mismatch' };

  // Token user must actually be able to read the exact repo that the Host
  // will clone. All accepted URL forms are parsed; an unrecognized form is a
  // rejection rather than a skipped authorization check.
  const repoRef = gogsRepoRef(repoUrl);
  if (!repoRef) return { ok: false, reason: 'invalid_repo_url' };
  try {
    const repoRes = await fetchFn(`${base}/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}`, {
      headers: { Authorization: `token ${gogsToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!repoRes.ok) return { ok: false, reason: 'repo_not_owned' };
  } catch {
    return { ok: false, reason: 'gogs_unreachable' };
  }

  return { ok: true, user: tokenLogin };
}

/**
 * Thrown when an SSH checkout targets a host other than the allowlisted
 * company Gogs server. Dedicated type so the MCP op can map it to a
 * structured OperationError (code: ssh_host_not_allowlisted) instead of a
 * generic internal_error.
 */
export class SshHostNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshHostNotAllowedError';
  }
}

/** Fail-closed ownership error for a normalized source-id collision. */
export class SourceOwnerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceOwnerMismatchError';
  }
}

function ownerEmailFromConfig(config: unknown): string | null {
  let parsed = config;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const owner = (parsed as Record<string, unknown>).owner_email;
  return typeof owner === 'string' && owner.trim() !== '' ? owner.trim().toLowerCase() : null;
}

/**
 * Pure allowlist gate: an SSH checkout is only permitted against the company
 * Gogs host. Throws SshHostNotAllowedError otherwise. Used so the Host key
 * can't be pointed at arbitrary internal hosts even by an admin.
 */
export function assertSshHostAllowed(url: string, expectedHost: string = GOGS_SSH_HOST): void {
  const host = sshHostOf(url);
  if (host !== expectedHost) {
    throw new SshHostNotAllowedError(
      `SSH checkout is only allowed to the company Gogs host "${expectedHost}" ` +
        `(got "${host}"). Set VOLTMIND_GOGS_SSH_HOST to override.`,
    );
  }
}

/**
 * Read a sources row by id under the row's own transaction-local scope.
 *
 * v0.42 #7: `sources_source_read` filters by current_setting('app.source_id'),
 * so under the restricted (NOBYPASSRLS) role a bare SELECT cannot see rows
 * outside the current scope. Re-provisioning an existing personal source
 * therefore misread the row as absent and re-INSERTed, tripping the PK.
 *
 * Scoping to the target id is the minimal read that can observe exactly the
 * row in question (idempotency), without granting cross-source visibility.
 * Engines without a real `transaction` (test stubs) fall back to the plain
 * read — they have no RLS to satisfy.
 */
async function fetchSourceByIdScoped(
  engine: BrainEngine,
  id: string,
): Promise<Array<{ id: string; config: unknown }>> {
  if (typeof engine.transaction !== 'function' || typeof engine.setSourceScope !== 'function') {
    return engine.executeRaw<{ id: string; config: unknown }>(
      'SELECT id, config FROM sources WHERE id = $1',
      [id],
    );
  }
  return engine.transaction(async (tx) => {
    await tx.setSourceScope(id);
    return tx.executeRaw<{ id: string; config: unknown }>(
      'SELECT id, config FROM sources WHERE id = $1',
      [id],
    );
  });
}

/**
 * Provision a personal knowledge base for one company email:
 *   1. derive + validate source id (deterministic from email — dedup by id)
 *   2. if the source doesn't exist yet, create it (optionally git-checkout
 *      the user's repo into $VOLTMIND_HOME/clones/<id>/)
 *   3. mint an OAuth client bound ONLY to that source (read/write)
 *
 * Returns a client_id/client_secret the user's agent can use with
 * `voltmind init --mcp-only`. Re-invoking for the same email never creates a
 * second source (alreadyProvisioned=true); it just mints a fresh client bound
 * to the existing source.
 */
export async function provisionPersonalSource(
  engine: BrainEngine,
  sql: SqlQuery,
  opts: ProvisionPersonalOpts,
): Promise<ProvisionPersonalResult> {
  const email = opts.email.trim().toLowerCase();
  const { local } = normalizeCompanyEmail(email);
  let sourceId = deriveSourceIdFromEmail(email);
  const scopes = opts.scopes ?? 'read write';
  const grantTypes = opts.grantTypes ?? ['client_credentials'];
  const federated = opts.federated ?? false;

  // SSH checkout is only permitted against the company Gogs host — the Host
  // key exists to sync company private repos, never to reach arbitrary hosts.
  if (opts.allowSsh === true && opts.repoUrl) {
    assertSshHostAllowed(opts.repoUrl);
  }

  // Deterministic dedup: one email → one source id. Re-provisioning mints a
  // fresh client against the SAME source instead of a duplicate.
  //
  // v0.42 #7 (RLS idempotency): under the restricted (NOBYPASSRLS) role,
  // `sources_source_read` filters by current_setting('app.source_id'), so a
  // bare SELECT cannot see a row outside the current scope — including the
  // very source this email already owns. That made re-provisioning look like
  // a first-time request and blow up on the sources PK. Read under the
  // target source's transaction-local scope instead.
  let existing = await fetchSourceByIdScoped(engine, sourceId);

  // Source ids predate self-service and intentionally normalize dots and
  // underscores. Two distinct valid emails can therefore derive the same id.
  // Before minting any credential for an existing source, bind it back to the
  // recorded owner email and reject collisions (or unverifiable legacy rows).
  if (existing.length > 0) {
    const recordedOwner = ownerEmailFromConfig(existing[0].config);
    if (recordedOwner !== email) {
      throw new SourceOwnerMismatchError(
        "Source " + sourceId + " belongs to a different or unverifiable owner; refusing to mint credentials.",
      );
    }
  }

  // Backward compatibility for sources created before collision-resistant
  // ids shipped. Reuse the legacy id only when its persisted owner matches
  // exactly; never infer ownership from the lossy slug itself.
  if (existing.length === 0) {
    const legacySourceId = deriveLegacySourceIdFromEmail(email);
    if (legacySourceId && legacySourceId !== sourceId) {
      const legacy = await fetchSourceByIdScoped(engine, legacySourceId);
      if (legacy[0] && sourceOwnerEmail(legacy[0].config) === email) {
        sourceId = legacySourceId;
        existing = legacy;
      }
    }
  }

  let clonePath: string | null = null;
  let sourceName = `${local} personal brain`;
  let alreadyProvisioned = false;

  if (existing.length === 0) {
    const row = await addSource(engine, {
      id: sourceId,
      name: sourceName,
      remoteUrl: opts.repoUrl,
      federated,
      allowSsh: opts.allowSsh === true,
      // Record the owning email in the source config (JSONB) for management/auditing.
      extraConfig: { owner_email: email },
    });
    clonePath = row.local_path ?? null;
    sourceName = row.name ?? sourceName;
  } else {
    alreadyProvisioned = true;
    const row = await engine.executeRaw<{ local_path: string | null; name: string }>(
      'SELECT local_path, name FROM sources WHERE id = $1',
      [sourceId],
    );
    clonePath = row[0]?.local_path ?? null;
    sourceName = row[0]?.name ?? sourceName;
  }

  // Mint the thin-client credential bound to ONLY this source.
  const provider = new VoltMindOAuthProvider({ sql });
  const { clientId, clientSecret } = await provider.registerClientManual(
    email,
    grantTypes,
    scopes,
    [],
    sourceId,
    [sourceId],
    'client_secret_post',
  );

  return {
    alreadyProvisioned,
    source_id: sourceId,
    source_name: sourceName,
    clone_path: clonePath,
    owner_email: email,
    client_id: clientId,
    client_secret: clientSecret,
  };
}

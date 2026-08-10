/**
 * Personal-knowledge-base provisioning (v0.43 experimental).
 *
 * Turns a company email into (1) a dedicated, isolated DB `source`, (2) an
 * optional git checkout of the user's knowledge repo, and (3) an OAuth
 * client bound ONLY to that source — the "thin-client" credential a user's
 * agent needs to connect to the Host's MCP server.
 *
 * Email → source contract:
 *   - `alice-example@company.example` → source id `personal-alice-<digest>`
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
  let existing = await engine.executeRaw<{ id: string; config: unknown }>(
    'SELECT id, config FROM sources WHERE id = $1',
    [sourceId],
  );

  // Backward compatibility for sources created before collision-resistant
  // ids shipped. Reuse the legacy id only when its persisted owner matches
  // exactly; never infer ownership from the lossy slug itself.
  if (existing.length === 0) {
    const legacySourceId = deriveLegacySourceIdFromEmail(email);
    if (legacySourceId && legacySourceId !== sourceId) {
      const legacy = await engine.executeRaw<{ id: string; config: unknown }>(
        'SELECT id, config FROM sources WHERE id = $1',
        [legacySourceId],
      );
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

/**
 * Unit tests for personal-knowledge-base provisioning (email → source id).
 *
 * Covers the identity contract that the rest of the feature depends on:
 *   - company-email normalization (lowercase + domain enforcement)
 *   - deterministic email → source-id derivation (one email == one source)
 *   - dedup guarantee (re-provisioning can never yield a second source id)
 *
 * The DB/oauth minting path (provisionPersonalSource) needs a live engine +
 * SQL handle, so its interaction is exercised end-to-end separately; these
 * tests pin the pure contract.
 */
import { describe, it, expect } from 'bun:test';
import {
  COMPANY_DOMAIN,
  normalizeCompanyEmail,
  deriveSourceIdFromEmail,
  GOGS_SSH_HOST,
  sshHostOf,
  assertSshHostAllowed,
  SshHostNotAllowedError,
  verifyGogsOwner,
  gogsRepoRef,
  provisionPersonalSource,
  SourceOwnerMismatchError,
} from '../src/core/personal-provision.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SqlQuery } from '../src/core/sql-query.ts';

describe('normalizeCompanyEmail', () => {
  it('accepts a valid company email and lowercases it', () => {
    expect(normalizeCompanyEmail('Alice-Example@company.example')).toEqual({
      local: 'alice-example',
      domain: 'company.example',
    });
    expect(COMPANY_DOMAIN).toBe('company.example');
  });

  it('rejects a non-company domain', () => {
    expect(() => normalizeCompanyEmail('someone@gmail.com')).toThrow(/not the company domain/);
  });

  it('rejects malformed emails', () => {
    expect(() => normalizeCompanyEmail('not-an-email')).toThrow(/Invalid email/);
    expect(() => normalizeCompanyEmail('')).toThrow(/required/);
  });
});

describe('deriveSourceIdFromEmail', () => {
  it('maps name@company.example → personal-<name>', () => {
    expect(deriveSourceIdFromEmail('alice-example@company.example')).toBe('personal-alice-c520842e9838e423');
    expect(deriveSourceIdFromEmail('alice@company.example')).toBe('personal-alice-70d354ebe5aeb03a');
  });

  it('is deterministic (one email always → one source), case-insensitive', () => {
    const a = deriveSourceIdFromEmail('Alice-Example@company.example');
    const b = deriveSourceIdFromEmail('alice-example@company.example');
    expect(a).toBe(b);
    expect(a).toBe('personal-alice-c520842e9838e423');
  });

  it('collision resistance: dotted and underscored locals receive different IDs', () => {
    // Dots and underscores must not collide after digesting the full email.
    expect(deriveSourceIdFromEmail('a.b@company.example')).not.toBe(
      deriveSourceIdFromEmail('a_b@company.example'),
    );
  });

  it('enforces the company domain before deriving', () => {
    expect(() => deriveSourceIdFromEmail('x@other.com')).toThrow(/not the company domain/);
  });
});

describe('SSH checkout host allowlist (Host key confinement)', () => {
  it('extracts the host from scp-style and ssh:// URLs', () => {
    expect(sshHostOf('git@gogs.internal.example:example-org/kb.git')).toBe('gogs.internal.example');
    expect(sshHostOf('ssh://git@gogs.internal.example:2222/example-org/kb.git')).toBe('gogs.internal.example');
  });

  it('allows only the company Gogs host', () => {
    expect(() => assertSshHostAllowed(`git@${GOGS_SSH_HOST}:example-org/kb.git`)).not.toThrow();
    try {
      assertSshHostAllowed('git@10.0.0.99:example-org/kb.git');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SshHostNotAllowedError);
      expect((e as Error).message).toMatch(/only allowed to the company Gogs host/);
    }
    expect(() => assertSshHostAllowed('git@github.com:a/b.git')).toThrow(/only allowed/);
  });
});

describe('Gogs owner verification (anti-IDOR gate)', () => {
  const BASE = 'http://gogs/api/v1';
  function mkFetch(opts: { user?: unknown; userStatus?: number; repoStatus?: number }) {
    const fetchFn = async (url: string) => {
      if (url.endsWith('/user')) {
        if (opts.userStatus) return new Response(JSON.stringify({}), { status: opts.userStatus });
        return new Response(JSON.stringify(opts.user ?? {}), { status: 200 });
      }
      return new Response('{}', { status: opts.repoStatus ?? 200 });
    };
    return fetchFn as typeof fetch;
  }

  it('requires a token', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'git@gogs.internal.example:example-org/bob.git', '', BASE, mkFetch({ user: {} }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('gogs_token_required');
  });

  it('rejects an invalid token (Gogs /user 401)', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'git@gogs.internal.example:example-org/bob.git', 'bad', BASE, mkFetch({ userStatus: 401 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('gogs_token_invalid');
  });

  it('rejects when the token owner email does not match the claimed email (Mallory→Bob)', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'git@gogs.internal.example:example-org/bob.git', 'mallory-token', BASE, mkFetch({ user: { login: 'mallory', email: 'mallory@company.example' } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('email_owner_mismatch');
  });


  it('does not let a matching login override an explicitly mismatched email', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'git@gogs.internal.example:example-org/bob.git', 'token', BASE, mkFetch({ user: { login: 'bob', email: 'mallory@company.example' } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('email_owner_mismatch');
  });

  it('allows the login fallback only when Gogs omits the email', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'git@gogs.internal.example:example-org/bob.git', 'token', BASE, mkFetch({ user: { login: 'bob' } }));
    expect(r.ok).toBe(true);
  });
  it('rejects when the token owner cannot read the repo', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'git@gogs.internal.example:example-org/bob.git', 'bob-token', BASE, mkFetch({ user: { login: 'bob', email: 'bob@company.example' }, repoStatus: 404 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('repo_not_owned');
  });


  it('accepts when the caller owns the email AND can read the repo (Bob→Bob)', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'git@gogs.internal.example:example-org/bob.git', 'bob-token', BASE, mkFetch({ user: { login: 'bob', email: 'bob@company.example' }, repoStatus: 200 }));
    expect(r.ok).toBe(true);
    expect(r.user).toBe('bob');
  });

  it('checks repository access for ssh:// URLs instead of silently skipping it', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'ssh://git@gogs.internal.example/example-org/bob.git', 'bob-token', BASE, mkFetch({ user: { login: 'bob', email: 'bob@company.example' }, repoStatus: 404 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('repo_not_owned');
  });
  it('rejects repo URL forms that cannot be bound to a Gogs API repository', async () => {
    const r = await verifyGogsOwner('bob@company.example', 'not-a-repo-url', 'bob-token', BASE, mkFetch({ user: { login: 'bob', email: 'bob@company.example' } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_repo_url');
  });
});

describe('Gogs repository URL parsing', () => {
  it('parses scp, ssh://, and https repository forms identically', () => {
    expect(gogsRepoRef('git@gogs.internal.example:example-org/bob.git')).toEqual({ owner: 'example-org', repo: 'bob' });
    expect(gogsRepoRef('ssh://git@gogs.internal.example/example-org/bob.git')).toEqual({ owner: 'example-org', repo: 'bob' });
    expect(gogsRepoRef('https://gogs.example/example-org/bob.git')).toEqual({ owner: 'example-org', repo: 'bob' });
  });
});

describe('existing personal-source ownership', () => {
  it('rejects a normalized source-id collision before minting credentials', async () => {
    const engine = {
      executeRaw: async () => [{
        id: 'personal-a-b',
        config: { owner_email: 'a.b@company.example' },
      }],
    } as unknown as BrainEngine;
    const sql = (() => Promise.resolve([])) as unknown as SqlQuery;

    await expect(provisionPersonalSource(engine, sql, {
      email: 'a_b@company.example',
    })).rejects.toBeInstanceOf(SourceOwnerMismatchError);
  });
});

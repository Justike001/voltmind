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
} from '../src/core/personal-provision.ts';

describe('normalizeCompanyEmail', () => {
  it('accepts a valid company email and lowercases it', () => {
    expect(normalizeCompanyEmail('Alice-Example@Company.Example')).toEqual({
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
    expect(deriveSourceIdFromEmail('alice-example@company.example')).toBe('personal-alice-example');
    expect(deriveSourceIdFromEmail('alice@company.example')).toBe('personal-alice');
  });

  it('is deterministic (one email always → one source), case-insensitive', () => {
    const a = deriveSourceIdFromEmail('Alice-Example@Company.Example');
    const b = deriveSourceIdFromEmail('alice-example@company.example');
    expect(a).toBe(b);
    expect(a).toBe('personal-alice-example');
  });

  it('dedups: two different spellings that normalize the same collapse to one id', () => {
    // Dots and underscores are normalized to the same dash -> same source.
    expect(deriveSourceIdFromEmail('a.b@company.example')).toBe(
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

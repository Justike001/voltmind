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
import { describe, it, expect, test } from 'bun:test';
import {
  COMPANY_DOMAIN,
  normalizeCompanyEmail,
  deriveSourceIdFromEmail,
  provisionPersonalSource,
  GOGS_SSH_HOST,
  sshHostOf,
  assertSshHostAllowed,
  SshHostNotAllowedError,
} from '../src/core/personal-provision.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

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
  it('maps company email to a valid, readable, collision-resistant source id', () => {
    const id = deriveSourceIdFromEmail('alice-example@company.example');
    expect(id).toMatch(/^personal-alice-[a-f0-9]{16}$/);
    expect(id.length).toBeLessThanOrEqual(32);
  });

  it('is deterministic (one email always → one source), case-insensitive', () => {
    const a = deriveSourceIdFromEmail('Alice-Example@Company.Example');
    const b = deriveSourceIdFromEmail('alice-example@company.example');
    expect(a).toBe(b);
  });

  it('keeps distinct emails isolated even when their readable slugs collide', () => {
    const ids = [
      deriveSourceIdFromEmail('a.b@company.example'),
      deriveSourceIdFromEmail('a_b@company.example'),
      deriveSourceIdFromEmail('a-b@company.example'),
      deriveSourceIdFromEmail('ab@company.example'),
      deriveSourceIdFromEmail('a+b@company.example'),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('enforces the company domain before deriving', () => {
    expect(() => deriveSourceIdFromEmail('x@other.com')).toThrow(/not the company domain/);
  });
});

test('provisioning keeps colliding readable slugs isolated and stores config as an object', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  try {
    const sql = sqlQueryForEngine(engine);
    const dotted = await provisionPersonalSource(engine, sql, {
      email: 'a.b@company.example',
    });
    const underscored = await provisionPersonalSource(engine, sql, {
      email: 'a_b@company.example',
    });

    expect(dotted.source_id).not.toBe(underscored.source_id);
    const rows = await engine.executeRaw<{
      id: string;
      config_type: string;
      owner_email: string | null;
    }>(
      `SELECT id, jsonb_typeof(config) AS config_type,
              config->>'owner_email' AS owner_email
         FROM sources
        WHERE id IN ($1, $2)
        ORDER BY id`,
      [dotted.source_id, underscored.source_id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.config_type === 'object')).toBe(true);
    expect(new Set(rows.map(row => row.owner_email))).toEqual(
      new Set(['a.b@company.example', 'a_b@company.example']),
    );

    // A pre-fix source may be adopted only by its persisted owner. Another
    // email whose lossy legacy slug collides must receive its own hashed id.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, $3::text::jsonb)`,
      [
        'personal-c-d',
        'legacy personal brain',
        JSON.stringify({ owner_email: 'c.d@company.example', federated: false }),
      ],
    );
    const legacyOwner = await provisionPersonalSource(engine, sql, {
      email: 'c.d@company.example',
    });
    expect(legacyOwner).toMatchObject({
      source_id: 'personal-c-d',
      alreadyProvisioned: true,
    });

    const collidingEmail = await provisionPersonalSource(engine, sql, {
      email: 'c_d@company.example',
    });
    expect(collidingEmail.source_id).not.toBe('personal-c-d');
    expect(collidingEmail.alreadyProvisioned).toBe(false);
  } finally {
    await engine.disconnect();
  }
}, 60_000);

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

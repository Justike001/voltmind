/**
 * Hermeticity test: every site that writes under `~/.voltmind` must honor
 * `VOLTMIND_HOME=<tmp>` and write under `<tmp>/.voltmind` instead of the developer's
 * real home.
 *
 * Why this exists: `src/core/config.ts::configDir()` already supports
 * `VOLTMIND_HOME` as a parent-dir override (returns `<override>/.voltmind`), but
 * historically many call sites built paths from `os.homedir()` directly,
 * bypassing the override. The hermeticity migration migrated every write-side
 * caller to `voltmindPath(...)`. This test is the regression gate.
 *
 * Scope: write-isolation only. Read-side host detection in
 * `src/commands/init.ts` (reading `~/.claude`, `~/.openclaw`, etc. for module
 * fingerprinting) is the documented v1 caveat and is NOT asserted here.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

// Save original env so we don't leak between tests.
const ORIG_VOLTMIND_HOME = process.env.VOLTMIND_HOME;

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'voltmind-home-isolation-'));
}

describe('VOLTMIND_HOME write-side isolation', () => {
  test('configDir() returns <VOLTMIND_HOME>/.voltmind when override is set', async () => {
    const tmp = fresh();
    process.env.VOLTMIND_HOME = tmp;
    try {
      const { configDir, voltmindPath } = await import('../src/core/config.ts');
      expect(configDir()).toBe(join(tmp, '.voltmind'));
      expect(voltmindPath('foo', 'bar.json')).toBe(join(tmp, '.voltmind', 'foo', 'bar.json'));
    } finally {
      process.env.VOLTMIND_HOME = ORIG_VOLTMIND_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('configDir() falls back to homedir when VOLTMIND_HOME unset', async () => {
    delete process.env.VOLTMIND_HOME;
    try {
      const { configDir } = await import('../src/core/config.ts');
      // Contract: when VOLTMIND_HOME is unset, configDir() === os.homedir()/.voltmind.
      // Asserting against os.homedir() (rather than a "not /tmp/" sentinel) keeps
      // this test correct under safety wrappers that redirect HOME=/tmp/... — the
      // behavior we care about is that the fallback path equals homedir().
      expect(configDir()).toBe(join(homedir(), '.voltmind'));
    } finally {
      if (ORIG_VOLTMIND_HOME !== undefined) process.env.VOLTMIND_HOME = ORIG_VOLTMIND_HOME;
    }
  });

  test('rejects relative VOLTMIND_HOME', async () => {
    process.env.VOLTMIND_HOME = 'relative/path';
    try {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/absolute path/);
    } finally {
      process.env.VOLTMIND_HOME = ORIG_VOLTMIND_HOME;
    }
  });

  test("rejects VOLTMIND_HOME containing '..' segments", async () => {
    process.env.VOLTMIND_HOME = '/tmp/foo/../bar';
    try {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/'\.\.' segments/);
    } finally {
      process.env.VOLTMIND_HOME = ORIG_VOLTMIND_HOME;
    }
  });

  test('saveConfig/loadConfig honor VOLTMIND_HOME', async () => {
    const tmp = fresh();
    process.env.VOLTMIND_HOME = tmp;
    try {
      const { saveConfig, loadConfig } = await import('../src/core/config.ts');
      const cfg = { engine: 'pglite' as const, database_path: join(tmp, '.voltmind', 'brain.pglite') };
      saveConfig(cfg);
      // Config file should exist under the override, NOT under real ~/.voltmind.
      expect(existsSync(join(tmp, '.voltmind', 'config.json'))).toBe(true);

      // Round-trip: loadConfig() finds it back via the override.
      const loaded = loadConfig();
      expect(loaded?.engine).toBe('pglite');
      expect(loaded?.database_path).toBe(cfg.database_path);
    } finally {
      process.env.VOLTMIND_HOME = ORIG_VOLTMIND_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('integrity, sync-failures, integrations heartbeat resolve under VOLTMIND_HOME', async () => {
    const tmp = fresh();
    process.env.VOLTMIND_HOME = tmp;
    try {
      const { voltmindPath } = await import('../src/core/config.ts');
      // Spot-check a representative set of paths used across the migrated sites.
      const paths = [
        voltmindPath('integrity-review.md'),                       // src/commands/integrity.ts
        voltmindPath('sync-failures.jsonl'),                       // src/core/sync.ts
        voltmindPath('integrations', 'recipe-x'),                  // src/commands/integrations.ts
        voltmindPath('migrate-manifest.json'),                     // src/commands/migrate-engine.ts
        voltmindPath('import-checkpoint.json'),                    // src/commands/import.ts
        voltmindPath('migrations', 'v0_13_1-rollback.jsonl'),      // src/commands/migrations/v0_13_1.ts
        voltmindPath('migrations', 'pending-host-work.jsonl'),     // src/commands/migrations/v0_14_0.ts
        voltmindPath('audit'),                                     // shell-audit / backpressure-audit
        voltmindPath('cycle.lock'),                                // src/core/cycle.ts
        voltmindPath('fail-improve'),                              // src/core/fail-improve.ts
        voltmindPath('validator-lint.jsonl'),                      // src/core/output/post-write.ts
        voltmindPath('brain.pglite'),                              // init pglite default
      ];
      for (const p of paths) {
        expect(p.startsWith(join(tmp, '.voltmind'))).toBe(true);
      }
    } finally {
      process.env.VOLTMIND_HOME = ORIG_VOLTMIND_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('VOLTMIND_AUDIT_DIR override still wins over VOLTMIND_HOME', async () => {
    const tmp = fresh();
    const auditTmp = fresh();
    process.env.VOLTMIND_HOME = tmp;
    process.env.VOLTMIND_AUDIT_DIR = auditTmp;
    try {
      const { resolveAuditDir } = await import('../src/core/minions/handlers/shell-audit.ts');
      // Per the docstring: VOLTMIND_AUDIT_DIR is the explicit override and wins.
      expect(resolveAuditDir()).toBe(auditTmp);
    } finally {
      process.env.VOLTMIND_HOME = ORIG_VOLTMIND_HOME;
      delete process.env.VOLTMIND_AUDIT_DIR;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(auditTmp, { recursive: true, force: true });
    }
  });
});

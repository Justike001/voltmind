/**
 * Unit tests for the runtime env-file loader (spec §5 / §16.1).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseEnvFile,
  loadRuntimeEnvFile,
  ENV_FILE_ALLOWLIST,
  ENV_FILE_BLOCKLIST,
} from '../src/core/autopilot/env-file.ts';

let tmp: string;
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'voltmind-envfile-'));
  envSnapshot.VOLTMIND_DATABASE_URL = process.env.VOLTMIND_DATABASE_URL;
  envSnapshot.PATH = process.env.PATH;
  envSnapshot.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('parseEnvFile', () => {
  test('parses KEY=VALUE lines', () => {
    const out = parseEnvFile('FOO=bar\nBAZ=qux\n', 'test');
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('ignores comments and blank lines', () => {
    const out = parseEnvFile('# comment\n\nFOO=bar\n', 'test');
    expect(out).toEqual({ FOO: 'bar' });
  });

  test('strips optional export prefix and surrounding quotes', () => {
    const out = parseEnvFile('export FOO="bar"\nBAZ=\'qux\'\n', 'test');
    expect(out).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('throws on malformed line (no =)', () => {
    expect(() => parseEnvFile('NOTKEYVAL\n', 'test')).toThrow(/Malformed/);
  });
});

describe('loadRuntimeEnvFile — allowlist enforcement', () => {
  test('sets allowlisted VOLTMIND_DATABASE_URL', () => {
    const p = join(tmp, 'env');
    writeFileSync(p, 'VOLTMIND_DATABASE_URL=postgres://localhost/test\n');
    const res = loadRuntimeEnvFile(p);
    expect(res.set.VOLTMIND_DATABASE_URL).toBe('postgres://localhost/test');
    expect(process.env.VOLTMIND_DATABASE_URL).toBe('postgres://localhost/test');
  });

  test('refuses to override blocklisted PATH', () => {
    const p = join(tmp, 'env');
    const origPath = process.env.PATH;
    writeFileSync(p, 'PATH=/evil\n');
    const res = loadRuntimeEnvFile(p);
    expect(res.skipped.some((s) => s.includes('PATH'))).toBe(true);
    expect(process.env.PATH).toBe(origPath);
  });

  test('skips variables not on the allowlist', () => {
    const p = join(tmp, 'env');
    writeFileSync(p, 'RANDOM_THING=value\nANTHROPIC_API_KEY=sk-test\n');
    const res = loadRuntimeEnvFile(p);
    expect(res.set.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(res.skipped.some((s) => s.includes('RANDOM_THING'))).toBe(true);
  });

  test('throws when file does not exist', () => {
    expect(() => loadRuntimeEnvFile(join(tmp, 'nope'))).toThrow(/not found/);
  });

  test('ENV_FILE_BLOCKLIST contains dangerous system vars', () => {
    expect(ENV_FILE_BLOCKLIST).toContain('PATH');
    expect(ENV_FILE_BLOCKLIST).toContain('ComSpec');
    expect(ENV_FILE_BLOCKLIST).toContain('SystemRoot');
    expect(ENV_FILE_BLOCKLIST).toContain('WINDIR');
    expect(ENV_FILE_BLOCKLIST).toContain('TEMP');
    expect(ENV_FILE_BLOCKLIST).toContain('USERPROFILE');
  });

  test('ENV_FILE_ALLOWLIST contains VoltMind + Postgres + Supabase + provider keys', () => {
    expect(ENV_FILE_ALLOWLIST).toContain('VOLTMIND_DATABASE_URL');
    expect(ENV_FILE_ALLOWLIST).toContain('DATABASE_URL');
    expect(ENV_FILE_ALLOWLIST).toContain('SUPABASE_DB_URL');
    expect(ENV_FILE_ALLOWLIST).toContain('ANTHROPIC_API_KEY');
    expect(ENV_FILE_ALLOWLIST).toContain('OPENAI_API_KEY');
  });
});

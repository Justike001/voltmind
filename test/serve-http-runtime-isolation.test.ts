import { describe, expect, test } from 'bun:test';
import { assertHttpRuntimeIsolation } from '../src/commands/serve-http.ts';

describe('HTTP Host runtime isolation', () => {
  test('refuses PGLite before it can serve remote callers', async () => {
    await expect(assertHttpRuntimeIsolation({
      kind: 'pglite',
      executeRaw: async () => [],
    } as never)).rejects.toThrow(/PGLite.*trusted local CLI\/stdio/i);
  });

  test('refuses a PostgreSQL role that can bypass RLS', async () => {
    await expect(assertHttpRuntimeIsolation({
      kind: 'postgres',
      executeRaw: async () => [{ is_superuser: false, bypass_rls: true, oauth_control_plane: true }],
    } as never)).rejects.toThrow(/NOSUPERUSER and NOBYPASSRLS/);
  });

  test('refuses a role without OAuth control-plane access', async () => {
    await expect(assertHttpRuntimeIsolation({
      kind: 'postgres',
      executeRaw: async () => [{ is_superuser: false, bypass_rls: false, oauth_control_plane: false }],
    } as never)).rejects.toThrow(/lacks voltmind_oauth_runtime/);
  });

  test('accepts a restricted PostgreSQL runtime role', async () => {
    await expect(assertHttpRuntimeIsolation({
      kind: 'postgres',
      executeRaw: async () => [{ is_superuser: false, bypass_rls: false, oauth_control_plane: true }],
    } as never)).resolves.toBeUndefined();
  });
});

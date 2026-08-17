import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const restrictedUrl = process.env.VOLTMIND_RESTRICTED_DATABASE_URL;
const run = restrictedUrl ? describe : describe.skip;
let engine: PostgresEngine;
const suffix = `${process.pid}-${Date.now()}`;
const slug = `test/restricted-scope-${suffix}`;
const sourceA = `scope-a-${suffix}`;
const sourceB = `scope-b-${suffix}`;

run('restricted Postgres source scope (VOLTMIND_RESTRICTED_DATABASE_URL)', () => {
  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: restrictedUrl! });
    const roles = await engine.executeRaw<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(roles[0]?.rolbypassrls).toBe(false);

    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, '{}'::jsonb), ($2, $2, '{}'::jsonb)`,
      [sourceA, sourceB],
    );
    for (const sourceId of [sourceA, sourceB]) {
      await engine.transaction(async (tx) => {
        await tx.setSourceScope(sourceId);
        await tx.putPage(slug, {
          type: 'note',
          title: sourceId,
          compiled_truth: `content-${sourceId}`,
        }, { sourceId });
      });
    }
  });

  afterAll(async () => {
    if (!engine) return;
    for (const sourceId of [sourceA, sourceB]) {
      await engine.transaction(async (tx) => {
        await tx.setSourceScope(sourceId);
        await tx.deletePage(slug, { sourceId });
      });
    }
    await engine.executeRaw(`DELETE FROM sources WHERE id IN ($1, $2)`, [sourceA, sourceB]);
    await engine.disconnect();
  });

  test('positive and negative isolation match the scoped source', async () => {
    await engine.transaction(async (tx) => {
      await tx.setSourceScope(sourceA);
      expect((await tx.getPage(slug, { sourceId: sourceA }))?.title).toBe(sourceA);
      expect(await tx.getPage(slug, { sourceId: sourceB })).toBeNull();
    });
    await engine.transaction(async (tx) => {
      await tx.setSourceScope(sourceB);
      expect((await tx.getPage(slug, { sourceId: sourceB }))?.title).toBe(sourceB);
      expect(await tx.getPage(slug, { sourceId: sourceA })).toBeNull();
    });
  });
});

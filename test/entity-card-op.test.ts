import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice-example', {
    type: 'person', title: 'Alice Example',
    compiled_truth: 'Alice leads the platform team.',
    frontmatter: { aliases: ['Alice'] },
  });
  await engine.putPage('companies/acme-example', {
    type: 'company', title: 'Acme Example', compiled_truth: 'A software company.',
  });
  await engine.putPage('meetings/platform-review', {
    type: 'meeting', title: 'Platform Review', compiled_truth: 'Alice attended.',
  });
  await engine.addLink('people/alice-example', 'companies/acme-example', 'team lead', 'works_at', 'manual');
  await engine.addLink('meetings/platform-review', 'people/alice-example', 'attendee', 'attended', 'manual');
  await engine.addTimelineEntry('people/alice-example', { date: '2026-09-01', summary: 'Led platform review' });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('entity operation', () => {
  test('returns a deterministic card with scoped edges and timeline', async () => {
    const context = { engine, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const result = await operationsByName.entity.handler(context, { name: 'people/alice-example' }) as any;
    expect(result.found).toBe(true);
    expect(result.card.entity.slug).toBe('people/alice-example');
    expect(result.card.aka).toContain('Alice');
    expect(result.card.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'companies/acme-example', direction: 'out' }),
      expect.objectContaining({ slug: 'meetings/platform-review', direction: 'in' }),
    ]));
    expect(result.card.backlink_count).toBe(1);
    expect(result.card.open_threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'recent_event', text: 'Led platform review' }),
    ]));
  }, 30_000);

  test('misses return suggestions instead of throwing', async () => {
    const context = { engine, remote: true, sourceId: 'default' } as unknown as OperationContext;
    const result = await operationsByName.entity.handler(context, { name: 'nobody-unindexed' }) as any;
    expect(result.found).toBe(false);
    expect(Array.isArray(result.suggestions)).toBe(true);
  });
});

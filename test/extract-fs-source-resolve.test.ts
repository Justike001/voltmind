/**
 * v0.41.x — fs-source extract silent no-op under a non-'default' source.
 *
 * Reported bug: `voltmind extract timeline --source fs` (and links / all,
 * plus the sync-cycle extract phase) reported created:0 forever whenever the
 * pages lived under a source other than 'default' (e.g.
 * 'personal-alice-example'). Root cause:
 *
 *   - The fs walkers push entries WITHOUT source_id when no --source-id is
 *     passed, so addLinksBatch / addTimelineEntriesBatch JOIN pages against
 *     source_id='default'.
 *   - Every JOIN matches nothing when the pages are under another source,
 *     so the batch silently inserts 0 rows and reports "created 0".
 *
 * Fix: when --source-id is omitted, `runExtractCore` resolves the source that
 * owns the walked dir via the canonical resolveSourceWithTier chain and
 * threads it into the fs extractors, so the walk lands on the right source.
 *
 * Hermetic via PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll(): Promise<void> {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
}

beforeEach(async () => {
  await truncateAll();
  brainDir = mkdtempSync(join(tmpdir(), 'voltmind-extract-src-'));
}, 15_000);

function writeFile(rel: string, content: string) {
  const full = join(brainDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function registerSource(id: string, localPath: string) {
  return (engine as any).db.exec(
    `INSERT INTO sources (id, name, local_path) VALUES ('${id}', '${id}', '${localPath.replace(/'/g, "''")}')
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
  );
}

function quiet(): void {
  (console as any).log = () => {};
}

describe('fs-source extract resolves a non-default source instead of silently 0-row', () => {
  test('timeline entries land on a non-default source with no --source-id', async () => {
    await registerSource('personal-alice-example', brainDir);
    // Page lives under the non-default source, exactly the reported setup.
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice', compiled_truth: '', timeline: '',
    }, { sourceId: 'personal-alice-example' });

    writeFile('people/alice.md', `---
title: Alice
---

## Timeline

- **2024-01-15** | source — Founded NovaMind
- **2024-06-01** | source — Raised seed round
`);

    quiet();
    await runExtract(engine, ['timeline', '--dir', brainDir]);

    const after = await engine.getTimeline('people/alice', { sourceId: 'personal-alice-example' });
    // Regression: this used to be 0 because the batch JOINed against 'default'.
    expect(after.length).toBe(2);

    // And no timeline entries were mis-routed to the (empty) 'default' source.
    const defaultRows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
        WHERE p.source_id = 'default'`,
    );
    expect(Number(defaultRows[0]?.n ?? 0)).toBe(0);
  });

  test('links land on a non-default source with no --source-id', async () => {
    await registerSource('personal-alice-example', brainDir);
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' }, { sourceId: 'personal-alice-example' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', timeline: '' }, { sourceId: 'personal-alice-example' });

    writeFile('people/alice.md', '---\ntitle: Alice\n---\n\n[Bob](../people/bob.md) is a friend.\n');
    writeFile('people/bob.md', '---\ntitle: Bob\n---\n');

    quiet();
    await runExtract(engine, ['links', '--dir', brainDir]);

    const links = await engine.getLinks('people/alice', { sourceId: 'personal-alice-example' });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]).toMatchObject({ to_slug: 'people/bob' });

    const defaultPageId = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links l
         JOIN pages f ON f.id = l.from_page_id
        WHERE f.source_id = 'default'`,
    );
    expect(Number(defaultPageId[0]?.n ?? 0)).toBe(0);
  });

  test('explicit --source-id still wins over dir resolution', async () => {
    // A DIFFERENT source owns this dir, but an explicit other source is
    // requested. Resolution must use the flag, not the dir.
    await registerSource('personal-alice-example', brainDir);
    await registerSource('other', join(tmpdir(), 'voltmind-extract-nowhere-'));

    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' }, { sourceId: 'personal-alice-example' });
    writeFile('people/alice.md', `---
title: Alice
---

## Timeline

- **2024-01-15** | source — Founded NovaMind
`);

    quiet();
    await runExtract(engine, ['timeline', '--dir', brainDir, '--source-id', 'personal-alice-example']);

    const after = await engine.getTimeline('people/alice', { sourceId: 'personal-alice-example' });
    expect(after.length).toBe(1);
  });
});

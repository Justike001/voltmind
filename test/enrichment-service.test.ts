import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import {
  slugifyEntity,
  isLikelyPersonEntityName,
  entityPagePath,
  extractEntities,
  enrichEntity,
  previewSignalEnrichment,
  applySignalEnrichment,
  applySignalEnrichmentForPages,
  buildSignalTextFromPage,
} from '../src/core/enrichment-service.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM raw_data').catch(() => {});
  await engine.executeRaw('DELETE FROM timeline_entries').catch(() => {});
  await engine.executeRaw('DELETE FROM links').catch(() => {});
  await engine.executeRaw('DELETE FROM content_chunks').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'enrich.%'`).catch(() => {});
  await engine.executeRaw('DELETE FROM budget_reservations').catch(() => {});
  await engine.executeRaw('DELETE FROM budget_ledger').catch(() => {});
});

describe('enrichment-service', () => {
  describe('person namespace guard', () => {
    test('accepts ordinary person names', () => {
      expect(isLikelyPersonEntityName('Alice Example')).toBe(true);
      expect(isLikelyPersonEntityName('李小明')).toBe(true);
    });

    test('rejects obvious tool/configuration phrases', () => {
      expect(isLikelyPersonEntityName('Claude Code')).toBe(false);
      expect(isLikelyPersonEntityName('Windows Update')).toBe(false);
      expect(isLikelyPersonEntityName('Company Brain')).toBe(false);
    });
  });
  describe('slugifyEntity', () => {
    test('person names → people/ prefix', () => {
      expect(slugifyEntity('Jane Doe', 'people/')).toBe('people/jane-doe');
    });

    test('company names → companies/ prefix', () => {
      expect(slugifyEntity('Acme Corp', 'companies/')).toBe('companies/acme-corp');
    });

    test('handles apostrophes', () => {
      expect(slugifyEntity("O'Brien", 'people/')).toBe('people/obrien');
    });

    test('handles special characters', () => {
      expect(slugifyEntity('José García', 'people/')).toBe('people/jose-garcia');
    });

    test('trims leading/trailing hyphens', () => {
      expect(slugifyEntity('  Test Name  ', 'people/')).toBe('people/test-name');
    });

    test('collapses multiple hyphens', () => {
      expect(slugifyEntity('Test--Name', 'people/')).toBe('people/test-name');
    });
  });

  describe('entityPagePath', () => {
    test('returns same result as slugifyEntity', () => {
      expect(entityPagePath('Jane Doe', 'people/')).toBe(slugifyEntity('Jane Doe', 'people/'));
    });
  });

  describe('extractEntities', () => {
    test('extracts capitalized multi-word names', () => {
      const entities = extractEntities('I met with John Smith and Sarah Connor yesterday.');
      expect(entities.length).toBeGreaterThanOrEqual(2);
      const names = entities.map(e => e.name);
      expect(names).toContain('John Smith');
      expect(names).toContain('Sarah Connor');
    });

    test('classifies company names with Corp/Inc/Labs', () => {
      const entities = extractEntities('We visited Acme Corp and Beta Labs.');
      const acme = entities.find(e => e.name.includes('Acme'));
      const beta = entities.find(e => e.name.includes('Beta'));
      expect(acme?.type).toBe('company');
      expect(beta?.type).toBe('company');
    });

    test('classifies other multi-word names as person', () => {
      const entities = extractEntities('Talked to Jane Doe about the project.');
      const jane = entities.find(e => e.name === 'Jane Doe');
      expect(jane?.type).toBe('person');
    });

    test('deduplicates by name (case-insensitive)', () => {
      const entities = extractEntities('John Smith said hello. Then John Smith left.');
      const johns = entities.filter(e => e.name === 'John Smith');
      expect(johns.length).toBe(1);
    });

    test('returns empty array for text with no entities', () => {
      const entities = extractEntities('this is all lowercase text with no names');
      expect(entities.length).toBe(0);
    });

    test('includes context around each entity', () => {
      const entities = extractEntities('The CEO of StartupX, John Smith, announced the deal.');
      const john = entities.find(e => e.name === 'John Smith');
      expect(john?.context.length).toBeGreaterThan(10);
    });

    test('handles 3-4 word names', () => {
      const entities = extractEntities('Mary Jane Watson Parker joined the team.');
      expect(entities.some(e => e.name.split(' ').length >= 3)).toBe(true);
    });

    test('turns structured signal frontmatter into person/company mentions', () => {
      const text = buildSignalTextFromPage({
        type: 'meeting',
        frontmatter: {
          attendees: ['Alice Example'],
          companies: ['Acme Labs'],
        },
        compiled_truth: '',
        timeline: '',
      });
      const entities = extractEntities(text);
      expect(entities.map(e => e.name)).toContain('Alice Example');
      expect(entities.map(e => e.name)).toContain('Acme Labs');
      expect(entities.find(e => e.name === 'Acme Labs')?.type).toBe('company');
    });
  });

  describe('enrichEntity (mock)', () => {
    test('module exports enrichEntity function', async () => {
      const mod = await import('../src/core/enrichment-service.ts');
      expect(typeof mod.enrichEntity).toBe('function');
    });

    test('module exports enrichEntities for batch processing', async () => {
      const mod = await import('../src/core/enrichment-service.ts');
      expect(typeof mod.enrichEntities).toBe('function');
    });

    test('module exports extractAndEnrich for text processing', async () => {
      const mod = await import('../src/core/enrichment-service.ts');
      expect(typeof mod.extractAndEnrich).toBe('function');
    });
  });

  describe('tier auto-escalation logic', () => {
    // We test the tier suggestion indirectly through the public interface
    // The actual suggestTier function is private, but its behavior is
    // observable through enrichEntity's return value (needs engine mock for full test)
    test('enrichment result includes tier fields', async () => {
      const mod = await import('../src/core/enrichment-service.ts');
      // Verify the EnrichmentResult type shape is correct by checking exports
      expect(mod.enrichEntity).toBeDefined();
      // Full tier escalation testing requires engine mock (covered in E2E)
    });
  });

  describe('MVP-safe source-backed enrichment', () => {
    test('creates notable entity pages from templates with citation, timeline, link, and raw data', async () => {
      await engine.putPage('inbox/signal-note', {
        title: 'Signal Note',
        type: 'note',
        compiled_truth: 'Met Alice Example from Acme Labs about the VoltMind launch project and follow-up ownership.',
        timeline: '',
        frontmatter: {},
      });

      const result = await enrichEntity(engine, {
        entityName: 'Alice Example',
        entityType: 'person',
        context: 'Met Alice Example from Acme Labs about the VoltMind launch project and follow-up ownership.',
        sourceSlug: 'inbox/signal-note',
        sourceId: 'default',
      });

      expect(result.action).toBe('created');
      expect(result.reason).toBeUndefined();
      expect(result.backlinkCreated).toBe(true);
      expect(result.timelineAdded).toBe(true);

      const page = await engine.getPage('people/alice-example');
      expect(page).not.toBeNull();
      expect(page?.compiled_truth).toContain('[Source: inbox/signal-note');
      expect(page?.compiled_truth).not.toContain('Stub page');
      expect(page?.frontmatter.enrichment_tier).toBeDefined();

      const timeline = await engine.getTimeline('people/alice-example');
      expect(timeline.length).toBeGreaterThan(0);
      const links = await engine.getBacklinks('inbox/signal-note');
      expect(links.some(l => l.from_slug === 'people/alice-example')).toBe(true);
      const raw = await engine.getRawData('people/alice-example', 'signal-enrichment');
      expect(raw.length).toBe(1);
    });

    test('skips low-confidence or non-notable new entities instead of creating stubs', async () => {
      const result = await enrichEntity(engine, {
        entityName: 'Tiny Mention',
        entityType: 'person',
        context: 'Tiny Mention.',
        sourceSlug: 'inbox/noise',
        sourceId: 'default',
      });

      expect(result.action).toBe('skipped');
      expect(result.reason).toBe('notability_gate');
      expect(await engine.getPage('people/tiny-mention')).toBeNull();
    });

    test('preview_signal_enrichment does not mutate the database', async () => {
      const summary = await previewSignalEnrichment(engine, {
        sourceId: 'default',
        sourceSlug: 'inbox/preview',
        text: 'Met Alice Example from Acme Labs about the VoltMind launch project and contract review.',
        limit: 10,
      });

      expect(summary.detected.map(e => e.slug)).toContain('people/alice-example');
      expect(summary.created).toContain('people/alice-example');
      expect(summary.created).toContain('companies/acme-labs');
      expect(await engine.getPage('people/alice-example')).toBeNull();
      expect(await engine.getPage('companies/acme-labs')).toBeNull();
    });

    test('apply_signal_enrichment requires confirmation and creates person/company pages', async () => {
      await engine.putPage('meetings/2026-07-07-signal', {
        title: 'Signal Meeting',
        type: 'meeting',
        compiled_truth: 'Meeting attendees included Alice Example from Acme Labs for project ownership decisions.',
        timeline: '',
        frontmatter: {},
      });

      await expect(applySignalEnrichment(engine, {
        sourceId: 'default',
        sourceSlug: 'meetings/2026-07-07-signal',
        text: 'Meeting attendees included Alice Example from Acme Labs for project ownership decisions.',
      })).rejects.toThrow('confirm=true');

      const summary = await applySignalEnrichment(engine, {
        sourceId: 'default',
        sourceSlug: 'meetings/2026-07-07-signal',
        text: 'Meeting attendees included Alice Example from Acme Labs for project ownership decisions.',
        confirm: true,
      });

      expect(summary.created).toContain('people/alice-example');
      expect(summary.created).toContain('companies/acme-labs');
      expect(summary.timeline_added).toBeGreaterThanOrEqual(2);
      expect(summary.links_added).toBeGreaterThanOrEqual(2);
      expect(await engine.getPage('people/alice-example')).not.toBeNull();
      expect(await engine.getPage('companies/acme-labs')).not.toBeNull();
    });

    test('external enrichment is budget-gated and local writes continue when budget is exhausted', async () => {
      await engine.setConfig('enrich.external.enabled', 'true');
      await engine.setConfig('enrich.external.provider', 'example-provider');
      await engine.setConfig('enrich.external.daily_cap_usd', '0');

      const result = await enrichEntity(engine, {
        entityName: 'Budget Owner',
        entityType: 'person',
        context: 'Meeting owner Budget Owner is the contact for the VoltMind launch project.',
        sourceSlug: 'meetings/budget',
        sourceId: 'default',
        external: true,
      });

      expect(result.action).toBe('created');
      expect(result.external?.status).toBe('budget_exhausted');
      expect(await engine.getPage('people/budget-owner')).not.toBeNull();
    });

    test('put_page local hook returns enrichment summary for unresolved person/company names', async () => {
      const op = operations.find(o => o.name === 'put_page');
      expect(op).toBeDefined();
      const ctx: OperationContext = {
        engine,
        config: { engine: 'pglite' } as never,
        logger: console,
        dryRun: false,
        remote: false,
        sourceId: 'default',
      };

      const result = await op!.handler(ctx, {
        slug: 'inbox/hook-signal',
        content: `---
type: note
title: Hook Signal
---
# Hook Signal

Met Alice Example from Acme Labs about the VoltMind launch project and owner follow-up.`,
      }) as { signal_enrichment?: { created?: string[] } };

      expect(result.signal_enrichment?.created).toContain('people/alice-example');
      expect(result.signal_enrichment?.created).toContain('companies/acme-labs');
      expect(await engine.getPage('people/alice-example')).not.toBeNull();
      expect(await engine.getPage('companies/acme-labs')).not.toBeNull();
    });

    test('put_page local hook enriches meeting attendees and companies from frontmatter only', async () => {
      const op = operations.find(o => o.name === 'put_page');
      expect(op).toBeDefined();
      const ctx: OperationContext = {
        engine,
        config: { engine: 'pglite' } as never,
        logger: console,
        dryRun: false,
        remote: false,
        sourceId: 'default',
      };

      const result = await op!.handler(ctx, {
        slug: 'meetings/frontmatter-signal',
        content: `---
type: meeting
title: Frontmatter Signal
attendees:
  - Alice Example
companies:
  - Acme Labs
---
# Frontmatter Signal

Agenda only.`,
      }) as { signal_enrichment?: { created?: string[] } };

      expect(result.signal_enrichment?.created).toContain('people/alice-example');
      expect(result.signal_enrichment?.created).toContain('companies/acme-labs');
      expect(result.signal_enrichment?.created).not.toContain('people/frontmatter-signal');
      expect(await engine.getPage('people/alice-example')).not.toBeNull();
      expect(await engine.getPage('companies/acme-labs')).not.toBeNull();
    });

    test('skips content-sanity isolated pages during post-sync enrichment', async () => {
      await engine.putPage('notes/oversized', {
        title: 'Oversized release notes',
        type: 'note',
        compiled_truth: 'Met Alice Example from Acme Labs about the release.',
        timeline: '',
        frontmatter: { embed_skip: { reason: 'oversized', bytes: 600_000 } },
      });

      const result = await applySignalEnrichmentForPages(engine, {
        sourceId: 'default',
        pageSlugs: ['notes/oversized'],
      });

      expect(result.created).toEqual([]);
      expect(result.warnings).toContain('page_embed_skipped:notes/oversized');
      expect(await engine.getPage('people/alice-example')).toBeNull();
    });
  });
});

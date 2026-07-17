// Schema-pack path inference. Every result must come from the supplied pack;
// there is no hardcoded fallback table in markdown.ts.

import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';
import { inferTypeFromPack } from '../src/core/markdown.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { join } from 'node:path';

const VOLTMIND_BASE_PATH = join(import.meta.dir, '../src/core/schema-pack/base/voltmind-base.yaml');

// Representative paths covering every voltmind-base path-prefix entry.
const PARITY_FIXTURES: ReadonlyArray<{ path: string; expected: string; reason: string }> = [
  { path: 'people/alice.md', expected: 'person', reason: 'people/ prefix' },
  { path: 'companies/acme.md', expected: 'company', reason: 'companies/ prefix' },
  { path: 'deals/acme-seed.md', expected: 'deal', reason: 'deals/ prefix' },
  { path: 'yc/w24.md', expected: 'yc', reason: 'yc/ prefix' },
  { path: 'civic/policy/sf.md', expected: 'civic', reason: 'civic/ prefix' },
  { path: 'projects/blog/index.md', expected: 'project', reason: 'projects/ prefix' },
  { path: 'wiki/concepts/inversion.md', expected: 'concept', reason: 'wiki/concepts/ prefix' },
  { path: 'sources/article.md', expected: 'source', reason: 'sources/ prefix' },
  { path: 'media/books/x.md', expected: 'media', reason: 'media/ prefix' },
  { path: 'writing/essay.md', expected: 'writing', reason: 'writing/ prefix' },
  { path: 'wiki/analysis/foo.md', expected: 'analysis', reason: 'wiki/analysis/ wins over wiki/' },
  { path: 'wiki/guides/setup.md', expected: 'guide', reason: 'wiki/guides/ prefix' },
  { path: 'wiki/hardware/x.md', expected: 'hardware', reason: 'wiki/hardware/ prefix' },
  { path: 'wiki/architecture/x.md', expected: 'architecture', reason: 'wiki/architecture/ prefix' },
  { path: 'meetings/2026-04-03.md', expected: 'meeting', reason: 'meetings/ prefix' },
  { path: 'notes/random.md', expected: 'note', reason: 'notes/ prefix' },
  { path: 'emails/em-0001.md', expected: 'email', reason: 'emails/ prefix' },
  { path: 'slack/sl-0037.md', expected: 'slack', reason: 'slack/ prefix' },
  { path: 'cal/2026-05-20.md', expected: 'calendar-event', reason: 'cal/ prefix' },
  // Stronger-signal wins: writing/ inside projects/
  { path: 'projects/blog/writing/essay.md', expected: 'project', reason: 'root-relative prefixes do not match nested directories' },
  // Fallback: paths not matching any prefix
  { path: 'random/path.md', expected: 'unclassified', reason: 'no prefix match remains explicit' },
];

describe('inferTypeFromPack', () => {
  test('each known path maps through the supplied pack', () => {
    const pack = loadPackFromFile(VOLTMIND_BASE_PATH);
    for (const { path, expected, reason } of PARITY_FIXTURES) {
      const actual = inferTypeFromPack(path, pack);
      const md = `# ${path}\nbody`;
      const parsed = parseMarkdown(md, path, { activePack: pack });
      expect(parsed.type).toBe(expected);
      expect(actual).toBe(expected);
      // Sanity: the reason annotation isn't a test assertion but documents
      // why each fixture exists. Surface unused-variable lint via toBeTruthy.
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  test('user pack can define its own paths', () => {
    // Synthetic pack declaring a new type with its own prefix.
    const pack = parseSchemaPackManifest({
      api_version: 'voltmind-schema-pack-v1',
      name: 'research-test',
      version: '0.1.0',
      extends: null,
      page_types: [
        { name: 'researcher', primitive: 'entity', path_prefixes: ['researchers/'], aliases: [], extractable: true, expert_routing: true },
        { name: 'paper', primitive: 'media', path_prefixes: ['papers/'], aliases: [], extractable: false, expert_routing: false },
      ],
      link_types: [],
    });
    expect(inferTypeFromPack('researchers/alice.md', pack)).toBe('researcher');
    expect(inferTypeFromPack('papers/smith-2024.md', pack)).toBe('paper');
    expect(inferTypeFromPack('people/alice.md', pack)).toBe('unclassified');
  });

  test('pack with empty page_types remains unclassified', () => {
    const emptyPack = parseSchemaPackManifest({
      api_version: 'voltmind-schema-pack-v1',
      name: 'empty',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
    });
    expect(inferTypeFromPack('people/alice.md', emptyPack)).toBe('unclassified');
    expect(inferTypeFromPack('media/foo.md', emptyPack)).toBe('unclassified');
  });

  test('undefined filePath remains unclassified', () => {
    const pack = loadPackFromFile(VOLTMIND_BASE_PATH);
    expect(inferTypeFromPack(undefined, pack)).toBe('unclassified');
  });

  test('case-insensitive matching', () => {
    const pack = loadPackFromFile(VOLTMIND_BASE_PATH);
    expect(inferTypeFromPack('PEOPLE/Alice.md', pack)).toBe('person');
    expect(inferTypeFromPack('Companies/ACME.md', pack)).toBe('company');
  });
});

import { describe, expect, test } from 'bun:test';
import { classifyPage, sourceRelativePath } from '../src/commands/source-audit.ts';

function page(overrides: Partial<{
  id: number;
  slug: string;
  source_path: string | null;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
}> = {}) {
  return {
    id: 1,
    slug: 'people/alice-example',
    source_id: 'personal',
    source_path: null,
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'A durable fact.',
    timeline: '',
    frontmatter: {},
    updated_at: null,
    ...overrides,
  };
}

describe('source audit classification', () => {
  test('normalizes a source-relative source_path', () => {
    expect(sourceRelativePath('E:/PersonalBrain', './people/alice-example.md')).toBe('people/alice-example.md');
    expect(sourceRelativePath('E:/PersonalBrain', 'PersonalBrain/people/alice-example.md')).toBe('people/alice-example.md');
  });

  test('keeps a page whose source_path is present in the current source', () => {
    const result = classifyPage(page({ source_path: 'people/alice-example.md' }), {
      sourceDir: 'E:/PersonalBrain',
      currentPaths: new Set(['people/alice-example.md']),
    });
    expect(result.bucket).toBe('current_source_keep');
    expect(result.action).toBe('keep');
  });

  test('keeps a current source file even when its historical DB row lacks source_path', () => {
    const result = classifyPage(page({ source_path: null }), {
      sourceDir: 'E:/PersonalBrain',
      currentPaths: new Set(),
      currentSlugs: new Set(['people/alice-example']),
    });
    expect(result.bucket).toBe('current_source_keep');
    expect(result.reasons).toContain('slug_matches_current_markdown_file');
  });

  test('holds an unpathed page explicitly referenced by the source', () => {
    const result = classifyPage(page({ source_path: null }), {
      sourceDir: 'E:/PersonalBrain',
      currentPaths: new Set(),
      referencedBy: ['notes/status.md'],
    });
    expect(result.bucket).toBe('historical_entity');
    expect(result.action).toBe('hold');
  });

  test('marks an obvious tool/config phrase as a soft-delete candidate', () => {
    const result = classifyPage(page({
      type: 'person',
      title: 'Supabase Configuration Template',
      slug: 'people/supabase-configuration-template',
      compiled_truth: 'short',
    }), {
      sourceDir: 'E:/PersonalBrain',
      currentPaths: new Set(),
    });
    expect(result.bucket).toBe('high_confidence_noise');
    expect(result.action).toBe('soft_delete_candidate');
  });

  test('routes an unpathed plausible entity to manual review', () => {
    const result = classifyPage(page({
      title: 'Alice Example',
      slug: 'people/alice-example',
      compiled_truth: 'A longer historical note that does not match phrase or tool markers.'.repeat(10),
    }), {
      sourceDir: 'E:/PersonalBrain',
      currentPaths: new Set(),
    });
    expect(result.bucket).toBe('manual_review');
    expect(result.action).toBe('manual_review');
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8');

describe('clarification-review skill wiring', () => {
  const skill = read('skills/clarification-review/SKILL.md');

  test('is registered and routed as a distinct ingest workflow', () => {
    const manifest = JSON.parse(read('skills/manifest.json')) as {
      skills: Array<{ name: string; path: string }>;
    };
    const resolver = read('skills/RESOLVER.md');

    expect(manifest.skills).toContainEqual(expect.objectContaining({
      name: 'clarification-review',
      path: 'clarification-review/SKILL.md',
    }));
    expect(resolver).toContain('skills/clarification-review/SKILL.md');
    expect(resolver).toContain('Ambiguous or incomplete ingest signal');
  });

  test('durably separates evidence, inference, and confirmed truth', () => {
    expect(skill).toContain('state/indexes/ingest-clarification-review');
    expect(skill).toContain('`observed`');
    expect(skill).toContain('`inferred`');
    expect(skill).toContain('`confirmed`');
    expect(skill).toContain('pending_review | asked | answered | resolved | skipped | superseded');
    expect(skill).toContain('never write it into a canonical page as fact');
  });

  test('defaults to deferred review but isolates high-impact blockers', () => {
    expect(skill).toContain('Default to deferred clarification');
    expect(skill).toContain('merge or overwrite the wrong entity');
    expect(skill).toContain('write across a brain/source ownership or privacy boundary');
    expect(skill).toContain('block only the affected semantic write');
  });

  test('uses one-question gates and client-first semantic write-through', () => {
    const askUser = read('skills/ask-user/SKILL.md');

    expect(skill).toContain('one question per turn');
    expect(skill).toContain('Do not rewrite raw evidence');
    expect(skill).toContain('[Source: User clarification, YYYY-MM-DD]');
    expect(skill).toContain('voltmind put <slug> < page.md');
    expect(skill).toContain('do not call Host MCP `put_page` directly as the first write');
    expect(askUser).toContain('The calling workflow owns durable state');
    expect(askUser).toContain('skills/clarification-review/SKILL.md');
  });

  test('is connected to all ingest signal producers and the control plane', () => {
    for (const path of [
      'skills/signal-detector/SKILL.md',
      'skills/brain-ops/SKILL.md',
      'skills/ingest/SKILL.md',
      'skills/meeting-ingestion/SKILL.md',
      'skills/conventions/client-ingest-control-plane.md',
    ]) {
      const content = read(path);
      expect(content).toContain('state/indexes/ingest-clarification-review');
    }
  });
});

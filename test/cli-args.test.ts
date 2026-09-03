import { describe, expect, test } from 'bun:test';
import { parseOpArgs } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';

describe('parseOpArgs', () => {
  test('--no-<boolean> maps to false without consuming the next flag', () => {
    const params = parseOpArgs(operationsByName.query, [
      'freshEmbedSourceScope code source',
      '--limit',
      '8',
      '--no-expand',
      '--source-id',
      'gstack-code-repo-0e4763c9',
    ]);

    expect(params).toEqual({
      query: 'freshEmbedSourceScope code source',
      limit: 8,
      expand: false,
      source_id: 'gstack-code-repo-0e4763c9',
    });
  });

  test('structured tracking flags decode JSON for thin-client routing', () => {
    const params = parseOpArgs(operationsByName.register_tracking_evidence, [
      '--evidence-slug', 'sources/teams/event-1',
      '--event-id', 'event-1',
      '--evidence-type', 'teams_thread',
      '--client-outcome', 'applied',
      '--tracking-refs', '[{"provider":"teams","resource":"conversation","id":"chat-1"}]',
      '--affected-pages', '["projects/example"]',
      '--action-assignments', '[]',
    ]);

    expect(params.tracking_refs).toEqual([{ provider: 'teams', resource: 'conversation', id: 'chat-1' }]);
    expect(params.affected_pages).toEqual(['projects/example']);
    expect(params.action_assignments).toEqual([]);
  });
});


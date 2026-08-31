import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const skillPath = 'skills/ingest/SKILL.md';
// Canonical reconstruction after the authorized Teams latest-100 connector
// correction; all unrelated pre-split content remains hash-pinned.
const canonicalSha256 = '8420ca08f750be85ecb011fe018a5d15a3ebf189db3cf86e22240339b322d310';
const referenceNames = [
  'clarification-and-semantic-commit',
  'microsoft-connectors',
  'mapped-shared-drive',
  'entity-detection',
  'media-and-raw-source',
  'client-write-through',
  'teams-cold-start',
] as const;
const additiveReferenceNames = [
  'outlook-email-timeline-reconciliation',
  'client-semantic-relations',
  'teams-chat-list-messages',
] as const;

function reconstructOriginal(): string {
  let text = readFileSync(skillPath, 'utf8');
  text = text.replace(
    /<!-- ingest-reference-router -->\r?\n[\s\S]*?<!-- \/ingest-reference-router -->\r?\n\r?\n/,
    '',
  );
  for (const name of referenceNames) {
    const path = `skills/ingest/references/${name}.md`;
    const exactSection = readFileSync(path, 'utf8');
    const marker = new RegExp(
      `<!-- ingest-reference:${name} -->\\r?\\n[\\s\\S]*?<!-- /ingest-reference:${name} -->\\r?\\n`,
    );
    expect(marker.test(text)).toBe(true);
    text = text.replace(marker, exactSection);
  }
  return text;
}

describe('ingest skill lossless reference split', () => {
  test('reconstructs the canonical UTF-8 source byte-for-byte', () => {
    const reconstructed = reconstructOriginal();
    expect(createHash('sha256').update(reconstructed).digest('hex')).toBe(canonicalSha256);
  });

  test('keeps every reference first-level and directly discoverable', () => {
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toContain('## Reference Router');
    expect(skill).toContain('Multiple rows may apply to one ingest.');
    for (const name of [...referenceNames, ...additiveReferenceNames]) {
      const path = `skills/ingest/references/${name}.md`;
      expect(existsSync(path)).toBe(true);
      expect(skill).toContain(`(references/${name}.md)`);
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(500);
    }
  });

  test('retains mandatory assignee and semantic completion rules after reconstruction', () => {
    const reconstructed = reconstructOriginal();
    expect(reconstructed).toContain('Never re-extract or guess assignees from the generated');
    expect(reconstructed).toContain('action_assignments');
    expect(reconstructed).toContain('semantic_status: review_required');
    expect(reconstructed).toContain('blocked_by_connector_pagination');
    expect(reconstructed).toContain('voltmind client-roots add synology-public');
  });

  test('keeps client-authored relationship materialization on the ingest path', () => {
    const relationshipContract = readFileSync(
      'skills/ingest/references/client-semantic-relations.md',
      'utf8',
    );
    expect(relationshipContract).toContain('frontmatter_links');
    expect(relationshipContract).toContain('canonical target slug');
    expect(relationshipContract).toContain('voltmind link <from-slug> <to-slug> --type <declared-link-type>');
    expect(relationshipContract).toContain('DB-only inferred');
  });

  test('pins Teams chat reads to one latest-100 request without historical paging', () => {
    const chatReadContract = readFileSync(
      'skills/ingest/references/teams-chat-list-messages.md',
      'utf8',
    );
    expect(chatReadContract).toContain('chat_list_messages` once with `top=100');
    expect(chatReadContract).toContain('Do not paginate');
    expect(chatReadContract).toContain('unrecoverable_gap');
    expect(chatReadContract).toContain('one latest-100 request');
  });
});

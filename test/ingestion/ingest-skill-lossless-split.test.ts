import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const skillPath = 'skills/ingest/SKILL.md';
const originalSha256 = '31acc0c62725cc5d07827da1b83cbe356598a4d581ca03c1f4bf6403a7b2ed7d';
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
  test('reconstructs the exact pre-split UTF-8 source byte-for-byte', () => {
    const reconstructed = reconstructOriginal();
    expect(createHash('sha256').update(reconstructed).digest('hex')).toBe(originalSha256);
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
});

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { inferTypeFromPack } from '../src/core/markdown.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { filingDirectoryForKind } from '../src/core/schema-pack/filing.ts';

const PACK_PATH = join(import.meta.dir, '../src/core/schema-pack/base/voltmind-personal-brain.yaml');

describe('voltmind-personal-brain pack', () => {
  test('matches every canonical vault directory', () => {
    const pack = loadPackFromFile(PACK_PATH);
    const cases = [
      ['inbox/capture.md', 'inbox'],
      ['daily/2026-07-16.md', 'daily'],
      ['people/alice-example.md', 'person'],
      ['orgs/platform.md', 'org'],
      ['companies/acme-example.md', 'company'],
      ['workstreams/company-brain.md', 'workstream'],
      ['projects/runtime-mvp.md', 'project'],
      ['meetings/2026-07-16-sync.md', 'meeting'],
      ['artifacts/technical-plan.md', 'artifact'],
      ['concepts/company-brain.md', 'concept'],
      ['ideas/new-workflow.md', 'idea'],
      ['policy/privacy-policy.md', 'policy'],
      ['sources/transcript.md', 'source'],
      ['sources/teams/chat.md', 'source_teams'],
      ['sources/meetings/weekly-sync.md', 'source_meeting'],
      ['sources/emails/message.md', 'source_email'],
      ['sources/calendar/event.md', 'source_calendar'],
      ['state/decisions/local-first.md', 'decision'],
      ['state/commitments/review.md', 'commitment'],
      ['state/actions/follow-up.md', 'action'],
      ['state/risks/schema-drift.md', 'risk'],
      ['state/indexes/open-actions.md', 'index'],
      ['contribution/candidates/candidate.md', 'contribution_candidate'],
      ['contribution/published/record.md', 'contribution_published'],
      ['contribution/rejected/record.md', 'contribution_rejected'],
      ['contribution/redacted/record.md', 'contribution_redacted'],
      ['contribution/reviews/review.md', 'contribution_review'],
      ['private/reflection.md', 'private'],
      ['archive/old-project.md', 'archive'],
    ] as const;

    for (const [path, type] of cases) expect(inferTypeFromPack(path, pack)).toBe(type);
    expect(inferTypeFromPack('policies/privacy-policy.md', pack)).toBe('unclassified');
    expect(inferTypeFromPack('nested/people/alice.md', pack)).toBe('unclassified');
  });

  test('uses filing rules for durable person and company writes', () => {
    const pack = loadPackFromFile(PACK_PATH);
    expect(filingDirectoryForKind(pack, 'person')).toBe('people/');
    expect(filingDirectoryForKind(pack, 'company')).toBe('companies/');
  });
});

import { describe, expect, test } from 'bun:test';

describe('client skill project tracking boundary', () => {
  test('meeting ingestion keeps direct project/workstream writes in the client flow', async () => {
    const skill = await Bun.file('skills/meeting-ingestion/SKILL.md').text();
    expect(skill).toContain('register_tracking_evidence');
    expect(skill).toContain('create a project when goal/owner/scope/status/completion condition are explicit');
    expect(skill).not.toContain('Do not create or update a project/workstream page during meeting ingestion');
  });

  test('generic ingest keeps ordinary put_page and client tracking writes', async () => {
    const skill = await Bun.file('skills/ingest/SKILL.md').text();
    expect(skill).toContain('Client-agent ingest may write `projects/`');
    expect(skill).toContain('register_tracking_evidence');
    expect(skill).not.toContain('only the server tracking worker performs those writes');
  });
});

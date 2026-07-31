import { describe, expect, test } from 'bun:test';

describe('client skill project tracking boundary', () => {
  test('meeting ingestion forbids direct project/workstream writes', async () => {
    const skill = await Bun.file('skills/meeting-ingestion/SKILL.md').text();
    expect(skill).toContain('Do not create or update a project/workstream page during meeting ingestion');
    expect(skill).toContain('submit_ingestion_event');
    expect(skill).toContain('does not trigger tracking');
  });

  test('generic ingest delegates automatic project writes to the company server', async () => {
    const skill = await Bun.file('skills/ingest/SKILL.md').text();
    expect(skill).toContain('Automatic ingest is not authorized to write `projects/`');
    expect(skill).toContain('only the server tracking worker performs those writes');
  });
});

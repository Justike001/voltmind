import { describe, expect, test } from 'bun:test';
import {
  routeSourceEvidenceSlug,
  sourceFilingKind,
} from '../src/core/source-routing.ts';

describe('personal source evidence routing', () => {
  test('maps each supported evidence type to a semantic filing rule', () => {
    expect(sourceFilingKind('teams_thread')).toBe('source_teams');
    expect(sourceFilingKind('meeting_transcript')).toBe('source_meeting');
    expect(sourceFilingKind('email')).toBe('source_email');
    expect(sourceFilingKind('calendar_event')).toBe('source_calendar');
    expect(sourceFilingKind('other')).toBe('source');
  });

  test('routes source evidence through active-pack filing rules', async () => {
    await expect(routeSourceEvidenceSlug('teams_thread', 'chat-2026-07-17', 'default'))
      .resolves.toBe('sources/teams/chat-2026-07-17');
    await expect(routeSourceEvidenceSlug('meeting_transcript', 'weekly-sync', 'default'))
      .resolves.toBe('sources/meetings/weekly-sync');
    await expect(routeSourceEvidenceSlug('email', 'subject', 'default'))
      .resolves.toBe('sources/emails/subject');
    await expect(routeSourceEvidenceSlug('calendar_event', 'event', 'default'))
      .resolves.toBe('sources/calendar/event');
  });

  test('refuses traversal in source evidence slugs', async () => {
    await expect(routeSourceEvidenceSlug('email', '../secret', 'default')).resolves.toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { resolveRuntimeRole } from '../src/commands/jobs.ts';
import { normalizeRelayTracking } from '../src/commands/serve-http.ts';
import { PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';

describe('project tracking runtime boundary', () => {
  test('tracking job is protected from remote submitters', () => {
    expect(PROTECTED_JOB_NAMES.has('project_track_progress')).toBe(true);
  });

  test('workers default to client and require an explicit company-server role', () => {
    expect(resolveRuntimeRole([], {})).toBe('client');
    expect(resolveRuntimeRole(['--runtime-role', 'company-server'], {})).toBe('company-server');
    expect(() => resolveRuntimeRole([], { VOLTMIND_RUNTIME_ROLE: 'server-ish' })).toThrow();
  });

  test('Microsoft relay preserves explicit refs and derives stable Teams refs', () => {
    expect(normalizeRelayTracking({
      platform: 'teams',
      conversation_id: 'chat-1',
      team_id: 'team-1',
      channel_id: 'channel-1',
      tracking_refs: [{ provider: 'teams', resource: 'conversation', id: 'chat-1' }],
    })).toEqual({
      evidence_type: 'teams_thread',
      tracking_refs: [
        { provider: 'teams', resource: 'conversation', id: 'chat-1' },
        { provider: 'teams', resource: 'team', id: 'team-1' },
        { provider: 'teams', resource: 'channel', id: 'channel-1' },
      ],
    });
  });

  test('meeting series selects transcript evidence by default', () => {
    const normalized = normalizeRelayTracking({
      platform: 'teams',
      meeting_series_id: 'series-1',
    });
    expect(normalized.evidence_type).toBe('meeting_transcript');
    expect(normalized.tracking_refs).toContainEqual({
      provider: 'teams',
      resource: 'meeting_series',
      id: 'series-1',
    });
  });
});

import { describe, expect, test } from 'bun:test';
import {
  decideTeamsCoverage,
  TEAMS_MESSAGE_RESULT_CAP,
} from '../../src/core/ingestion/teams-coverage.ts';

describe('Teams client coverage gate', () => {
  test('uses the connector recent-message cap of 100', () => {
    expect(TEAMS_MESSAGE_RESULT_CAP).toBe(100);
  });

  test('a sub-cap batch advances only after every event is registered', () => {
    expect(decideTeamsCoverage({
      returnedCount: TEAMS_MESSAGE_RESULT_CAP - 1,
      allEventsRegistered: false,
      nextCheckpointIso: '2026-08-04T00:00:00Z',
    })).toEqual({
      status: 'incomplete',
      shouldAdvanceCheckpoint: false,
      nextCheckpointIso: null,
    });

    expect(decideTeamsCoverage({
      returnedCount: TEAMS_MESSAGE_RESULT_CAP - 1,
      allEventsRegistered: true,
      nextCheckpointIso: '2026-08-04T00:00:00Z',
    })).toEqual({
      status: 'complete',
      shouldAdvanceCheckpoint: true,
      nextCheckpointIso: '2026-08-04T00:00:00Z',
    });
  });

  test('a durable capped batch stays saturated but advances the incremental high watermark', () => {
    expect(decideTeamsCoverage({
      returnedCount: TEAMS_MESSAGE_RESULT_CAP,
      allEventsRegistered: true,
      nextCheckpointIso: '2026-08-04T00:00:00Z',
    })).toEqual({
      status: 'saturated',
      shouldAdvanceCheckpoint: true,
      nextCheckpointIso: '2026-08-04T00:00:00Z',
    });
  });

  test('duplicate IDs do not weaken the saturated-response gate', () => {
    expect(decideTeamsCoverage({
      returnedCount: TEAMS_MESSAGE_RESULT_CAP,
      allEventsRegistered: false,
      nextCheckpointIso: '2026-08-04T00:00:00Z',
    })).toEqual({
      status: 'saturated',
      shouldAdvanceCheckpoint: false,
      nextCheckpointIso: null,
    });
  });
});

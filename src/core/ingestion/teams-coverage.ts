/**
 * Teams message coverage guardrails for client-side incremental ingest.
 *
 * The Teams connector exposes a hard per-call result cap but no continuation
 * cursor. A saturated response therefore cannot advance a chat checkpoint,
 * even when the returned message IDs are otherwise valid.
 */

export const TEAMS_MESSAGE_RESULT_CAP = 99;

export type TeamsCoverageStatus = 'complete' | 'saturated' | 'incomplete';

export interface TeamsCoverageInput {
  returnedCount: number;
  allEventsRegistered: boolean;
  nextCheckpointIso?: string | null;
}

export interface TeamsCoverageDecision {
  status: TeamsCoverageStatus;
  shouldAdvanceCheckpoint: boolean;
  nextCheckpointIso: string | null;
}

/**
 * Decide whether a client-side chat checkpoint may advance.
 *
 * `returnedCount === 99` is deliberately treated as saturated. A duplicate
 * event ID does not make a capped response complete because unseen messages
 * may still exist beyond the connector's result boundary.
 */
export function decideTeamsCoverage(input: TeamsCoverageInput): TeamsCoverageDecision {
  if (input.returnedCount >= TEAMS_MESSAGE_RESULT_CAP) {
    return {
      status: 'saturated',
      shouldAdvanceCheckpoint: false,
      nextCheckpointIso: null,
    };
  }

  if (!input.allEventsRegistered || !input.nextCheckpointIso) {
    return {
      status: 'incomplete',
      shouldAdvanceCheckpoint: false,
      nextCheckpointIso: null,
    };
  }

  return {
    status: 'complete',
    shouldAdvanceCheckpoint: true,
    nextCheckpointIso: input.nextCheckpointIso,
  };
}

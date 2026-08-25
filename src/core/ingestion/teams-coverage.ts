/**
 * Teams message coverage guardrails for client-side incremental ingest.
 *
 * The Teams connector exposes only the latest capped result set and no
 * continuation cursor. A saturated response cannot prove historical coverage,
 * but after all returned events are durable it advances the incremental high
 * watermark so later runs do not loop forever on the same 100 messages.
 */

export const TEAMS_MESSAGE_RESULT_CAP = 100;

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
 * `returnedCount === 100` is deliberately treated as saturated. It may advance
 * only the incremental high watermark after every returned event is registered;
 * the status remains saturated because older messages may be unrecoverable.
 */
export function decideTeamsCoverage(input: TeamsCoverageInput): TeamsCoverageDecision {
  if (input.returnedCount >= TEAMS_MESSAGE_RESULT_CAP) {
    const canAdvanceIncremental = input.allEventsRegistered && Boolean(input.nextCheckpointIso);
    return {
      status: 'saturated',
      shouldAdvanceCheckpoint: canAdvanceIncremental,
      nextCheckpointIso: canAdvanceIncremental ? input.nextCheckpointIso! : null,
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

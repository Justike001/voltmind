import { resolveActiveFilingDirectory } from './schema-pack/filing.ts';

/** Source evidence channels supported by the personal-brain scaffold. */
export type SourceEvidenceType =
  | 'teams_thread'
  | 'meeting_transcript'
  | 'email'
  | 'calendar_event'
  | 'other';

const FILING_KIND_BY_EVIDENCE_TYPE: Readonly<Record<SourceEvidenceType, string>> = {
  teams_thread: 'source_teams',
  meeting_transcript: 'source_meeting',
  email: 'source_email',
  calendar_event: 'source_calendar',
  other: 'source',
};

/** Semantic filing-rule key; the active pack owns the actual directory. */
export function sourceFilingKind(type: SourceEvidenceType): string {
  return FILING_KIND_BY_EVIDENCE_TYPE[type];
}

/** Resolve the source-evidence directory through the active schema pack. */
export async function resolveSourceEvidenceDirectory(
  type: SourceEvidenceType,
  sourceId: string,
): Promise<string | null> {
  return resolveActiveFilingDirectory(sourceFilingKind(type), sourceId);
}

/** Build a repository-relative evidence slug without allowing path traversal. */
export async function routeSourceEvidenceSlug(
  type: SourceEvidenceType,
  slug: string,
  sourceId: string,
): Promise<string | null> {
  const directory = await resolveSourceEvidenceDirectory(type, sourceId);
  const leaf = slug.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!directory || !leaf || leaf.split('/').some(part => part === '.' || part === '..')) return null;
  return `${directory}${leaf}`;
}

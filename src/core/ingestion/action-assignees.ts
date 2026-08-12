import type { BrainEngine } from '../engine.ts';

export interface AssigneeCandidate {
  slug: string;
  display_name: string;
  aliases?: string[];
}

export interface StructuredAssignee {
  slug: string;
  display_name: string;
  source_text: string;
}

export interface ActionAssigneeProjection {
  action_slug: string;
  assignees: StructuredAssignee[];
}

export interface ActionAssigneeFinding {
  code:
    | 'MISSING_STRUCTURED_ASSIGNEES'
    | 'INVALID_ACTION_SLUG'
    | 'INVALID_ASSIGNEE_SLUG'
    | 'INVALID_ASSIGNEE_LIST'
    | 'DUPLICATE_ACTION_ASSIGNMENT'
    | 'ACTION_NOT_AFFECTED'
    | 'ACTION_NOT_FOUND'
    | 'ACTION_WRONG_TYPE'
    | 'ASSIGNEE_NOT_IN_FRONTMATTER'
    | 'ASSIGNEE_NOT_LINKED_IN_BODY'
    | 'ASSIGNEE_PAGE_NOT_FOUND'
    | 'ASSIGNEE_BACKLINK_MISSING';
  action_slug: string;
  assignee_slug?: string;
  message: string;
}

function normalizedAliases(candidate: AssigneeCandidate): string[] {
  return Array.from(new Set([candidate.display_name, ...(candidate.aliases ?? [])]
    .map(value => value.trim())
    .filter(Boolean)))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Resolve known people from an assignment clause even when Teams removed mention separators. */
export function resolveStructuredAssigneesFromKnownEntities(
  assignmentText: string,
  candidates: AssigneeCandidate[],
): StructuredAssignee[] {
  const matches: Array<StructuredAssignee & { start: number; end: number }> = [];
  for (const candidate of candidates) {
    if (!candidate.slug.startsWith('people/')) continue;
    for (const alias of normalizedAliases(candidate)) {
      let from = 0;
      while (from < assignmentText.length) {
        const start = assignmentText.indexOf(alias, from);
        if (start < 0) break;
        matches.push({
          slug: candidate.slug,
          display_name: candidate.display_name,
          source_text: alias,
          start,
          end: start + alias.length,
        });
        from = start + Math.max(alias.length, 1);
      }
    }
  }
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.slug.localeCompare(b.slug));
  const selected: typeof matches = [];
  for (const match of matches) {
    if (selected.some(existing => match.start < existing.end && existing.start < match.end)) continue;
    if (selected.some(existing => existing.slug === match.slug)) continue;
    selected.push(match);
  }
  return selected.map(({ slug, display_name, source_text }) => ({ slug, display_name, source_text }));
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value.trim()].filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
}

function hasWikiLink(markdown: string, slug: string): boolean {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`).test(markdown);
}

/** Validate an action projection before its ingest receipt may be completed. */
export async function validateActionAssigneeCoverage(
  engine: BrainEngine,
  sourceId: string,
  affectedPages: string[],
  projections: ActionAssigneeProjection[],
): Promise<ActionAssigneeFinding[]> {
  const findings: ActionAssigneeFinding[] = [];
  const affectedActions = affectedPages.filter(slug => slug.startsWith('state/actions/'));
  const byAction = new Map<string, ActionAssigneeProjection>();

  for (const projection of projections) {
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
      findings.push({ code: 'INVALID_ACTION_SLUG', action_slug: '', message: 'action assignment must be an object' });
      continue;
    }
    const actionSlug = projection.action_slug?.trim();
    if (!actionSlug?.startsWith('state/actions/')) {
      findings.push({ code: 'INVALID_ACTION_SLUG', action_slug: actionSlug || '', message: 'action_slug must start with state/actions/' });
      continue;
    }
    if (byAction.has(actionSlug)) {
      findings.push({ code: 'DUPLICATE_ACTION_ASSIGNMENT', action_slug: actionSlug, message: 'action has more than one structured assignee projection' });
      continue;
    }
    if (!affectedActions.includes(actionSlug)) {
      findings.push({ code: 'ACTION_NOT_AFFECTED', action_slug: actionSlug, message: 'structured assignee projection must reference an affected action page' });
    }
    byAction.set(actionSlug, projection);
  }

  for (const actionSlug of affectedActions) {
    const projection = byAction.get(actionSlug);
    if (!projection || !Array.isArray(projection.assignees) || projection.assignees.length === 0) {
      findings.push({ code: 'MISSING_STRUCTURED_ASSIGNEES', action_slug: actionSlug, message: 'affected action requires non-empty structured assignees' });
      continue;
    }
    if (projection.assignees.length > 20) {
      findings.push({ code: 'INVALID_ASSIGNEE_LIST', action_slug: actionSlug, message: 'affected action supports at most 20 structured assignees' });
      continue;
    }
    const action = await engine.getPage(actionSlug, { sourceId });
    if (!action) {
      findings.push({ code: 'ACTION_NOT_FOUND', action_slug: actionSlug, message: 'affected action page was not found' });
      continue;
    }
    const actionType = String((action as unknown as { type?: unknown }).type ?? action.frontmatter?.type ?? '');
    if (actionType !== 'action') {
      findings.push({ code: 'ACTION_WRONG_TYPE', action_slug: actionSlug, message: 'affected action slug does not contain an action page' });
      continue;
    }
    const frontmatterPeople = new Set([
      ...stringValues(action.frontmatter?.owner),
      ...stringValues(action.frontmatter?.related_people),
    ]);
    const actionBody = `${action.compiled_truth}\n${action.timeline}`;
    const seen = new Set<string>();
    for (const assignee of projection.assignees) {
      const assigneeSlug = assignee?.slug?.trim();
      if (!assigneeSlug?.startsWith('people/')) {
        findings.push({ code: 'INVALID_ASSIGNEE_SLUG', action_slug: actionSlug, assignee_slug: assigneeSlug, message: 'assignee slug must start with people/' });
        continue;
      }
      if (seen.has(assigneeSlug)) continue;
      seen.add(assigneeSlug);
      if (!frontmatterPeople.has(assigneeSlug)) {
        findings.push({ code: 'ASSIGNEE_NOT_IN_FRONTMATTER', action_slug: actionSlug, assignee_slug: assigneeSlug, message: 'assignee must appear in owner or related_people' });
      }
      if (!hasWikiLink(actionBody, assigneeSlug)) {
        findings.push({ code: 'ASSIGNEE_NOT_LINKED_IN_BODY', action_slug: actionSlug, assignee_slug: assigneeSlug, message: 'assignee must be an explicit body wikilink' });
      }
      const person = await engine.getPage(assigneeSlug, { sourceId });
      if (!person) {
        findings.push({ code: 'ASSIGNEE_PAGE_NOT_FOUND', action_slug: actionSlug, assignee_slug: assigneeSlug, message: 'assignee person page was not found' });
        continue;
      }
      if (!hasWikiLink(`${person.compiled_truth}\n${person.timeline}`, actionSlug)) {
        findings.push({ code: 'ASSIGNEE_BACKLINK_MISSING', action_slug: actionSlug, assignee_slug: assigneeSlug, message: 'assignee person page must link back to the action' });
      }
    }
  }
  return findings;
}

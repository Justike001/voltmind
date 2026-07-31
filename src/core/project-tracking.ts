/** Long-running project/workstream tracking primitives.
 *
 * This module is deliberately provider-neutral. Connectors emit stable
 * TrackingReference values; users declare bindings in page frontmatter. The
 * runtime then performs deterministic exact matching before falling back to a
 * review candidate. No page is created from an unbound event.
 */
import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import type { TrackingReference } from './ingestion/types.ts';

export type TrackingTargetType = 'project' | 'workstream';
export type TrackingOutcome = 'applied' | 'candidate' | 'skipped' | 'failed';

export interface TrackingBinding extends TrackingReference {
  label?: string;
}

export interface TrackingTarget {
  slug: string;
  type: TrackingTargetType;
  title: string;
  page: Page;
  matchedBy: 'binding' | 'alias' | 'title';
  score: number;
}

export interface TrackingCandidate {
  slug: string;
  type: TrackingTargetType;
  title: string;
  score: number;
  reason: string;
}

export interface ProgressDelta {
  summary: string;
  status?: string;
  currentState?: string;
  stateObjects: Array<{
    type: 'action' | 'decision' | 'commitment' | 'risk';
    title: string;
    body: string;
    status?: string;
    owner?: string;
    due?: string;
    key: string;
  }>;
}

const TRACKING_BEGIN = '<!-- voltmind:tracking-state:begin -->';
const TRACKING_END = '<!-- voltmind:tracking-state:end -->';

export function trackingRefKey(ref: TrackingReference): string {
  return `${ref.provider.trim().toLowerCase()}:${ref.resource.trim().toLowerCase()}:${ref.id.trim()}`;
}

export function parseTrackingBindings(value: unknown): TrackingBinding[] {
  if (!Array.isArray(value)) return [];
  const out: TrackingBinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.provider !== 'string' || typeof v.resource !== 'string' || typeof v.id !== 'string') continue;
    if (!v.provider.trim() || !v.resource.trim() || !v.id.trim()) continue;
    out.push({
      provider: v.provider.trim(),
      resource: v.resource.trim(),
      id: v.id.trim(),
      ...(typeof v.label === 'string' && v.label.trim() ? { label: v.label.trim() } : {}),
    });
  }
  return out;
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function aliasesFor(page: Page): string[] {
  const fm = page.frontmatter ?? {};
  const values = [fm.tracking_aliases, fm.aliases];
  return values.flatMap(v => Array.isArray(v) ? v.filter(x => typeof x === 'string').map(String) : [])
    .map(normalizeText).filter(Boolean);
}

function textFor(page: Page): string {
  return normalizeText([page.title, page.compiled_truth ?? ''].join(' '));
}

export async function resolveTrackingTargets(
  engine: BrainEngine,
  sourceId: string,
  refs: TrackingReference[] = [],
  text = '',
  context: Record<string, unknown> = {},
): Promise<{ targets: TrackingTarget[]; candidates: TrackingCandidate[] }> {
  const pages = await engine.listPages({ sourceId, sort: 'slug' });
  const entities = pages.filter((p): p is Page & { type: TrackingTargetType } =>
    p.type === 'project' || p.type === 'workstream');
  const refKeys = new Set(refs.map(trackingRefKey));
  const targets: TrackingTarget[] = [];
  for (const page of entities) {
    const bindings = parseTrackingBindings(page.frontmatter?.tracking_bindings);
    const exact = bindings.some(b => refKeys.has(trackingRefKey(b)));
    if (exact) targets.push({ slug: page.slug, type: page.type, title: page.title, page, matchedBy: 'binding', score: 1 });
  }
  if (targets.length > 0 || !text.trim()) return { targets, candidates: [] };

  const contextText = Object.entries(context)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(' ');
  const normalized = normalizeText(`${text} ${contextText}`);
  const candidates = entities.map(page => {
    const title = normalizeText(page.title);
    const aliases = aliasesFor(page);
    let score = 0;
    let reason = 'related project/workstream text';
    const pageContext = normalizeText([
      page.frontmatter?.team,
      page.frontmatter?.owner_team,
      page.frontmatter?.workstream,
      page.frontmatter?.related_workstream,
    ].filter(value => typeof value === 'string').join(' '));
    if (title && (normalized.includes(title) || title.includes(normalized))) {
      score = 0.92;
      reason = 'title appears in evidence';
    } else {
      const alias = aliases.find(a => a.length > 2 && normalized.includes(a));
      if (alias) { score = 0.86; reason = `tracking alias appears in evidence: ${alias}`; }
      else if (pageContext && normalized.includes(pageContext)) {
        score = 0.82;
        reason = 'team/workstream context appears in evidence metadata';
      }
      else {
        const words = new Set(title.split(' ').filter(w => w.length > 2));
        const overlap = [...words].filter(w => normalized.includes(w)).length;
        score = words.size > 0 ? Math.min(0.8, overlap / words.size) : 0;
      }
    }
    return { slug: page.slug, type: page.type, title: page.title, score, reason };
  }).filter(c => c.score >= 0.55)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return { targets: [], candidates };
}

/** Parse only the small, allow-listed JSON shape used by a structured
 * extractor. Unknown keys and malformed values are ignored rather than
 * becoming page writes. */
export function parseProgressDeltaJson(value: unknown): ProgressDelta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.summary !== 'string' || !candidate.summary.trim()) return null;
  const rawObjects = Array.isArray(candidate.stateObjects) ? candidate.stateObjects : [];
  const stateObjects: ProgressDelta['stateObjects'] = [];
  for (const raw of rawObjects) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (!['action', 'decision', 'commitment', 'risk'].includes(String(item.type))) continue;
    if (typeof item.title !== 'string' || !item.title.trim()) continue;
    const type = String(item.type) as ProgressDelta['stateObjects'][number]['type'];
    const title = item.title.trim().slice(0, 240);
    stateObjects.push({
      type,
      title,
      body: typeof item.body === 'string' ? item.body.slice(0, 1000) : title,
      ...(typeof item.status === 'string' ? { status: item.status.slice(0, 120) } : {}),
      ...(typeof item.owner === 'string' ? { owner: item.owner.slice(0, 240) } : {}),
      ...(typeof item.due === 'string' ? { due: item.due.slice(0, 80) } : {}),
      key: normalizeText(`${type} ${title}`),
    });
  }
  return {
    summary: candidate.summary.trim().slice(0, 500),
    ...(typeof candidate.status === 'string' ? { status: candidate.status.slice(0, 120) } : {}),
    currentState: typeof candidate.currentState === 'string' ? candidate.currentState.slice(0, 500) : candidate.summary.trim().slice(0, 500),
    stateObjects,
  };
}

/** Conservative, provider-neutral extractor. A connector/model may emit a
 * strict JSON object; otherwise only explicit state lines are promoted. This
 * never treats arbitrary instructions in source text as executable commands. */
export function extractProgressDelta(content: string): ProgressDelta {
  const jsonCandidates = [content.trim(), ...Array.from(content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), match => match[1].trim())];
  for (const candidate of jsonCandidates) {
    try {
      const parsed = parseProgressDeltaJson(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      // Fall through to the conservative line parser.
    }
  }
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const summary = (lines.find(line => !line.startsWith('---') && !line.startsWith('#')) ?? lines[0] ?? 'Progress captured').slice(0, 500);
  const stateObjects: ProgressDelta['stateObjects'] = [];
  let headingType: ProgressDelta['stateObjects'][number]['type'] | undefined;
  for (const line of lines) {
    const m = line.match(/^[-*]\s+(action|decision|commitment|risk)\s*:\s*(.+)$/i);
    if (m) {
      const type = m[1].toLowerCase() as ProgressDelta['stateObjects'][number]['type'];
      const title = m[2].trim().slice(0, 240);
      stateObjects.push({ type, title, body: line.slice(0, 1000), key: normalizeText(`${type} ${title}`) });
      continue;
    }
    const heading = line.match(/^#{1,6}\s*(actions?|action items?|decisions?|commitments?|risks?|行动项|待办|决定|决策|承诺|风险)\s*$/i);
    if (heading) {
      const normalizedHeading = heading[1].toLowerCase();
      headingType = /decision|决定|决策/.test(normalizedHeading) ? 'decision'
        : /commitment|承诺/.test(normalizedHeading) ? 'commitment'
        : /risk|风险/.test(normalizedHeading) ? 'risk'
        : 'action';
      continue;
    }
    const bullet = line.match(/^[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (!headingType || !bullet) continue;
    const body = bullet[1].trim().slice(0, 1000);
    const owner = body.match(/(?:owner|负责人)\s*[:：]\s*([^,;，；|]+)/i)?.[1]?.trim();
    const due = body.match(/(?:due|deadline|截止(?:日期)?)\s*[:：]\s*([^,;，；|]+)/i)?.[1]?.trim();
    const title = body.replace(/\s*(?:owner|负责人|due|deadline|截止(?:日期)?)\s*[:：].*$/i, '').trim().slice(0, 240) || body.slice(0, 240);
    stateObjects.push({
      type: headingType,
      title,
      body,
      ...(owner ? { owner: owner.slice(0, 240) } : {}),
      ...(due ? { due: due.slice(0, 80) } : {}),
      key: normalizeText(`${headingType} ${title}`),
    });
  }
  const statusMatch = content.match(/\b(status|状态)\s*[:：]\s*([^\n]+)/i);
  return {
    summary,
    ...(statusMatch ? { status: statusMatch[2].trim().slice(0, 120) } : {}),
    currentState: summary,
    stateObjects,
  };
}

export function upsertTrackingState(compiledTruth: string, delta: ProgressDelta, source: string): string {
  const block = [
    TRACKING_BEGIN,
    '## Tracked Current State',
    `- **Current state:** ${delta.currentState ?? delta.summary} [Source: ${source}]`,
    `- **Latest progress:** ${delta.summary} [Source: ${source}]`,
    ...(delta.status ? [`- **Status signal:** ${delta.status} [Source: ${source}]`] : []),
    TRACKING_END,
  ].join('\n');
  const start = compiledTruth.indexOf(TRACKING_BEGIN);
  const end = compiledTruth.indexOf(TRACKING_END);
  if (start >= 0 && end >= start) {
    return `${compiledTruth.slice(0, start)}${block}${compiledTruth.slice(end + TRACKING_END.length)}`.trim();
  }
  return `${compiledTruth.trim()}\n\n${block}`.trim();
}

export function appendTrackingTimeline(timeline: string, date: string, summary: string, source: string): string {
  const line = `- **${date}** | ${summary} [Source: ${source}]`;
  if (timeline.includes(line)) return timeline;
  return `${timeline.trim()}${timeline.trim() ? '\n' : ''}${line}`.trim();
}

export function trackingReviewPageContent(candidates: TrackingCandidate[], evidenceSlug: string, date: string): string {
  const rows = candidates.map(c => `- [ ] ${c.type}: [[${c.slug}]] — ${c.title} (${Math.round(c.score * 100)}%, ${c.reason})`).join('\n');
  return `---\ntype: index\ntitle: Project Tracking Review\nstatus: active\nupdated: ${date}\n---\n\n# Project Tracking Review\n\nUnbound or ambiguous progress evidence awaiting a user-maintained Frontmatter binding.\n\n## Candidates\n\n${rows || '- [ ] No candidates'}\n\n## Evidence\n\n- [[${evidenceSlug}]]\n`;
}

export {
  TRACKING_BEGIN,
  TRACKING_END,
};

/**
 * MVP-safe signal enrichment.
 *
 * This is the deterministic, source-backed enrichment layer used by explicit
 * ingest/write paths. It creates or updates person/company pages only when the
 * signal is attributable and passes a small notability gate. Legacy ambient
 * loops, social crawlers, and autopilot-style recurring enrichment are not part
 * of this service.
 */

import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import { BudgetLedger } from './enrichment/budget.ts';

export type EnrichmentEntityType = 'person' | 'company';

export interface EnrichmentRequest {
  entityName: string;
  entityType: EnrichmentEntityType;
  context: string;
  sourceSlug: string;
  sourceId?: string;
  tier?: 1 | 2 | 3;
  citation?: string;
  external?: boolean;
  dryRun?: boolean;
}

export interface EnrichmentResult {
  slug: string;
  action: 'created' | 'updated' | 'skipped';
  tier: 1 | 2 | 3;
  backlinkCreated: boolean;
  timelineAdded: boolean;
  mentionCount: number;
  mentionSources: string[];
  suggestedTier: 1 | 2 | 3;
  tierEscalated: boolean;
  reason?: string;
  rawDataSaved?: boolean;
  external?: ExternalEnrichmentResult;
}

export interface SignalEnrichmentOptions {
  sourceId: string;
  sourceSlug?: string;
  pageSlug?: string;
  text?: string;
  limit?: number;
  external?: boolean;
  confirm?: boolean;
  dryRun?: boolean;
}

export interface SignalEnrichmentSummary {
  detected: Array<{ name: string; type: EnrichmentEntityType; slug: string; tier: 1 | 2 | 3; confidence: number }>;
  created: string[];
  updated: string[];
  timeline_added: number;
  links_added: number;
  external_calls: Array<ExternalEnrichmentResult & { slug: string }>;
  skipped: Array<{ name: string; type: EnrichmentEntityType; reason: string }>;
  warnings: string[];
  budget: Array<{ resolver_id: string; status: string; detail?: string }>;
}

export interface PageSignalEnrichmentSummary extends SignalEnrichmentSummary {
  pages_scanned: number;
  pages_skipped_due_to_limit: number;
}

export interface ExternalEnrichmentResult {
  attempted: boolean;
  provider?: string;
  status: 'skipped' | 'reserved' | 'failed' | 'not_configured' | 'budget_exhausted';
  reason?: string;
}

interface DetectedEntity {
  name: string;
  type: EnrichmentEntityType;
  context: string;
  confidence: number;
}

const DEFAULT_LIMIT = 100;
const EXTERNAL_ESTIMATE_USD = 0.05;

export function slugifyEntity(name: string, type: EnrichmentEntityType): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const prefix = type === 'person' ? 'people' : 'companies';
  return `${prefix}/${slug}`;
}

export function entityPagePath(name: string, type: EnrichmentEntityType): string {
  return slugifyEntity(name, type);
}

export async function previewSignalEnrichment(
  engine: BrainEngine,
  opts: SignalEnrichmentOptions,
): Promise<SignalEnrichmentSummary> {
  return runSignalEnrichment(engine, { ...opts, dryRun: true, confirm: false });
}

export async function applySignalEnrichment(
  engine: BrainEngine,
  opts: SignalEnrichmentOptions,
): Promise<SignalEnrichmentSummary> {
  if (opts.confirm !== true) {
    throw new Error('applySignalEnrichment requires confirm=true.');
  }
  return runSignalEnrichment(engine, { ...opts, dryRun: false });
}

export async function applySignalEnrichmentForPages(
  engine: BrainEngine,
  opts: { sourceId: string; pageSlugs: string[]; limit?: number },
): Promise<PageSignalEnrichmentSummary> {
  const limit = clampLimit(opts.limit ?? DEFAULT_LIMIT);
  const selected = opts.pageSlugs.slice(0, limit);
  const summary = emptySignalSummary() as PageSignalEnrichmentSummary;
  summary.pages_scanned = selected.length;
  summary.pages_skipped_due_to_limit = Math.max(0, opts.pageSlugs.length - selected.length);
  if (summary.pages_skipped_due_to_limit > 0) {
    summary.warnings.push(`page_limit_reached:${summary.pages_skipped_due_to_limit}`);
  }

  for (const slug of selected) {
    const pageSummary = await applySignalEnrichment(engine, {
      sourceId: opts.sourceId || 'default',
      sourceSlug: slug,
      pageSlug: slug,
      limit,
      external: false,
      confirm: true,
    });
    mergeSignalSummary(summary, pageSummary);
  }

  return summary;
}

export async function enrichEntity(
  engine: BrainEngine,
  request: EnrichmentRequest,
): Promise<EnrichmentResult> {
  const sourceId = request.sourceId ?? 'default';
  const sourceSlug = request.sourceSlug || 'signal';
  const slug = slugifyEntity(request.entityName, request.entityType);
  const existingPage = await engine.getPage(slug, { sourceId });
  const { mentionCount, mentionSources } = await countMentions(engine, request.entityName);
  const suggestedTier = suggestTier(mentionCount, mentionSources, request.context, sourceSlug);
  const tier = request.tier || suggestedTier;
  const tierEscalated = suggestedTier < (request.tier || 3);
  const confidence = confidenceForEntity(request.entityName, request.entityType, request.context, sourceSlug);
  const citation = request.citation || sourceCitation(sourceSlug);

  if (!existingPage && !passesNotability(request.entityName, request.entityType, request.context, sourceSlug, confidence)) {
    return {
      slug,
      action: 'skipped',
      tier,
      backlinkCreated: false,
      timelineAdded: false,
      mentionCount,
      mentionSources,
      suggestedTier,
      tierEscalated,
      reason: 'notability_gate',
    };
  }

  if (request.dryRun) {
    const external = await previewExternalEnrichment(engine, { tier, enabled: request.external === true });
    return {
      slug,
      action: existingPage ? 'updated' : 'created',
      tier,
      backlinkCreated: true,
      timelineAdded: true,
      mentionCount,
      mentionSources,
      suggestedTier,
      tierEscalated,
      rawDataSaved: true,
      external,
    };
  }

  let action: 'created' | 'updated' = existingPage ? 'updated' : 'created';
  if (!existingPage) {
    await engine.putPage(slug, buildEntityPage(request.entityName, request.entityType, request.context, sourceSlug, citation, tier), { sourceId });
  }

  const external = await maybeRunExternalEnrichment(engine, {
    sourceId,
    slug,
    tier,
    enabled: request.external === true,
  });

  let timelineAdded = false;
  try {
    await engine.addTimelineEntry(slug, {
      date: today(),
      source: citation,
      summary: `Referenced in ${sourceSlug}: ${trimContext(request.context)}`,
    }, { sourceId });
    timelineAdded = true;
  } catch {
    timelineAdded = false;
  }

  let backlinkCreated = false;
  if (sourceSlug && sourceSlug !== slug) {
    try {
      await engine.addLink(slug, sourceSlug, `Entity mention from ${sourceSlug}`, 'mentions', 'mentions', slug, 'signal', {
        fromSourceId: sourceId,
        toSourceId: sourceId,
        originSourceId: sourceId,
      });
      backlinkCreated = true;
    } catch {
      backlinkCreated = false;
    }
  }

  let rawDataSaved = false;
  try {
    await engine.putRawData(slug, 'signal-enrichment', {
      entity_name: request.entityName,
      entity_type: request.entityType,
      context: request.context,
      source_slug: sourceSlug,
      citation,
      tier,
      external,
    }, { sourceId });
    rawDataSaved = true;
  } catch {
    rawDataSaved = false;
  }

  return {
    slug,
    action,
    tier,
    backlinkCreated,
    timelineAdded,
    mentionCount,
    mentionSources,
    suggestedTier,
    tierEscalated,
    rawDataSaved,
    external,
  };
}

export async function enrichEntities(
  engine: BrainEngine,
  requests: EnrichmentRequest[],
  config?: { throttle?: boolean; onProgress?: (done: number, total: number, name: string) => void },
): Promise<EnrichmentResult[]> {
  const results: EnrichmentResult[] = [];
  for (const req of requests) {
    const result = await enrichEntity(engine, req);
    results.push(result);
    config?.onProgress?.(results.length, requests.length, req.entityName);
  }
  return results;
}

export async function extractAndEnrich(
  engine: BrainEngine,
  text: string,
  sourceSlug: string,
): Promise<EnrichmentResult[]> {
  const entities = extractEntities(text);
  if (entities.length === 0) return [];
  return enrichEntities(engine, entities.map(e => ({
    entityName: e.name,
    entityType: e.type,
    context: e.context,
    sourceSlug,
  })));
}

async function runSignalEnrichment(
  engine: BrainEngine,
  opts: SignalEnrichmentOptions,
): Promise<SignalEnrichmentSummary> {
  const warnings: string[] = [];
  const limit = clampLimit(opts.limit);
  const sourceId = opts.sourceId || 'default';
  const sourceSlug = opts.sourceSlug || opts.pageSlug || 'signal';
  const text = await resolveSignalText(engine, opts, sourceId);
  const extracted = extractEntities(text);
  const rawEntities = extracted.slice(0, limit);
  const skippedOverflow = Math.max(0, extracted.length - rawEntities.length);
  if (skippedOverflow > 0) warnings.push(`entity_limit_reached:${skippedOverflow}`);

  const summary = emptySignalSummary(warnings);

  for (const entity of rawEntities) {
    const slug = slugifyEntity(entity.name, entity.type);
    const { mentionCount, mentionSources } = await countMentions(engine, entity.name);
    const tier = suggestTier(mentionCount, mentionSources, entity.context, sourceSlug);
    summary.detected.push({ name: entity.name, type: entity.type, slug, tier, confidence: entity.confidence });

    const result = await enrichEntity(engine, {
      entityName: entity.name,
      entityType: entity.type,
      context: entity.context,
      sourceSlug,
      sourceId,
      tier,
      citation: sourceCitation(sourceSlug),
      external: opts.external === true,
      dryRun: opts.dryRun === true,
    });

    if (result.external) {
      summary.external_calls.push({ ...result.external, slug });
      if (result.external.status === 'budget_exhausted') {
        summary.budget.push({ resolver_id: result.external.provider ?? 'external', status: 'budget_exhausted', detail: result.external.reason });
      } else if (result.external.status === 'reserved') {
        summary.budget.push({ resolver_id: result.external.provider ?? 'external', status: 'reserved' });
      }
    }

    if (result.action === 'created') summary.created.push(result.slug);
    else if (result.action === 'updated') summary.updated.push(result.slug);
    else summary.skipped.push({ name: entity.name, type: entity.type, reason: result.reason ?? 'skipped' });

    if (result.timelineAdded) summary.timeline_added += 1;
    if (result.backlinkCreated) summary.links_added += 1;
    if (result.rawDataSaved === false && result.action !== 'skipped') {
      summary.warnings.push(`raw_data_not_saved:${result.slug}`);
    }
  }

  return summary;
}

function emptySignalSummary(warnings: string[] = []): SignalEnrichmentSummary {
  return {
    detected: [],
    created: [],
    updated: [],
    timeline_added: 0,
    links_added: 0,
    external_calls: [],
    skipped: [],
    warnings,
    budget: [],
  };
}

function mergeSignalSummary(target: SignalEnrichmentSummary, source: SignalEnrichmentSummary): void {
  target.detected.push(...source.detected);
  target.created.push(...source.created);
  target.updated.push(...source.updated);
  target.timeline_added += source.timeline_added;
  target.links_added += source.links_added;
  target.external_calls.push(...source.external_calls);
  target.skipped.push(...source.skipped);
  target.warnings.push(...source.warnings);
  target.budget.push(...source.budget);
}

async function resolveSignalText(engine: BrainEngine, opts: SignalEnrichmentOptions, sourceId: string): Promise<string> {
  if (typeof opts.text === 'string' && opts.text.trim().length > 0) return opts.text;
  if (opts.pageSlug) {
    const page = await engine.getPage(opts.pageSlug, { sourceId });
    if (!page) return '';
    return pageToSignalText(page);
  }
  const pages = await engine.listPages({ sourceId, limit: clampLimit(opts.limit), sort: 'updated_desc' });
  return pages.map(pageToSignalText).join('\n\n');
}

function pageToSignalText(page: Page): string {
  return buildSignalTextFromPage(page);
}

export function buildSignalTextFromPage(page: Pick<Page, 'type' | 'frontmatter' | 'compiled_truth' | 'timeline'>): string {
  return [
    ...frontmatterSignalLines(page.frontmatter ?? {}, String(page.type ?? '')),
    stripMarkdownHeadingLines(page.compiled_truth ?? ''),
    page.timeline ?? '',
  ].filter(Boolean).join('\n');
}

function stripMarkdownHeadingLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(line => !/^\s{0,3}#{1,6}\s+\S/.test(line))
    .join('\n');
}

function frontmatterSignalLines(frontmatter: Record<string, unknown>, pageType: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const values = collectSignalStrings(value);
    if (values.length === 0) continue;

    const personSignal = isPersonSignalField(normalizedKey, pageType);
    const companySignal = isCompanySignalField(normalizedKey, pageType);
    if (!personSignal && !companySignal) continue;

    for (const v of values) {
      const cleaned = cleanSignalValue(v);
      if (!cleaned) continue;
      if (personSignal) {
        lines.push(`${cleaned} is a contact from ${pageType || 'page'} frontmatter field ${key}.`);
      } else {
        lines.push(`${cleaned} is a company from ${pageType || 'page'} frontmatter field ${key}.`);
      }
    }
  }
  return lines;
}

function isPersonSignalField(key: string, pageType: string): boolean {
  if (fieldKeyHas(key, ['attendee', 'attendees', 'participant', 'participants', 'people', 'person', 'contacts', 'contact', 'owner', 'owners', 'sender', 'from', 'to', 'cc', 'bcc', 'invitee', 'invitees', 'speaker', 'speakers', 'candidate', 'candidates'])) return true;
  return /^(meeting|calendar|email|contact|conversation|slack)$/.test(pageType) && fieldKeyHas(key, ['name', 'display_name', 'person']);
}

function isCompanySignalField(key: string, pageType: string): boolean {
  if (fieldKeyHas(key, ['companies', 'company', 'organization', 'organizations', 'org', 'orgs', 'employer', 'employers', 'account', 'accounts', 'vendor', 'vendors', 'customer', 'customers', 'partner', 'partners'])) return true;
  return /^(company|contact|email|meeting|calendar)$/.test(pageType) && fieldKeyHas(key, ['organization', 'org', 'employer', 'account']);
}

function fieldKeyHas(key: string, tokens: string[]): boolean {
  const parts = key.split('_').filter(Boolean);
  return tokens.some(token => parts.includes(token) || key === token || key.endsWith(`_${token}`) || key.startsWith(`${token}_`));
}

function collectSignalStrings(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(v => collectSignalStrings(v, depth + 1));
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const k = key.toLowerCase();
      if (['name', 'title', 'display_name', 'company', 'organization', 'org', 'employer'].includes(k)) {
        out.push(...collectSignalStrings(nested, depth + 1));
      } else if (typeof nested === 'object') {
        out.push(...collectSignalStrings(nested, depth + 1));
      }
    }
    return out;
  }
  return [];
}

function cleanSignalValue(value: string): string | null {
  const cleaned = value.replace(/[<>()"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 3) return null;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) return null;
  return cleaned;
}

async function countMentions(
  engine: BrainEngine,
  entityName: string,
): Promise<{ mentionCount: number; mentionSources: string[] }> {
  try {
    const results = await engine.searchKeyword(entityName, { limit: 100 });
    const sources = new Set<string>();
    for (const r of results) {
      const prefix = r.slug.split('/')[0];
      if (prefix === 'people' || prefix === 'companies') sources.add('enrich');
      else if (prefix === 'meetings') sources.add('meeting-ingestion');
      else if (prefix === 'sources' || prefix === 'ideas' || prefix === 'inbox') sources.add('ingest');
      else sources.add('brain-ops');
    }
    return { mentionCount: results.length, mentionSources: [...sources] };
  } catch {
    return { mentionCount: 0, mentionSources: [] };
  }
}

function suggestTier(
  mentionCount: number,
  mentionSources: string[],
  context: string,
  sourceSlug: string,
): 1 | 2 | 3 {
  if (sourceSlug.startsWith('meetings/') || /\b(attendee|owner|contact|manager|founder|ceo|cto)\b/i.test(context)) return 1;
  if (mentionCount >= 8) return 1;
  if (mentionCount >= 3 && mentionSources.length >= 2) return 2;
  return 3;
}

export function extractEntities(text: string): DetectedEntity[] {
  const entities: DetectedEntity[] = [];
  const seen = new Set<string>();
  const namePattern = /\b([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+){1,3})\b/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const name = normalizeDetectedName(match[1]);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const isCompany = /(?:Inc|Corp|Ltd|LLC|Co|Labs?|Technologies|Tech|AI|Capital|Ventures?|Fund|Bank|University)\b/i.test(name);
    const type: EnrichmentEntityType = isCompany ? 'company' : 'person';
    const idx = match.index;
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + name.length + 120);
    const context = text.slice(start, end).replace(/\s+/g, ' ').trim();
    entities.push({ name, type, context, confidence: confidenceForEntity(name, type, context, '') });
  }
  return entities;
}

function normalizeDetectedName(raw: string): string | null {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const leadingSignalWords = new Set([
    'Met',
    'Meet',
    'Meeting',
    'Talked',
    'Called',
    'Emailed',
    'Visited',
    'Saw',
    'From',
    'With',
    'About',
    'Attendees',
  ]);
  while (words.length > 2 && leadingSignalWords.has(words[0]!)) {
    words.shift();
  }
  if (words.length < 2) return null;
  return words.join(' ');
}

function passesNotability(
  name: string,
  type: EnrichmentEntityType,
  context: string,
  sourceSlug: string,
  confidence: number,
): boolean {
  if (confidence < 0.45) return false;
  if (sourceSlug.startsWith('meetings/')) return true;
  if (type === 'company' && /\b(customer|vendor|partner|competitor|investor|prospect|supplier|platform|from|at)\b/i.test(context)) return true;
  if (type === 'person' && /\b(met|meeting|call|emailed|owner|manager|founder|ceo|cto|candidate|contact|reports to|from|at)\b/i.test(context)) return true;
  if (/\b(work|project|deal|contract|review|decision|risk|commitment|follow up|follow-up)\b/i.test(context)) return true;
  return name.split(/\s+/).length >= 2 && context.length >= 40;
}

function confidenceForEntity(name: string, type: EnrichmentEntityType, context: string, sourceSlug: string): number {
  let score = 0.45;
  if (name.split(/\s+/).length >= 2) score += 0.15;
  if (type === 'company') score += 0.1;
  if (sourceSlug.startsWith('meetings/')) score += 0.15;
  if (/\b(met|meeting|call|emailed|owner|manager|founder|ceo|cto|customer|partner|investor|from|at)\b/i.test(context)) score += 0.2;
  if (context.length >= 60) score += 0.05;
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

function buildEntityPage(
  name: string,
  type: EnrichmentEntityType,
  context: string,
  sourceSlug: string,
  citation: string,
  tier: 1 | 2 | 3,
) {
  const date = today();
  if (type === 'company') {
    return {
      type: 'company',
      title: name,
      compiled_truth: `# ${name}\n\n> ${name} was identified from ${sourceSlug}. ${trimContext(context)} ${citation}\n\n## State\n\n- **What:** [No data yet]\n- **Relationship:** unknown\n- **Internal owner:** [No data yet]\n- **Key people:** [No data yet]\n- **Current status:** unknown\n\n## Open Threads\n\n- [No data yet]\n\n<!-- timeline -->\n\n## Timeline\n`,
      timeline: `- ${date} | ${citation} - Identified from ${sourceSlug}: ${trimContext(context)}`,
      frontmatter: {
        type: 'company',
        title: name,
        relationship: 'unknown',
        tags: ['enriched'],
        source_refs: [sourceSlug],
        enrichment_tier: tier,
      },
    };
  }
  return {
    type: 'person',
    title: name,
    compiled_truth: `# ${name}\n\n> ${name} was identified from ${sourceSlug}. ${trimContext(context)} ${citation}\n\n## Ownership And Expertise\n\n- [No data yet]\n\n## Current Work\n\n- [No data yet]\n\n## Open Threads\n\n- [No data yet]\n\n## Collaboration Notes\n\n- [No data yet]\n\n## Related\n\n- [Source:] [[${sourceSlug}]]\n\n<!-- timeline -->\n\n## Timeline\n`,
    timeline: `- ${date} | ${citation} - Identified from ${sourceSlug}: ${trimContext(context)}`,
    frontmatter: {
      type: 'person',
      title: name,
      aliases: [],
      tags: ['enriched'],
      source_refs: [sourceSlug],
      enrichment_tier: tier,
    },
  };
}

async function maybeRunExternalEnrichment(
  engine: BrainEngine,
  opts: { sourceId: string; slug: string; tier: 1 | 2 | 3; enabled: boolean },
): Promise<ExternalEnrichmentResult> {
  const preview = await previewExternalEnrichment(engine, opts);
  if (preview.status !== 'reserved') return preview;
  const provider = preview.provider!;

  const cap = await readConfigNumber(engine, 'enrich.external.daily_cap_usd', 1);
  const ledger = new BudgetLedger(engine);
  const reservation = await ledger.reserve({
    resolverId: provider,
    estimateUsd: EXTERNAL_ESTIMATE_USD,
    capUsd: cap,
  });
  if (reservation.kind === 'exhausted') {
    return { attempted: false, provider, status: 'budget_exhausted', reason: reservation.reason };
  }

  try {
    await engine.putRawData(opts.slug, `external:${provider}`, {
      provider,
      status: 'adapter_not_configured',
      note: 'External resolver adapter is not wired in this MVP build; budget gate was exercised and local enrichment continued.',
      fetched_at: new Date().toISOString(),
    }, { sourceId: opts.sourceId });
    await ledger.rollback(reservation.reservationId);
    return { attempted: true, provider, status: 'failed', reason: 'external_adapter_not_configured' };
  } catch (err) {
    await ledger.rollback(reservation.reservationId);
    return { attempted: true, provider, status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function previewExternalEnrichment(
  engine: BrainEngine,
  opts: { tier: 1 | 2 | 3; enabled: boolean },
): Promise<ExternalEnrichmentResult> {
  if (!opts.enabled) return { attempted: false, status: 'skipped', reason: 'external_not_requested' };
  if (opts.tier === 3) return { attempted: false, status: 'skipped', reason: 'tier_3_local_only' };
  const enabled = await readConfigBool(engine, 'enrich.external.enabled');
  const provider = await readConfigString(engine, 'enrich.external.provider');
  if (!enabled || !provider) return { attempted: false, status: 'not_configured', reason: 'external_not_configured' };
  return { attempted: true, provider, status: 'reserved' };
}

async function readConfigString(engine: BrainEngine, key: string): Promise<string | null> {
  try {
    const v = await engine.getConfig(key);
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

async function readConfigBool(engine: BrainEngine, key: string): Promise<boolean> {
  const v = await readConfigString(engine, key);
  return v === 'true' || v === '1' || v === 'yes';
}

async function readConfigNumber(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const v = await readConfigString(engine, key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sourceCitation(sourceSlug: string): string {
  return `[Source: ${sourceSlug}, ${today()}]`;
}

function today(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

function trimContext(context: string): string {
  const normalized = context.replace(/\s+/g, ' ').trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function clampLimit(limit: unknown): number {
  const n = Number(limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

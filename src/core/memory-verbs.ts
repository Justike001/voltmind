import type { BrainEngine, FactRow } from './engine.ts';
import type { Operation } from './operations.ts';
import type { Page, SearchResult, TimelineEntry } from './types.ts';
import { stripFactsFence } from './facts-fence.ts';
import { stripTakesFence } from './takes-fence.ts';

const PROTOCOL_VERSION = 1;
const EDGE_CAP = 10;
const THREAD_CAP = 3;

interface CardEdgeRow {
  slug: string;
  link_type: string;
  context: string | null;
  direction: 'in' | 'out';
}

function textAliases(page: Page): string[] {
  const values = [page.frontmatter.aliases, page.frontmatter.aka]
    .flatMap(value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : [])
    .map(value => String(value).trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function safeSummary(page: Page, remote: boolean): string {
  const body = remote
    ? stripFactsFence(stripTakesFence(page.compiled_truth), { keepVisibility: ['world'] })
    : page.compiled_truth;
  return body.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function resolveKnownEntity(
  engine: BrainEngine,
  sourceIds: string[],
  name: string,
): Promise<{ sourceId: string; slug: string; alternatives: Array<{ source_id: string; slug: string }> } | null> {
  const { resolveEntitySlugWithSource } = await import('./entities/resolve.ts');
  const hits: Array<{ sourceId: string; slug: string }> = [];
  for (const sourceId of sourceIds) {
    const resolved = await resolveEntitySlugWithSource(engine, sourceId, name);
    if (resolved && resolved.source !== 'fallback_slugify') hits.push({ sourceId, slug: resolved.slug });
  }
  const first = hits[0];
  if (!first) return null;
  return {
    ...first,
    alternatives: hits.slice(1).map(hit => ({ source_id: hit.sourceId, slug: hit.slug })),
  };
}

async function nearMisses(engine: BrainEngine, sourceIds: string[], name: string) {
  const rows = await Promise.all(sourceIds.map(async sourceId => {
    try {
      const hits = await engine.searchKeyword(name, { sourceId, limit: 3 });
      return hits.map((hit: SearchResult) => ({
        source_id: hit.source_id,
        slug: hit.slug,
        title: hit.title,
        create_safety: 'unknown',
      }));
    } catch {
      return [];
    }
  }));
  return rows.flat().slice(0, 3);
}

async function loadEdges(engine: BrainEngine, sourceId: string, slug: string): Promise<CardEdgeRow[]> {
  try {
    return await engine.executeRaw<CardEdgeRow>(
      `SELECT x.slug, x.link_type, x.context, x.direction
       FROM (
         SELECT t.slug, l.link_type, l.context, 'out'::text AS direction, 0 AS ord
         FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
         WHERE f.slug = $1 AND f.source_id = $2 AND t.source_id = $2
           AND COALESCE(l.link_source, '') <> 'mentions'
         UNION ALL
         SELECT f.slug, l.link_type, l.context, 'in'::text AS direction, 1 AS ord
         FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
         WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2
           AND COALESCE(l.link_source, '') <> 'mentions'
       ) x ORDER BY x.ord, x.slug LIMIT ${EDGE_CAP}`,
      [slug, sourceId],
    );
  } catch {
    return [];
  }
}

async function buildCard(engine: BrainEngine, sourceId: string, slug: string, remote: boolean) {
  const page = await engine.getPage(slug, { sourceId });
  if (!page) return null;
  const visibility = remote ? (['world'] as const) : undefined;
  const [edges, timeline, facts, factCountRows, backlinkCountRows] = await Promise.all([
    loadEdges(engine, sourceId, slug),
    engine.getTimeline(slug, { sourceId, limit: 5 }).catch(() => [] as TimelineEntry[]),
    engine.listFactsByEntity(sourceId, slug, {
      activeOnly: true,
      limit: 100,
      ...(visibility ? { visibility: [...visibility] } : {}),
    }).catch(() => [] as FactRow[]),
    engine.executeRaw<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM facts
       WHERE source_id = $1 AND entity_slug = $2 AND expired_at IS NULL${remote ? " AND visibility = 'world'" : ''}`,
      [sourceId, slug],
    ).catch(() => []),
    engine.executeRaw<{ n: number | string }>(
      `SELECT COUNT(*) AS n
       FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
       WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2
         AND COALESCE(l.link_source, '') <> 'mentions'`,
      [slug, sourceId],
    ).catch(() => []),
  ]);

  const openThreads = facts
    .filter(fact => fact.kind === 'commitment')
    .slice(0, THREAD_CAP)
    .map(fact => ({ kind: 'commitment', text: fact.fact, date: iso(fact.valid_from) }));
  for (const entry of timeline) {
    if (openThreads.length >= THREAD_CAP) break;
    openThreads.push({ kind: 'recent_event', text: entry.summary, date: iso(entry.date) });
  }

  return {
    entity: { source_id: sourceId, slug, title: page.title, type: page.type },
    aka: textAliases(page),
    summary: safeSummary(page, remote),
    last_touched: {
      updated_at: iso(page.updated_at),
      last_timeline_date: timeline.length > 0 ? iso(timeline[0]?.date) : null,
    },
    open_threads: openThreads,
    edges,
    backlink_count: Number(backlinkCountRows[0]?.n ?? edges.filter(edge => edge.direction === 'in').length),
    active_fact_count: Number(factCountRows[0]?.n ?? facts.length),
  };
}

const entity: Operation = {
  name: 'entity',
  description:
    'Inspect one known person, company, or project as a compact structured card. Zero LLM calls. ' +
    'Resolves exact/fuzzy names within the caller\'s authorized sources and returns near misses on a miss.',
  params: {
    name: { type: 'string', required: true, description: 'Free-text entity name, alias-like title, or page slug.' },
  },
  scope: 'read',
  cliHints: { name: 'entity', positional: ['name'] },
  handler: async (ctx, params) => {
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!name) {
      const { OperationError } = await import('./operations.ts');
      throw new OperationError('invalid_params', 'name must be a non-empty string.');
    }
    const sourceIds = ctx.auth?.allowedSources?.length
      ? ctx.auth.allowedSources
      : [ctx.sourceId || 'default'];
    const started = Date.now();
    const resolved = await resolveKnownEntity(ctx.engine, sourceIds, name);
    if (!resolved) {
      return {
        protocol_version: PROTOCOL_VERSION,
        found: false,
        suggestions: await nearMisses(ctx.engine, sourceIds, name),
        latency_ms: Date.now() - started,
      };
    }
    const card = await buildCard(ctx.engine, resolved.sourceId, resolved.slug, ctx.remote !== false);
    if (!card) {
      return { protocol_version: PROTOCOL_VERSION, found: false, suggestions: [], latency_ms: Date.now() - started };
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      found: true,
      card,
      ...(resolved.alternatives.length > 0 ? { suggestions: resolved.alternatives } : {}),
      latency_ms: Date.now() - started,
    };
  },
};

const synthesize: Operation = {
  name: 'synthesize',
  description:
    '[EXPENSIVE / SLOW — makes LLM calls] Answer a broad question by combining evidence across pages, ' +
    'facts, takes, graph context, and temporal context. Read-only and available to thin clients over MCP.',
  params: {
    question: { type: 'string', required: true, description: 'Question that requires cross-page reasoning.' },
    since: { type: 'string', description: 'Optional ISO date/datetime lower bound.' },
    until: { type: 'string', description: 'Optional ISO date/datetime upper bound.' },
  },
  scope: 'read',
  cliHints: { name: 'synthesize', positional: ['question'] },
  handler: async (ctx, params) => {
    const question = typeof params.question === 'string' ? params.question.trim() : '';
    if (!question) {
      const { OperationError } = await import('./operations.ts');
      throw new OperationError('invalid_params', 'question must be a non-empty string.');
    }
    const { sourceScopeOpts, OperationError } = await import('./operations.ts');
    const { runThink } = await import('./think/index.ts');
    const { embedQuery } = await import('./embedding.ts');
    const scope = sourceScopeOpts(ctx);
    const result = await runThink(ctx.engine, {
      question,
      since: params.since ? String(params.since) : undefined,
      until: params.until ? String(params.until) : undefined,
      takesHoldersAllowList: ctx.takesHoldersAllowList,
      ...(scope.sourceId ? { sourceId: scope.sourceId } : {}),
      ...(scope.sourceIds ? { allowedSources: scope.sourceIds } : {}),
      remote: ctx.remote !== false,
      embedQuestion: query => embedQuery(query),
    });
    if (result.warnings.includes('NO_ANTHROPIC_API_KEY')) {
      throw new OperationError(
        'unavailable',
        'synthesize needs a configured chat model.',
        'Configure a chat provider on the Host; entity and recall remain available without one.',
      );
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      answer: result.answer,
      sources: [...new Set(result.citations.map(citation => citation.page_slug))],
      gaps: result.gaps,
      synthesis_status: result.warnings.includes('LLM_OUTPUT_NOT_JSON') ? 'degraded' : 'ok',
      pages_gathered: result.pagesGathered,
      takes_gathered: result.takesGathered,
      graph_hits: result.graphHits,
      warnings: result.warnings,
      cost: { model: result.modelUsed, input_tokens: null, output_tokens: null, usd_estimate: null },
    };
  },
};

export const memoryVerbOperations: Operation[] = [entity, synthesize];

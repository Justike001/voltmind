-- GBrain Postgres + pgvector schema

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- gen_random_uuid() is core in Postgres 13+; enable pgcrypto as fallback for older versions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- sources: multi-repo / multi-brain tenancy (v0.18.0)
-- ============================================================
-- A source is a logical brain-within-the-DB: wiki, gstack, yc-media, etc.
-- Every page/file/ingest_log row carries source_id.
--
-- id:         immutable citation key. [a-z0-9-]{1,32} enforced at app layer.
--             Used in [source:slug] citations, --source flag, wikilink syntax.
-- name:       mutable display label. Rename via `gbrain sources rename`.
-- local_path: optional git checkout root for filesystem-backed sources.
-- config:     forward-compat JSONB. Currently used for federation + ACL slot.
--             { "federated": bool, "access_policy": {...} }
--             - federated=true (or missing-but-explicit on 'default'):
--               participates in cross-source default search.
--             - federated=false (default for new sources):
--               only searched when explicitly named via --source.
--             - access_policy: forward-compat slot, no enforcement in v0.17.
--               Write-side lockdown: mutated only when ctx.remote=false.
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  local_path      TEXT,
  last_commit     TEXT,
  last_sync_at    TIMESTAMPTZ,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- v0.20.0 Cathedral II (SP-1): chunker version last used to sync this source.
  -- performSync forces a full walk when this mismatches CURRENT_CHUNKER_VERSION,
  -- bypassing the git-HEAD up_to_date early-return so CHUNKER_VERSION bumps
  -- actually trigger re-chunking on upgrade.
  chunker_version TEXT,
  -- v0.26.5: soft-delete + recovery window. `archive` flips archived=true and
  -- sets archive_expires_at = now() + 72h. The autopilot purge phase
  -- hard-deletes rows where archive_expires_at <= now(). Promoted from a
  -- JSONB key to real columns to avoid reserved-key footguns and to make the
  -- search visibility filter (`NOT s.archived`) a column lookup.
  archived            BOOLEAN NOT NULL DEFAULT false,
  archived_at         TIMESTAMPTZ,
  archive_expires_at  TIMESTAMPTZ,
  -- v0.40.3.0: per-source CR mode override + mount-frontmatter trust gate.
  -- contextual_retrieval_mode NULL = fall through to global mode bundle.
  -- trust_frontmatter_overrides FALSE for mounts by default; host source
  -- (id='default') is always trusted regardless of this column.
  contextual_retrieval_mode   TEXT,
  trust_frontmatter_overrides BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the default source. 'default' is federated=true for backward compat
-- (pre-v0.17 brains behave exactly as before — every page appears in search).
-- Pre-existing sync.repo_path / sync.last_commit are copied in by the v16
-- migration, not here; fresh installs have no local_path until `sources add`
-- or the first `sync`.
INSERT INTO sources (id, name, config)
  VALUES ('default', 'default', '{"federated": true}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- v0.40 Federated Sync v2: partial expression index on config->>'github_repo'
-- so POST /webhooks/github's source-by-repo lookup hits an index. Only rows
-- with a configured webhook actually take up index entries. Both Postgres and
-- PGLite support partial expression indexes. Migration v87 installs the same
-- index on legacy brains (idempotent IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS sources_github_repo_idx
  ON sources ((config->>'github_repo'))
  WHERE config ? 'github_repo';

-- ============================================================
-- pages: the core content table
-- ============================================================
-- v0.18.0 (Step 2): pages.source_id scopes each row to a sources(id) row.
-- Slugs are unique per source, NOT globally. The default source is
-- seeded in the sources block above so the DEFAULT 'default' FK is
-- always valid at INSERT time.
CREATE TABLE IF NOT EXISTS pages (
  id            SERIAL PRIMARY KEY,
  source_id     TEXT    NOT NULL DEFAULT 'default'
                REFERENCES sources(id) ON DELETE CASCADE,
  slug          TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  -- v0.19.0: distinguishes markdown vs code pages at the DB level.
  -- Drives orphans filter, auto-link bypass, and `query --lang`.
  page_kind     TEXT    NOT NULL DEFAULT 'markdown'
                CHECK (page_kind IN ('markdown','code','image')),
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  timeline      TEXT    NOT NULL DEFAULT '',
  frontmatter   JSONB   NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  source_payload_hash TEXT,
  file_refs_projection_hash TEXT,
  -- v0.29: deterministic 0..1 score (tag emotion + take density + Garry-as-holder ratio).
  -- Populated by the `recompute_emotional_weight` cycle phase. Default 0.0 so freshly
  -- imported pages don't pollute salience ranking before the cycle has run.
  emotional_weight REAL NOT NULL DEFAULT 0.0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v0.26.5: soft-delete + recovery window. `delete_page` sets deleted_at = now()
  -- instead of issuing DELETE. The autopilot purge phase hard-deletes pages
  -- where deleted_at < now() - 72h. Search and `get_page` filter
  -- `WHERE deleted_at IS NULL` by default; `include_deleted: true` opts in.
  deleted_at    TIMESTAMPTZ,
  -- v0.29.1: salience-and-recency, additive opt-in. All NULL by default;
  -- only consulted when a caller passes `salience='on'` / `recency='on'` or
  -- the new `since`/`until` filter. effective_date_source is a sentinel for
  -- the doctor's effective_date_health check (values: 'event_date' | 'date'
  -- | 'published' | 'filename' | 'fallback'). salience_touched_at is bumped
  -- by recompute_emotional_weight when emotional_weight changes so the
  -- salience window picks up newly-salient old pages.
  effective_date        TIMESTAMPTZ,
  effective_date_source TEXT,
  import_filename       TEXT,
  salience_touched_at   TIMESTAMPTZ,
  -- v0.37.0 (migration v79): real stale-page signal for `gbrain lsd`. Bumped
  -- by op-layer write-back inside `search`/`query`/`get_page` op handlers
  -- (NOT inside engine methods — internal callers must not pollute the
  -- signal). NULL = never retrieved (LSD prioritizes these first).
  last_retrieved_at     TIMESTAMPTZ,
  -- v0.40.3.0 contextual retrieval (renumbered from v81 to v90 on master
  -- merge). contextual_retrieval_mode is what tier the page was last embedded
  -- under (NULL = pre-v90 = treated as 'none' for drift detection).
  -- corpus_generation is the composite hash of (synopsis_prompt_version,
  -- haiku_model, title_wrapper_version, embedding_model) — document-side
  -- provenance for query_cache invalidation per D27 P1-5. NULL means pre-v90;
  -- the page_generations JSONB check correctly invalidates pre-v90 cache
  -- rows against any current generation.
  contextual_retrieval_mode  TEXT,
  corpus_generation          TEXT,
  -- v0.40.3.0 cache invalidation gate (migration v91). Monotonic per-page
  -- counter bumped by bump_page_generation_trg on INSERT (initial value =
  -- MAX(generation) + 1 so the bookmark fires for any cache row stored
  -- before this page existed — codex #4) and on UPDATE when any column in
  -- the content allow-list IS DISTINCT FROM. Read by the per-page snapshot
  -- check in query-cache-gate.ts.
  generation     BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)
);

-- v0.40.3.0 cache invalidation trigger (migration v91; mirrored in
-- src/core/pglite-schema.ts). BEFORE INSERT OR UPDATE so every write path
-- bumps generation per D6 / codex #4. INSERT: pages get
-- COALESCE(MAX(generation), 0) + 1 so the bookmark gate fires for any
-- cache row stored before the new page existed. UPDATE: bumps only when
-- content columns IS DISTINCT FROM (allow-list widened per D6 + codex #3
-- to include title/type/page_kind/corpus_generation/content_hash) so
-- read-time mutations don't invalidate every cache row.
CREATE OR REPLACE FUNCTION bump_page_generation_fn() RETURNS trigger SET search_path = pg_catalog, public AS $func$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.generation := COALESCE((SELECT MAX(generation) FROM pages), 0) + 1;
  ELSIF (OLD.compiled_truth IS DISTINCT FROM NEW.compiled_truth)
     OR (OLD.timeline IS DISTINCT FROM NEW.timeline)
     OR (OLD.frontmatter IS DISTINCT FROM NEW.frontmatter)
     OR (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
     OR (OLD.contextual_retrieval_mode IS DISTINCT FROM NEW.contextual_retrieval_mode)
     OR (OLD.title IS DISTINCT FROM NEW.title)
     OR (OLD.type IS DISTINCT FROM NEW.type)
     OR (OLD.page_kind IS DISTINCT FROM NEW.page_kind)
     OR (OLD.corpus_generation IS DISTINCT FROM NEW.corpus_generation)
     OR (OLD.content_hash IS DISTINCT FROM NEW.content_hash)
  THEN
    NEW.generation := OLD.generation + 1;
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_page_generation_trg ON pages;
CREATE TRIGGER bump_page_generation_trg
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION bump_page_generation_fn();

-- v0.40.3.0 supports O(log N) MAX(generation) for the Layer 1 bookmark
-- check in query-cache-gate.ts. Plain btree (DESC unnecessary; Postgres
-- backward-scans plain btrees for MAX per codex #8). CONCURRENTLY would
-- be used inside a migration; in the schema-bootstrap path it's a plain
-- CREATE INDEX since the table is empty.
CREATE INDEX IF NOT EXISTS pages_generation_idx ON pages (generation);

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN(title gin_trgm_ops);
-- v0.13.1 #170: avoids 14.6s seqscan on large brains when listing pages newest-first.
CREATE INDEX IF NOT EXISTS idx_pages_updated_at_desc ON pages (updated_at DESC);
-- v0.18.0: source-scoped scans (per /plan-eng-review Section 4).
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
-- v0.26.5: partial index supports the autopilot purge sweep
-- (`WHERE deleted_at IS NOT NULL AND deleted_at < now() - INTERVAL '72 hours'`).
-- Search filters (`WHERE deleted_at IS NULL`) do not benefit from this index
-- (predicate doesn't match) and don't need their own — soft-deleted cardinality
-- stays low. Don't add a regular `(deleted_at)` index without measuring.
CREATE INDEX IF NOT EXISTS pages_deleted_at_purge_idx
  ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
-- v0.37.0: full B-tree index on last_retrieved_at supports LSD's stale-page
-- query `WHERE last_retrieved_at IS NULL OR last_retrieved_at < NOW() -
-- INTERVAL '90 days'`. Postgres handles NULL in B-tree indexes (sorted to
-- one end) so one index covers both branches. A partial WHERE NOT NULL
-- would miss the NULL branch that LSD prioritizes (codex round 2 #6).
CREATE INDEX IF NOT EXISTS pages_last_retrieved_at_idx
  ON pages (last_retrieved_at);
-- v0.29.1: expression index used by since/until date-range filters that read
-- COALESCE(effective_date, updated_at). A partial index on effective_date
-- alone would NOT help — the planner can't use it for the negative side of
-- the COALESCE. Expression index is what actually accelerates the filter.
CREATE INDEX IF NOT EXISTS pages_coalesce_date_idx
  ON pages ((COALESCE(effective_date, updated_at)));

-- ============================================================
-- content_chunks: chunked content with embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id                    SERIAL PRIMARY KEY,
  page_id               INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index           INTEGER NOT NULL,
  chunk_text            TEXT    NOT NULL,
  chunk_source          TEXT    NOT NULL DEFAULT 'compiled_truth',
  -- Company-internal Qwen3-VL embeddings are native 2048d. `halfvec` keeps
  -- that width while still permitting HNSW (plain vector HNSW stops at 2000d).
  embedding             halfvec(2048),
  model                 TEXT    NOT NULL DEFAULT 'qwen-vllm:./models/Qwen3-VL-Embedding-2B',
  token_count           INTEGER,
  embedded_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v0.19.0: code chunk metadata. Nullable — markdown chunks leave these NULL.
  -- Powers `query --lang`, `code-def <symbol>`, and `code-refs <symbol>`.
  language              TEXT,
  symbol_name           TEXT,
  symbol_type           TEXT,
  start_line            INTEGER,
  end_line              INTEGER,
  -- v0.20.0 Cathedral II: qualified symbol identity + parent scope + doc-comment
  -- + chunk-grain FTS. All nullable — markdown chunks leave these NULL.
  parent_symbol_path    TEXT[],
  doc_comment           TEXT,
  symbol_name_qualified TEXT,
  search_vector         TSVECTOR,
  -- Unified Qwen3-VL retrieval space. Text, images, and mixed content all
  -- use native 2048d vectors so cross-modal similarity is meaningful.
  modality              TEXT NOT NULL DEFAULT 'text',
  embedding_image       halfvec(2048),
  embedding_multimodal  halfvec(2048)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding halfvec_cosine_ops);
-- v0.19.0: partial indexes — only code chunks populate these columns.
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_language ON content_chunks(language) WHERE language IS NOT NULL;
-- v0.27.1: partial HNSW for multimodal images. Footprint stays proportional
-- to image-chunk count, not table size.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_image
  ON content_chunks USING hnsw (embedding_image halfvec_cosine_ops)
  WHERE embedding_image IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_multimodal
  ON content_chunks USING hnsw (embedding_multimodal halfvec_cosine_ops)
  WHERE embedding_multimodal IS NOT NULL;
-- v0.20.0 Cathedral II: GIN index on the new chunk-grain FTS vector.
CREATE INDEX IF NOT EXISTS idx_chunks_search_vector ON content_chunks USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_qualified
  ON content_chunks(symbol_name_qualified) WHERE symbol_name_qualified IS NOT NULL;
-- v0.41.18.0 (codex finding #9): partial index for `gbrain embed --stale`
-- + `--priority recent`. content_chunks has no updated_at column (chunks
-- are re-INSERTed on page change, not UPDATEd), so the "recent-first"
-- ORDER BY happens at the JOIN site: outer ORDER BY p.updated_at DESC
-- uses idx_pages_updated_at_desc; inner partial uses this index.
CREATE INDEX IF NOT EXISTS content_chunks_stale_idx
  ON content_chunks(page_id, chunk_index) WHERE embedding IS NULL;

-- v0.20.0 Cathedral II: chunk-grain FTS trigger.
-- Weight 'A' on doc_comment + symbol_name_qualified; weight 'B' on chunk_text.
-- NL queries ("how do we handle errors") rank doc-comment hits above body text.
-- BEFORE INSERT OR UPDATE OF specific columns — only refires when those change,
-- not on every chunk update (e.g., embedding refresh doesn't trigger rebuild).
CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.doc_comment, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.chunk_text, '')), 'B');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
CREATE TRIGGER chunk_search_vector_trigger
  BEFORE INSERT OR UPDATE OF chunk_text, doc_comment, symbol_name_qualified
  ON content_chunks
  FOR EACH ROW EXECUTE FUNCTION update_chunk_search_vector();

-- ============================================================
-- code_edges_chunk + code_edges_symbol: v0.20.0 Cathedral II structural edges
-- ============================================================
-- Two-table design (codex F4 + SP-7):
--   - code_edges_chunk: resolved edges (both endpoints = known chunk IDs)
--   - code_edges_symbol: unresolved refs (target known by qualified name,
--     defining chunk not yet imported)
-- Readers UNION both tables; no promotion step.
-- Source scoping: from_chunk_id -> content_chunks -> pages.source_id
-- determines the source. Resolution logic MUST scope on source (codex SP-3);
-- only --all-sources callers bypass this. UNIQUE keys don't include source_id
-- because from_chunk_id already pins it.
CREATE TABLE IF NOT EXISTS code_edges_chunk (
  id                    SERIAL PRIMARY KEY,
  from_chunk_id         INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  to_chunk_id           INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type             TEXT NOT NULL,
  edge_metadata         JSONB NOT NULL DEFAULT '{}',
  source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT code_edges_chunk_unique UNIQUE (from_chunk_id, to_chunk_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_from
  ON code_edges_chunk(from_chunk_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_to
  ON code_edges_chunk(to_chunk_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_to_symbol
  ON code_edges_chunk(to_symbol_qualified, edge_type);

CREATE TABLE IF NOT EXISTS code_edges_symbol (
  id                    SERIAL PRIMARY KEY,
  from_chunk_id         INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type             TEXT NOT NULL,
  edge_metadata         JSONB NOT NULL DEFAULT '{}',
  source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT code_edges_symbol_unique UNIQUE (from_chunk_id, to_symbol_qualified, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_from
  ON code_edges_symbol(from_chunk_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_to
  ON code_edges_symbol(to_symbol_qualified, edge_type);

-- ============================================================
-- links: cross-references between pages
-- ============================================================
-- Provenance model (v0.13):
--   link_source       — 'markdown' | 'frontmatter' | 'manual' | NULL
--                       (NULL = legacy row written before v0.13; unknown source)
--   origin_page_id    — for link_source='frontmatter', the page whose YAML
--                       frontmatter created this edge; scopes reconciliation
--   origin_field      — the frontmatter field name (e.g. 'key_people')
--
-- The unique constraint includes link_source + origin_page_id so a manual edge
-- and a frontmatter-derived edge with the same (from, to, type) tuple coexist.
-- Reconciliation on put_page filters by (link_source='frontmatter' AND
-- origin_page_id = written_page) — never touches other pages' edges.
CREATE TABLE IF NOT EXISTS links (
  id             SERIAL PRIMARY KEY,
  from_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type      TEXT    NOT NULL DEFAULT '',
  context        TEXT    NOT NULL DEFAULT '',
  -- v0.41.18.0: 'mentions' added for auto-linked body-text mentions
  -- (gbrain extract links --by-mention). Filtered OUT of backlink-count
  -- for search ranking; only counts toward orphan-ratio + graph traversal.
  link_source    TEXT    CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual', 'mentions')),
  -- v0.41.18.0: nullable link_kind distinguishes "plain body mention" from
  -- "verb-pattern-derived typed link" within link_source='mentions'.
  -- Codex finding #12 design: keep link_source stable; add link_kind
  -- so callers can distinguish without breaking existing mentions queries.
  -- NULL = legacy / unknown / pre-v98 row (semantically 'plain').
  link_kind      TEXT    CHECK (link_kind IS NULL OR link_kind IN ('plain', 'typed_ner')),
  origin_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  origin_field   TEXT,
  -- v0.18.0 Step 4: 'qualified' when the link was written as
  -- [[source:slug]] (target source pinned). 'unqualified' when written
  -- as bare [[slug]] and resolved via local-first fallback at
  -- extraction time. NULL for legacy/manual/frontmatter edges.
  resolution_type TEXT   CHECK (resolution_type IS NULL OR resolution_type IN ('qualified', 'unqualified')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT (PG15+) so two rows with link_source IS NULL or
  -- origin_page_id IS NULL collide as expected. Without this, every row with
  -- NULL origin_page_id (markdown/manual edges) would be treated as unique.
  CONSTRAINT links_from_to_type_source_origin_unique
    UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(link_source);
CREATE INDEX IF NOT EXISTS idx_links_origin ON links(origin_page_id);

-- ============================================================
-- tags
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
  id      SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  UNIQUE(page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);

-- ============================================================
-- raw_data: sidecar data (replaces .raw/ JSON files)
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_data (
  id         SERIAL PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  data       JSONB   NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, source)
);

CREATE INDEX IF NOT EXISTS idx_raw_data_page ON raw_data(page_id);

-- ============================================================
-- timeline_entries: structured timeline
-- ============================================================
CREATE TABLE IF NOT EXISTS timeline_entries (
  id       SERIAL PRIMARY KEY,
  page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date     DATE    NOT NULL,
  source   TEXT    NOT NULL DEFAULT '',
  summary  TEXT    NOT NULL,
  detail   TEXT    NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);
-- v0.41.18.0 (codex finding #11): widened from (page_id, date, summary) to
-- include `source` so distinct meeting provenance survives. Legacy rows
-- have source='' (schema default) so legacy dedup behavior is preserved.
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup ON timeline_entries(page_id, date, summary, source);

-- ============================================================
-- page_versions: snapshot history for compiled_truth
-- ============================================================
CREATE TABLE IF NOT EXISTS page_versions (
  id             SERIAL PRIMARY KEY,
  page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth TEXT    NOT NULL,
  timeline       TEXT    NOT NULL DEFAULT '',
  frontmatter    JSONB   NOT NULL DEFAULT '{}',
  content_hash   TEXT,
  source_payload_hash TEXT,
  file_refs_projection_hash TEXT,
  snapshot_kind  TEXT NOT NULL DEFAULT 'client_semantic_update',
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id);

-- ============================================================
-- ingest_log
-- ============================================================
-- v0.31.2 (codex P1 #3): source_id added so facts:absorb logging
-- (runFactsBackstop / writeFactsAbsorbLog) and doctor's
-- facts_extraction_health check can scope failure counts per source.
-- Migration v47 ALTERs existing brains; this inline definition covers
-- fresh installs.
CREATE TABLE IF NOT EXISTS ingest_log (
  id            SERIAL PRIMARY KEY,
  source_id     TEXT    NOT NULL DEFAULT 'default',
  source_type   TEXT    NOT NULL,
  source_ref    TEXT    NOT NULL,
  pages_updated JSONB   NOT NULL DEFAULT '[]',
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_log_source_type_created
  ON ingest_log (source_id, source_type, created_at DESC);

-- ============================================================
-- config: brain-level settings
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('version', '1'),
  ('embedding_model', 'qwen-vllm:./models/Qwen3-VL-Embedding-2B'),
  ('embedding_dimensions', '2048'),
  ('chunk_strategy', 'semantic')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- access_tokens: bearer tokens for remote MCP access
-- ============================================================
CREATE TABLE IF NOT EXISTS access_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  -- v0.42 #7: legacy bearer tokens now carry an explicit scope set. Default
  -- read+write (NOT admin) so `auth create` no longer mints unconditional
  -- admin tokens — the documented largest hole. Existing NULL rows backfill
  -- to read+write+admin by migration v113 to preserve their behavior.
  scopes       TEXT[] NOT NULL DEFAULT '{"read","write"}',
  -- v0.42 #6: source axis for the access_tokens RLS policy. Default 'default'
  -- matches the legacy verify path's sourceId fallback.
  source_id    TEXT   NOT NULL DEFAULT 'default',
  created_at   TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash) WHERE revoked_at IS NULL;

-- ============================================================
-- mcp_request_log: usage logging for remote MCP requests
-- ============================================================
CREATE TABLE IF NOT EXISTS mcp_request_log (
  id            SERIAL PRIMARY KEY,
  token_name    TEXT,
  agent_name    TEXT,
  operation     TEXT NOT NULL,
  latency_ms    INTEGER,
  status        TEXT NOT NULL DEFAULT 'success',
  params        JSONB,
  error_message TEXT,
  -- v0.42 audit-tenant axis: which source the caller acted on. NULL for
  -- pre-auth failures (no resolved source) and historical rows. Backfilled
  -- from oauth_clients.source_id by migration v110; legacy access_tokens
  -- rows default to 'default'. Lets an operator reconstruct "which source
  -- did this token touch" from the audit trail — impossible pre-v0.42.
  source_id     TEXT,
  -- v0.42 audit-tenant axis: which brain/mount the request targeted.
  -- NULL when the transport didn't resolve a brain id (legacy HTTP transport,
  -- pre-v0.42 rows). Not indexed — source_id is the primary filter axis.
  brain_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v0.42: source-scoped audit queries ("show me every source-X request in
-- the last 24h"). Partial so the index stays small — NULL source_id rows
-- (pre-auth failures, pre-v0.42 history) are skipped.
CREATE INDEX IF NOT EXISTS idx_mcp_log_source_id
  ON mcp_request_log (source_id, created_at DESC)
  WHERE source_id IS NOT NULL;

-- ============================================================
-- OAuth 2.1: clients, tokens, authorization codes
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id               TEXT PRIMARY KEY,
  client_secret_hash      TEXT,
  client_name             TEXT NOT NULL,
  contact_email           TEXT,
  redirect_uris           TEXT[],
  grant_types             TEXT[] DEFAULT '{"client_credentials"}',
  scope                   TEXT,
  token_endpoint_auth_method TEXT,
  client_id_issued_at     BIGINT,
  client_secret_expires_at BIGINT,
  token_ttl               INTEGER,
  deleted_at              TIMESTAMPTZ,
  source_id               TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  federated_read          TEXT[] NOT NULL DEFAULT '{}',
  -- v0.38 Slice 2 + 3: per-client daily budget cap (v84) + agent binding (v85).
  budget_usd_per_day      NUMERIC(10, 2) NULL,
  bound_tools             TEXT[] NULL,
  bound_source_id         TEXT NULL,
  bound_brain_id          TEXT NULL,
  bound_slug_prefixes     TEXT[] NULL,
  bound_max_concurrent    INTEGER NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- v0.34.1 (#861, D13 + #876): source_id is the write-source scope;
-- federated_read is the read-source array. Migrations v60-v65 land both
-- columns on upgrade; fresh installs include them inline above.
CREATE INDEX IF NOT EXISTS idx_oauth_clients_source_id
  ON oauth_clients(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_clients_federated_read
  ON oauth_clients USING GIN (federated_read);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  token_type   TEXT NOT NULL,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes       TEXT[],
  expires_at   BIGINT,
  resource     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash              TEXT PRIMARY KEY,
  client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes                 TEXT[],
  code_challenge         TEXT NOT NULL,
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256',
  redirect_uri           TEXT NOT NULL,
  state                  TEXT,
  resource               TEXT,
  expires_at             BIGINT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Composite indexes for admin dashboard request log queries
CREATE INDEX IF NOT EXISTS idx_mcp_log_time_agent ON mcp_request_log(created_at, token_name);
CREATE INDEX IF NOT EXISTS idx_mcp_log_agent_time ON mcp_request_log(agent_name, created_at DESC);

-- ============================================================
-- op_checkpoints: shared checkpoint table for long-running ops
-- ============================================================
-- v0.36+ autonomous-remediation wave (migration v67). Pre-fix each op
-- carried its own file-backed checkpoint (or none); that broke on
-- Postgres multi-worker hosts and fingerprint-collided across param
-- variations. Fingerprint = sha8 of canonical-JSON of relevant params
-- per op (mode, source, chunker_version, embedding_model+dims, etc.).
-- completed_keys = op-defined string array. GC: cycle purge phase
-- drops rows older than 7 days.
CREATE TABLE IF NOT EXISTS op_checkpoints (
  op             TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  completed_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (op, fingerprint)
);
CREATE INDEX IF NOT EXISTS op_checkpoints_updated_at_idx
  ON op_checkpoints (updated_at);

-- ============================================================
-- migration_impact_log: before/after metric stats per onboard remediation
-- ============================================================
-- v0.41.18.0 (gbrain onboard wave). Every completion captured by the
-- ============================================================
-- files: binary attachments stored in Supabase Storage
-- ============================================================
-- v0.18.0 Step 7: files gains source_id + page_id alongside the
-- legacy page_slug (kept for backward compat until a later release).
-- The file_migration_ledger below drives the storage object rewrite.
-- page_slug FK had ON UPDATE CASCADE — removed because slugs are no
-- longer global (composite UNIQUE) so CASCADE on-update is ambiguous.
-- ON DELETE SET NULL is preserved via both page_slug and page_id.
CREATE TABLE IF NOT EXISTS files (
  id           SERIAL PRIMARY KEY,
  source_id    TEXT   NOT NULL DEFAULT 'default'
               REFERENCES sources(id) ON DELETE CASCADE,
  page_slug    TEXT,
  page_id      INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  filename     TEXT   NOT NULL,
  storage_path TEXT   NOT NULL,
  mime_type    TEXT,
  size_bytes   BIGINT,
  content_hash TEXT   NOT NULL,
  metadata     JSONB  NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v0.42 (#861 audit follow-up): scope the path uniqueness to the source
  -- so two sources with the same slug can each hold a file of the same
  -- name without ON CONFLICT overwriting the other source's row. Pre-v0.42
  -- the bare UNIQUE(storage_path) was global, so a same-slug upload in
  -- source B rewrote source A's metadata (content_hash/mime/size) while
  -- leaving source_id pointing at A — a cross-source attribution break.
  -- Migration v111 swaps the constraint on upgrade.
  UNIQUE(source_id, storage_path)
);

-- Migration: drop storage_url if it exists (renamed to storage_path only)
ALTER TABLE files DROP COLUMN IF EXISTS storage_url;

CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_slug);
CREATE INDEX IF NOT EXISTS idx_files_page_id ON files(page_id);
CREATE INDEX IF NOT EXISTS idx_files_source_id ON files(source_id);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

-- ============================================================
-- external_file_refs: stable cloud or shared-filesystem identities
-- ============================================================
CREATE TABLE IF NOT EXISTS external_file_refs (
  id                    SERIAL PRIMARY KEY,
  source_id             TEXT NOT NULL DEFAULT 'default'
                        REFERENCES sources(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL DEFAULT 'microsoft',
  service               TEXT NOT NULL,
  tenant_id             TEXT NOT NULL,
  drive_id              TEXT NOT NULL,
  item_id               TEXT NOT NULL,
  name                  TEXT NOT NULL,
  display_path          TEXT,
  web_url               TEXT,
  root_key              TEXT,
  relative_path         TEXT,
  open_path             TEXT,
  file_id               TEXT,
  mime_type             TEXT,
  size_bytes            BIGINT,
  e_tag                 TEXT,
  c_tag                 TEXT,
  last_modified_at      TIMESTAMPTZ,
  availability          TEXT NOT NULL DEFAULT 'unverified',
  materialized_page_id  INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  materialized_etag     TEXT,
  materialized_stale    BOOLEAN NOT NULL DEFAULT false,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT external_file_refs_identity UNIQUE (source_id, provider, tenant_id, drive_id, item_id),
  CONSTRAINT external_file_refs_provider CHECK (provider IN ('microsoft', 'filesystem')),
  CONSTRAINT external_file_refs_service CHECK (service IN ('sharepoint', 'onedrive', 'raidrive')),
  CONSTRAINT external_file_refs_availability CHECK (availability IN ('accessible', 'denied', 'missing', 'unverified'))
);
ALTER TABLE external_file_refs ADD COLUMN IF NOT EXISTS materialized_stale BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS external_file_refs_source_idx ON external_file_refs(source_id);
CREATE INDEX IF NOT EXISTS external_file_refs_search_idx ON external_file_refs
  USING GIN (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(display_path, '') || ' ' ||
    coalesce(web_url, '') || ' ' || coalesce(root_key, '') || ' ' || coalesce(relative_path, '')));
CREATE INDEX IF NOT EXISTS external_file_refs_logical_path_idx
  ON external_file_refs(source_id, root_key, lower(relative_path))
  WHERE provider = 'filesystem';
CREATE INDEX IF NOT EXISTS external_file_refs_file_id_idx
  ON external_file_refs(source_id, root_key, file_id)
  WHERE provider = 'filesystem' AND file_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS page_external_file_refs (
  page_id          INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  file_ref_id      INTEGER NOT NULL REFERENCES external_file_refs(id) ON DELETE CASCADE,
  relation         TEXT NOT NULL,
  origin_key       TEXT NOT NULL,
  platform         TEXT,
  conversation_id  TEXT,
  message_id       TEXT,
  source_uri       TEXT,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, file_ref_id, relation, origin_key)
);
CREATE INDEX IF NOT EXISTS page_external_file_refs_file_idx ON page_external_file_refs(file_ref_id);
CREATE INDEX IF NOT EXISTS page_external_file_refs_page_idx ON page_external_file_refs(page_id);

CREATE TABLE IF NOT EXISTS ingestion_event_state (
  source_id       TEXT NOT NULL,
  source_kind     TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  event_version   TEXT,
  slug            TEXT,
  page_id         INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  content_hash    TEXT,
  source_payload_hash TEXT,
  file_refs_projection_hash TEXT,
  hash_scheme     TEXT,
  job_id          INTEGER,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  PRIMARY KEY (source_id, source_kind, event_id)
);
CREATE INDEX IF NOT EXISTS ingestion_event_state_received_idx ON ingestion_event_state(received_at DESC);

CREATE TABLE IF NOT EXISTS project_tracking_receipts (
  page_source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  event_source_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  event_version TEXT,
  content_hash TEXT,
  source_payload_hash TEXT,
  render_hash TEXT,
  file_refs_projection_hash TEXT,
  conflict_kind TEXT,
  evidence_slug TEXT,
  outcome TEXT NOT NULL,
  matched_by TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_source_id, event_source_id, event_kind, event_key, target_type, target_slug),
  CHECK (target_type IN ('project', 'workstream', 'review', 'evidence')),
  CHECK (outcome IN ('applied', 'candidate', 'skipped', 'failed', 'pending', 'registered', 'verified', 'repairing', 'review_needed', 'conflict'))
);
CREATE INDEX IF NOT EXISTS project_tracking_receipts_source_idx ON project_tracking_receipts(page_source_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS project_tracking_receipts_target_idx ON project_tracking_receipts(page_source_id, target_slug, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_tracking_receipt_history (
  id BIGSERIAL PRIMARY KEY,
  page_source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  event_source_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  event_version TEXT,
  content_hash TEXT NOT NULL,
  source_payload_hash TEXT,
  render_hash TEXT,
  file_refs_projection_hash TEXT,
  snapshot_kind TEXT NOT NULL DEFAULT 'source_ingest',
  conflict_kind TEXT,
  evidence_slug TEXT,
  outcome TEXT NOT NULL,
  matched_by TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  supersedes_content_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (target_type IN ('project', 'workstream', 'review', 'evidence')),
  CHECK (outcome IN ('applied', 'candidate', 'skipped', 'failed', 'pending', 'registered', 'verified', 'repairing', 'review_needed', 'conflict')),
  UNIQUE (page_source_id, event_source_id, event_kind, event_key, target_type, target_slug, content_hash)
);
CREATE INDEX IF NOT EXISTS project_tracking_receipt_history_source_idx ON project_tracking_receipt_history(page_source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_tracking_receipt_history_target_idx ON project_tracking_receipt_history(page_source_id, target_slug, created_at DESC);

-- ============================================================
-- file_migration_ledger (v0.18.0 Step 7)
-- Drives the storage-object rewrite performed by the v0_18_0
-- orchestrator's phase B. Keyed on file_id so two sources can share
-- an old path during migration without PK collision (Codex second-
-- pass caught this).
-- Status state machine: pending → copy_done → db_updated → complete
-- ============================================================
CREATE TABLE IF NOT EXISTS file_migration_ledger (
  file_id           INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  storage_path_old  TEXT   NOT NULL,
  storage_path_new  TEXT   NOT NULL,
  status            TEXT   NOT NULL DEFAULT 'pending',
  error             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ledger_status CHECK (status IN ('pending','copy_done','db_updated','complete','failed'))
);
CREATE INDEX IF NOT EXISTS idx_file_migration_ledger_status
  ON file_migration_ledger(status) WHERE status != 'complete';

-- ============================================================
-- Trigger-based search_vector (spans pages + timeline_entries)
-- ============================================================
ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN(search_vector);

-- Function to rebuild search_vector for a page
CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $$
DECLARE
  timeline_text TEXT;
BEGIN
  -- Gather timeline_entries text for this page
  SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
  INTO timeline_text
  FROM timeline_entries
  WHERE page_id = NEW.id;

  -- Build weighted tsvector
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.compiled_truth, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(timeline_text, '')), 'C');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
CREATE TRIGGER trg_pages_search_vector
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION update_page_search_vector();

-- Note: timeline_entries trigger removed (v0.10.1).
-- Structured timeline_entries power temporal queries (graph layer).
-- The markdown timeline section in pages.timeline still feeds search_vector via
-- the trg_pages_search_vector trigger above. Removing the timeline_entries
-- trigger avoids double-weighting the same content in search and prevents
-- mutation-induced reordering during timeline-extract pagination.
DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
DROP FUNCTION IF EXISTS update_page_search_vector_from_timeline();

-- ============================================================
-- Minion Jobs: BullMQ-inspired Postgres-native job queue
-- ============================================================
CREATE TABLE IF NOT EXISTS minion_jobs (
  id               SERIAL PRIMARY KEY,
  name             TEXT        NOT NULL,
  queue            TEXT        NOT NULL DEFAULT 'default',
  status           TEXT        NOT NULL DEFAULT 'waiting',
  priority         INTEGER     NOT NULL DEFAULT 0,
  data             JSONB       NOT NULL DEFAULT '{}',
  source_id        TEXT,
  max_attempts     INTEGER     NOT NULL DEFAULT 3,
  attempts_made    INTEGER     NOT NULL DEFAULT 0,
  attempts_started INTEGER     NOT NULL DEFAULT 0,
  backoff_type     TEXT        NOT NULL DEFAULT 'exponential',
  backoff_delay    INTEGER     NOT NULL DEFAULT 1000,
  backoff_jitter   REAL        NOT NULL DEFAULT 0.2,
  stalled_counter  INTEGER     NOT NULL DEFAULT 0,
  max_stalled      INTEGER     NOT NULL DEFAULT 5,
  lock_token       TEXT,
  lock_until       TIMESTAMPTZ,
  delay_until      TIMESTAMPTZ,
  parent_job_id    INTEGER     REFERENCES minion_jobs(id) ON DELETE SET NULL,
  on_child_fail    TEXT        NOT NULL DEFAULT 'fail_parent',
  tokens_input     INTEGER     NOT NULL DEFAULT 0,
  tokens_output    INTEGER     NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER    NOT NULL DEFAULT 0,
  result           JSONB,
  progress         JSONB,
  error_text       TEXT,
  stacktrace       JSONB       DEFAULT '[]',
  depth            INTEGER     NOT NULL DEFAULT 0,
  max_children     INTEGER,
  timeout_ms       INTEGER,
  timeout_at       TIMESTAMPTZ,
  remove_on_complete BOOLEAN   NOT NULL DEFAULT FALSE,
  remove_on_fail   BOOLEAN     NOT NULL DEFAULT FALSE,
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_status CHECK (status IN ('waiting','active','completed','failed','delayed','dead','cancelled','waiting-children','paused')),
  CONSTRAINT chk_backoff_type CHECK (backoff_type IN ('fixed','exponential')),
  CONSTRAINT chk_on_child_fail CHECK (on_child_fail IN ('fail_parent','remove_dep','ignore','continue')),
  CONSTRAINT chk_jitter_range CHECK (backoff_jitter >= 0.0 AND backoff_jitter <= 1.0),
  CONSTRAINT chk_attempts_order CHECK (attempts_made <= attempts_started),
  CONSTRAINT chk_nonnegative CHECK (attempts_made >= 0 AND attempts_started >= 0 AND stalled_counter >= 0 AND max_attempts >= 1 AND max_stalled >= 0),
  CONSTRAINT chk_depth_nonnegative CHECK (depth >= 0),
  CONSTRAINT chk_max_children_positive CHECK (max_children IS NULL OR max_children > 0),
  CONSTRAINT chk_timeout_positive CHECK (timeout_ms IS NULL OR timeout_ms > 0)
);

-- Existing brains may bootstrap this schema before migration v122 runs.
ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_minion_jobs_claim ON minion_jobs (queue, priority ASC, created_at ASC) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_status ON minion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_minion_jobs_stalled ON minion_jobs (lock_until) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_delayed ON minion_jobs (delay_until) WHERE status = 'delayed';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent ON minion_jobs(parent_job_id);
CREATE INDEX IF NOT EXISTS idx_minion_jobs_timeout ON minion_jobs (timeout_at) WHERE status = 'active' AND timeout_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent_status ON minion_jobs (parent_job_id, status) WHERE parent_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_minion_jobs_idempotency ON minion_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_minion_jobs_source_id ON minion_jobs (source_id, id DESC) WHERE source_id IS NOT NULL;

-- onboard remediation pipeline records before/after metric stats so
-- `gbrain onboard --history --json` can show "you reduced orphans 47%".
-- delta computed at read time (NOT a stored GENERATED column —
-- zero PGLite parity risk per eng-review D2).
--
-- Attribution columns (job_id, source_id, brain_id, started_at,
-- idempotency_key) per codex finding #10 so concurrent onboard /
-- autopilot / manual runs can't misattribute deltas to the wrong
-- migration when overlapping runs change the same metric.
CREATE TABLE IF NOT EXISTS migration_impact_log (
  id              BIGSERIAL PRIMARY KEY,
  remediation_id  TEXT      NOT NULL,
  metric_name     TEXT      NOT NULL,
  metric_before   NUMERIC,
  metric_after    NUMERIC,
  job_id          BIGINT    REFERENCES minion_jobs(id) ON DELETE SET NULL,
  source_id       TEXT,
  brain_id        TEXT,
  started_at      TIMESTAMPTZ,
  idempotency_key TEXT,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by      TEXT,
  details         JSONB     DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS migration_impact_log_remediation_idx
  ON migration_impact_log(remediation_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS migration_impact_log_attribution_idx
  ON migration_impact_log(job_id, source_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY, request_id TEXT NOT NULL, session_hash TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL, client_id TEXT, job_id INTEGER,
  action TEXT NOT NULL, status TEXT NOT NULL, params_summary JSONB NOT NULL DEFAULT '{}',
  ip TEXT, error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_source_created ON admin_audit_log (source_id, created_at DESC) WHERE source_id IS NOT NULL;

-- ============================================================
-- VoltMind Actions: FS-canonical task index + DB-only run ledger
-- ============================================================
CREATE TABLE IF NOT EXISTS action_index (
  source_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  due_at TIMESTAMPTZ,
  eligible BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'manual',
  runtime TEXT,
  trigger TEXT,
  risk_level TEXT NOT NULL DEFAULT 'medium',
  requires_confirmation BOOLEAN NOT NULL DEFAULT true,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  max_autonomy TEXT,
  outcome TEXT,
  next_step TEXT,
  agent_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
  automation JSONB NOT NULL DEFAULT '{}'::jsonb,
  allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocked_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_prompt TEXT,
  file_path TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  plan_json JSONB,
  tool_route_json JSONB,
  last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_action_index_due ON action_index (due_at) WHERE eligible = true;
CREATE INDEX IF NOT EXISTS idx_action_index_status ON action_index(status);

CREATE TABLE IF NOT EXISTS action_runs (
  id SERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,
  action_slug TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  prompt TEXT NOT NULL,
  user_prompt TEXT,
  result JSONB,
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (source_id, action_slug, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_action_runs_action ON action_runs (source_id, action_slug, created_at DESC);

-- Inbox table for sidechannel messaging
CREATE TABLE IF NOT EXISTS minion_inbox (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL,
  payload     JSONB NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_minion_inbox_unread ON minion_inbox (job_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_minion_inbox_child_done ON minion_inbox (job_id, sent_at) WHERE payload->>'type' = 'child_done';

-- Attachments table: per-job binary blobs (manifests, agent outputs, files)
CREATE TABLE IF NOT EXISTS minion_attachments (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  content       BYTEA,
  storage_uri   TEXT,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_minion_attachments_job_filename UNIQUE (job_id, filename),
  CONSTRAINT chk_attachment_storage CHECK (content IS NOT NULL OR storage_uri IS NOT NULL),
  CONSTRAINT chk_attachment_size CHECK (size_bytes >= 0)
);
CREATE INDEX IF NOT EXISTS idx_minion_attachments_job ON minion_attachments (job_id);
ALTER TABLE minion_attachments ALTER COLUMN content SET STORAGE EXTERNAL;

-- ============================================================
-- Subagent runtime (v0.16.0) — durable LLM loops
-- ============================================================
-- Anthropic-native message blocks, one row per Messages API message. Parallel
-- tool_use blocks in one assistant message live in content_blocks JSONB,
-- not across rows.
CREATE TABLE IF NOT EXISTS subagent_messages (
  id                  BIGSERIAL PRIMARY KEY,
  job_id              BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  message_idx         INTEGER     NOT NULL,
  role                TEXT        NOT NULL,
  -- v0.27+ stores provider-neutral ChatBlock[] when schema_version=2; legacy
  -- Anthropic-shape blocks when schema_version=1 (pre-v0.27 jobs replay).
  content_blocks      JSONB       NOT NULL,
  schema_version      INTEGER     NOT NULL DEFAULT 1,
  -- Recipe id of the provider that produced this turn (e.g. 'anthropic',
  -- 'openai', 'deepseek'). NULL on legacy v1 rows; set on v2.
  provider_id         TEXT,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  tokens_cache_read   INTEGER,
  tokens_cache_create INTEGER,
  model               TEXT,
  ended_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_subagent_messages_idx UNIQUE (job_id, message_idx),
  CONSTRAINT chk_subagent_messages_role CHECK (role IN ('user','assistant'))
);
CREATE INDEX IF NOT EXISTS idx_subagent_messages_job ON subagent_messages (job_id, message_idx);
CREATE INDEX IF NOT EXISTS idx_subagent_messages_provider ON subagent_messages (job_id, provider_id);

-- Two-phase tool execution ledger. Before tool call: INSERT status='pending'.
-- After success: UPDATE to 'complete' + output. On failure: 'failed' + error.
-- Replay re-runs 'pending' rows only if the tool is idempotent.
CREATE TABLE IF NOT EXISTS subagent_tool_executions (
  id                  BIGSERIAL PRIMARY KEY,
  job_id              BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  message_idx         INTEGER     NOT NULL,
  tool_use_id         TEXT        NOT NULL,
  tool_name           TEXT        NOT NULL,
  input               JSONB       NOT NULL,
  status              TEXT        NOT NULL,
  output              JSONB,
  error               TEXT,
  schema_version      INTEGER     NOT NULL DEFAULT 1,
  provider_id         TEXT,
  -- v0.38 D11: VoltMind-owned stable IDs (ordinal assigned at first
  -- observation of a tool call; voltmind_tool_use_id is uuid v7).
  ordinal             INTEGER,
  voltmind_tool_use_id UUID,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  CONSTRAINT uniq_subagent_tools_use_id UNIQUE (job_id, tool_use_id),
  CONSTRAINT subagent_tool_executions_stable_id UNIQUE (job_id, message_idx, ordinal),
  CONSTRAINT chk_subagent_tools_status CHECK (status IN ('pending','complete','failed'))
);
CREATE INDEX IF NOT EXISTS idx_subagent_tools_job ON subagent_tool_executions (job_id, status);

-- Rate-lease table — concurrency cap on outbound providers (e.g.
-- anthropic:messages). Acquire: INSERT if active < max_concurrent under
-- advisory lock. Release: DELETE. Stale leases (expires_at past) auto-prune
-- on next acquire so crashed workers can't strand capacity.
CREATE TABLE IF NOT EXISTS subagent_rate_leases (
  id            BIGSERIAL PRIMARY KEY,
  key           TEXT        NOT NULL,
  owner_job_id  BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_leases_key_expires ON subagent_rate_leases (key, expires_at);

-- ============================================================
-- Dream-cycle significance verdict cache — v0.21 synthesize phase
-- ============================================================
-- Caches the cheap Haiku "is this transcript worth processing?" verdict
-- per (file_path, content_hash) so backfill re-runs skip already-judged
-- files. Distinct from raw_data (which is page-scoped); transcripts
-- aren't pages.
CREATE TABLE IF NOT EXISTS dream_verdicts (
  file_path        TEXT        NOT NULL,
  content_hash     TEXT        NOT NULL,
  worth_processing BOOLEAN     NOT NULL,
  reasons          JSONB,
  judged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (file_path, content_hash)
);

-- ============================================================
-- Cycle coordination lock — v0.17 runCycle primitive
-- ============================================================
-- One row per active cycle. Any caller (autopilot daemon, Minions
-- autopilot-cycle handler, gbrain dream CLI) tries to acquire this
-- row before running a DB-write phase. Holders refresh ttl_expires_at
-- between phases; crashed holders auto-release once TTL expires.
-- Works through PgBouncer transaction pooling, unlike session-scoped
-- pg_try_advisory_lock.
CREATE TABLE IF NOT EXISTS voltmind_cycle_locks (
  id                 TEXT        PRIMARY KEY,
  holder_pid         INT         NOT NULL,
  holder_host        TEXT,
  acquired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_expires_at     TIMESTAMPTZ NOT NULL,
  -- v0.41.13.0 (migration v97 + D-V3-4): bumped on every withRefreshingLock
  -- refresh tick. Used by `gbrain sync --break-lock --max-age <s>` to
  -- identify wedged-but-alive holders without stealing healthy long-running
  -- holders that are actively refreshing.
  last_refreshed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_voltmind_cycle_locks_ttl ON voltmind_cycle_locks(ttl_expires_at);

-- ============================================================
-- Eval capture (v0.25.0 — BrainBench-Real substrate)
-- ============================================================
-- eval_candidates: captured query/search calls from the op-layer wrapper
-- in src/core/operations.ts. PII is scrubbed before insert by
-- src/core/eval-capture-scrub.ts. query is CHECK-capped at 50KB.
-- eval_capture_failures: cross-process audit of insert failures, surfaced
-- by `gbrain doctor` (in-process counters can't bridge MCP server + doctor
-- CLI process boundaries).
CREATE TABLE IF NOT EXISTS eval_candidates (
  id                    SERIAL PRIMARY KEY,
  tool_name             TEXT         NOT NULL CHECK (tool_name IN ('query', 'search')),
  query                 TEXT         NOT NULL CHECK (length(query) <= 51200),
  retrieved_slugs       TEXT[]       NOT NULL DEFAULT '{}',
  retrieved_chunk_ids   INTEGER[]    NOT NULL DEFAULT '{}',
  source_ids            TEXT[]       NOT NULL DEFAULT '{}',
  expand_enabled        BOOLEAN,
  detail                TEXT         CHECK (detail IS NULL OR detail IN ('low', 'medium', 'high')),
  detail_resolved       TEXT         CHECK (detail_resolved IS NULL OR detail_resolved IN ('low', 'medium', 'high')),
  vector_enabled        BOOLEAN      NOT NULL,
  expansion_applied     BOOLEAN      NOT NULL,
  latency_ms            INTEGER      NOT NULL,
  remote                BOOLEAN      NOT NULL,
  job_id                INTEGER,
  subagent_id           INTEGER,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- v0.29.1 — agent-explicit recency + salience capture for replay reproducibility.
  -- All nullable + additive. NDJSON schema_version stays at 1; consumers ignore unknown fields.
  as_of_ts              TIMESTAMPTZ,
  salience_param        TEXT,
  recency_param         TEXT,
  salience_resolved     TEXT,
  recency_resolved      TEXT,
  salience_source       TEXT,
  recency_source        TEXT,
  -- v0.36.3.0 (D16 / CDX-10) — embedding column resolved at capture time so
  -- `gbrain eval replay` reproduces the same column the capture ran against.
  -- Nullable; pre-v0.36 rows have NULL and replay falls back to current
  -- default. Migration v68 (src/core/migrate.ts) adds the same column on
  -- upgrade brains.
  embedding_column      TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates(created_at DESC);

CREATE TABLE IF NOT EXISTS eval_capture_failures (
  id      SERIAL       PRIMARY KEY,
  ts      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason  TEXT         NOT NULL CHECK (reason IN ('db_down', 'rls_reject', 'check_violation', 'scrubber_exception', 'other'))
);
CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures(ts DESC);

-- eval_takes_quality_runs (v0.32 — EXP-5): DB-authoritative receipts for the
-- takes-quality eval CLI. 4-sha unique key (corpus, prompt, models, rubric)
-- so re-running the same run is a no-op (ON CONFLICT DO NOTHING) and a
-- future rubric tweak segregates trend rows cleanly. receipt_json carries
-- the full receipt blob so `replay` can reconstruct when the disk artifact
-- is missing. Mirrored in src/core/pglite-schema.ts + migration v49.
CREATE TABLE IF NOT EXISTS eval_takes_quality_runs (
  id                    BIGSERIAL    PRIMARY KEY,
  receipt_sha8_corpus   TEXT         NOT NULL,
  receipt_sha8_prompt   TEXT         NOT NULL,
  receipt_sha8_models   TEXT         NOT NULL,
  receipt_sha8_rubric   TEXT         NOT NULL,
  rubric_version        TEXT         NOT NULL,
  verdict               TEXT         NOT NULL CHECK (verdict IN ('pass','fail','inconclusive')),
  overall_score         REAL         NOT NULL,
  dim_scores            JSONB        NOT NULL,
  cost_usd              REAL         NOT NULL,
  receipt_json          JSONB        NOT NULL,
  receipt_disk_path     TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (receipt_sha8_corpus, receipt_sha8_prompt, receipt_sha8_models, receipt_sha8_rubric)
);
CREATE INDEX IF NOT EXISTS eval_takes_quality_runs_trend_idx
  ON eval_takes_quality_runs (rubric_version, created_at DESC);

-- eval_contradictions_cache (v0.32.6): persistent judge verdicts for the
-- contradiction probe. Composite primary key includes prompt_version +
-- truncation_policy so any prompt edit cleanly invalidates prior verdicts
-- (Codex outside-voice fix). TTL via expires_at; cache.ts sweeps periodically.
CREATE TABLE IF NOT EXISTS eval_contradictions_cache (
  chunk_a_hash       TEXT         NOT NULL,
  chunk_b_hash       TEXT         NOT NULL,
  model_id           TEXT         NOT NULL,
  prompt_version     TEXT         NOT NULL,
  truncation_policy  TEXT         NOT NULL,
  verdict            JSONB        NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  PRIMARY KEY (chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy)
);
CREATE INDEX IF NOT EXISTS eval_contradictions_cache_expires_idx
  ON eval_contradictions_cache (expires_at);

-- eval_contradictions_runs (v0.32.6): time-series tracking for the probe.
-- One row per run; source for the `trend` sub-subcommand and the doctor
-- `contradictions` check. report_json carries the full ProbeReport for replay.
CREATE TABLE IF NOT EXISTS eval_contradictions_runs (
  run_id                       TEXT         PRIMARY KEY,
  ran_at                       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  schema_version               INTEGER      NOT NULL DEFAULT 1,
  judge_model                  TEXT         NOT NULL,
  prompt_version               TEXT         NOT NULL,
  queries_evaluated            INTEGER      NOT NULL,
  queries_with_contradiction   INTEGER      NOT NULL,
  total_contradictions_flagged INTEGER      NOT NULL,
  wilson_ci_lower              REAL         NOT NULL,
  wilson_ci_upper              REAL         NOT NULL,
  judge_errors_total           INTEGER      NOT NULL,
  cost_usd_total               REAL         NOT NULL,
  duration_ms                  INTEGER      NOT NULL,
  source_tier_breakdown        JSONB        NOT NULL,
  report_json                  JSONB        NOT NULL
);
CREATE INDEX IF NOT EXISTS eval_contradictions_runs_ran_at_idx
  ON eval_contradictions_runs (ran_at DESC);

-- ============================================================
-- v0.36.1.0 Hindsight calibration wave (migrations v67-v71)
-- ============================================================
-- See src/core/migrate.ts for full design notes per table.
--
-- calibration_profiles: per-holder LLM-narrative aggregation of
-- TakesScorecard data. source_id-scoped per v0.34.1 isolation discipline.
-- published flag gates E8 cross-brain mount sharing (D15 asymmetric opt-in).
CREATE TABLE IF NOT EXISTS calibration_profiles (
  id                      BIGSERIAL PRIMARY KEY,
  source_id               TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  holder                  TEXT         NOT NULL,
  wave_version            TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  generated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published               BOOLEAN      NOT NULL DEFAULT false,
  total_resolved          INTEGER      NOT NULL,
  brier                   REAL,
  accuracy                REAL,
  partial_rate            REAL,
  grade_completion        REAL         NOT NULL DEFAULT 1.0,
  domain_scorecards       JSONB        NOT NULL,
  pattern_statements      TEXT[]       NOT NULL,
  voice_gate_passed       BOOLEAN      NOT NULL,
  voice_gate_attempts     SMALLINT     NOT NULL,
  active_bias_tags        TEXT[]       NOT NULL,
  model_id                TEXT         NOT NULL,
  cost_usd                NUMERIC(10,4),
  judge_model_agreement   REAL
);
CREATE INDEX IF NOT EXISTS calibration_profiles_holder_recent_idx
  ON calibration_profiles (source_id, holder, generated_at DESC);
CREATE INDEX IF NOT EXISTS calibration_profiles_bias_tags_gin
  ON calibration_profiles USING GIN (active_bias_tags);
CREATE INDEX IF NOT EXISTS calibration_profiles_published_idx
  ON calibration_profiles (source_id, published, holder)
  WHERE published = true;

-- take_proposals: propose_takes phase queue. Idempotency cache via the
-- composite unique index (source_id, page_slug, content_hash, prompt_version)
-- mirrors v0.23 dream_verdicts. proposal_run_id supports --rollback by run.
CREATE TABLE IF NOT EXISTS take_proposals (
  id                          BIGSERIAL PRIMARY KEY,
  source_id                   TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_slug                   TEXT         NOT NULL,
  content_hash                TEXT         NOT NULL,
  prompt_version              TEXT         NOT NULL,
  wave_version                TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  proposed_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  proposal_run_id             TEXT         NOT NULL,
  status                      TEXT         NOT NULL DEFAULT 'pending'
                                           CHECK (status IN ('pending','accepted','rejected','superseded')),
  claim_text                  TEXT         NOT NULL,
  kind                        TEXT         NOT NULL,
  holder                      TEXT         NOT NULL,
  weight                      REAL         NOT NULL,
  domain                      TEXT,
  dedup_against_fence_rows    JSONB,
  model_id                    TEXT         NOT NULL,
  acted_at                    TIMESTAMPTZ,
  acted_by                    TEXT,
  promoted_row_num            INTEGER,
  predicted_brier             REAL,
  predicted_brier_bucket_n    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS take_proposals_idempotency_idx
  ON take_proposals (source_id, page_slug, content_hash, prompt_version);
CREATE INDEX IF NOT EXISTS take_proposals_pending_idx
  ON take_proposals (source_id, status, proposed_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS take_proposals_run_id_idx
  ON take_proposals (proposal_run_id);

-- take_grade_cache: grade_takes verdict cache. Composite PK on
-- (take_id, prompt_version, judge_model_id, evidence_signature) means
-- prompt edits OR evidence changes cleanly invalidate prior verdicts.
-- applied=false default + D17 auto-resolve-off-by-default = every fresh
-- install needs operator opt-in before grade verdicts mutate takes table.
CREATE TABLE IF NOT EXISTS take_grade_cache (
  take_id            BIGINT       NOT NULL,
  prompt_version     TEXT         NOT NULL,
  judge_model_id     TEXT         NOT NULL,
  evidence_signature TEXT         NOT NULL,
  wave_version       TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  graded_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  verdict            TEXT         NOT NULL
                                  CHECK (verdict IN ('correct','incorrect','partial','unresolvable')),
  confidence         REAL         NOT NULL,
  applied            BOOLEAN      NOT NULL DEFAULT false,
  cost_usd           NUMERIC(10,4),
  PRIMARY KEY (take_id, prompt_version, judge_model_id, evidence_signature)
);
CREATE INDEX IF NOT EXISTS take_grade_cache_applied_idx
  ON take_grade_cache (take_id, applied);
CREATE INDEX IF NOT EXISTS take_grade_cache_wave_idx
  ON take_grade_cache (wave_version, graded_at DESC);

-- take_nudge_log: E7 nudge cooldown state. Polymorphic FK — a nudge fires
-- on either a canonical take OR a pending proposal (CDX-5). CHECK enforces
-- exactly one is set.
CREATE TABLE IF NOT EXISTS take_nudge_log (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  take_id         BIGINT,
  proposal_id     BIGINT       REFERENCES take_proposals(id) ON DELETE CASCADE,
  nudge_pattern   TEXT         NOT NULL,
  fired_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  channel         TEXT         NOT NULL DEFAULT 'stderr',
  wave_version    TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  CONSTRAINT take_nudge_log_target_xor
    CHECK ((take_id IS NOT NULL) <> (proposal_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS take_nudge_log_take_cooldown_idx
  ON take_nudge_log (take_id, nudge_pattern, fired_at DESC)
  WHERE take_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS take_nudge_log_proposal_cooldown_idx
  ON take_nudge_log (proposal_id, nudge_pattern, fired_at DESC)
  WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS take_nudge_log_wave_idx
  ON take_nudge_log (wave_version, fired_at DESC);

-- think_ab_results (v0.36.1.0 T18 / D19): A/B harness data for
-- `gbrain think --ab`. One row per side-by-side comparison.
CREATE TABLE IF NOT EXISTS think_ab_results (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  wave_version    TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  ran_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  question        TEXT         NOT NULL,
  baseline_answer TEXT         NOT NULL,
  with_calibration_answer TEXT NOT NULL,
  preferred       TEXT         NOT NULL CHECK (preferred IN ('baseline','with_calibration','neither','tie')),
  model_id        TEXT,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS think_ab_results_recent_idx
  ON think_ab_results (source_id, ran_at DESC);

-- NOTIFY trigger for real-time job events (Postgres only, not PGLite)
CREATE OR REPLACE FUNCTION notify_minion_job_change() RETURNS trigger SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_notify('minion_jobs', json_build_object(
    'id', NEW.id, 'status', NEW.status, 'name', NEW.name,
    'queue', NEW.queue, 'prev_status', COALESCE(OLD.status, 'new')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS minion_job_notify ON minion_jobs;
CREATE TRIGGER minion_job_notify AFTER INSERT OR UPDATE OF status ON minion_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_minion_job_change();

-- ============================================================
-- Row Level Security: real source-isolation policies (v0.42 #6)
-- ============================================================
-- Pre-v0.42 only `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` ran, with ZERO
-- `CREATE POLICY`. So RLS was decorative: under the default `postgres`
-- (BYPASSRLS) app role nothing was filtered, and under a restricted role
-- EVERY row was denied (no policy = deny-all). Neither state provided the
-- per-source isolation the security review expected.
--
-- These policies gate reads/writes on the source-bearing tables to the
-- session GUC `app.source_id` (set per-request by the app, fail-closed when
-- unset: current_setting(..., true) returns NULL → `source_id = NULL` is
-- NULL → no rows). This is defense-in-depth ON TOP of the app-layer
-- `sourceScopeOpts(ctx)` WHERE filters — it catches the "missed thread"
-- bug class (a read path that forgot to thread sourceId) at the DB.
--
-- ACTIVATION: policies fire ONLY for roles WITHOUT BYPASSRLS. The default
-- `postgres` app role bypasses RLS, so under the shipped default these are
-- inert (no behavior change). Operators who want the backstop active deploy
-- a restricted role (e.g. `voltmind_app`) and point DATABASE_URL at it; the
-- app sets `app.source_id` per request via PostgresEngine.setSourceScope().
-- The doctor `rls_role` check flags a BYPASSRLS app role so the inert state
-- is visible.
--
-- PGLite has no RLS engine — pglite-schema.ts mirrors the columns only.
DO $$
DECLARE
  has_bypass BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_roles pr
    WHERE pg_has_role(current_user, pr.oid, 'USAGE')
      AND (pr.rolbypassrls OR pr.rolsuper)
  ) INTO has_bypass;
  IF has_bypass THEN
    ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE content_chunks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE raw_data ENABLE ROW LEVEL SECURITY;
    ALTER TABLE timeline_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE page_versions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ingest_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE config ENABLE ROW LEVEL SECURITY;
    ALTER TABLE files ENABLE ROW LEVEL SECURITY;
    ALTER TABLE minion_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
    ALTER TABLE file_migration_ledger ENABLE ROW LEVEL SECURITY;
    ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE mcp_request_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE minion_inbox ENABLE ROW LEVEL SECURITY;
    ALTER TABLE minion_attachments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subagent_messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subagent_tool_executions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subagent_rate_leases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE voltmind_cycle_locks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE dream_verdicts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE eval_candidates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE eval_capture_failures ENABLE ROW LEVEL SECURITY;
    ALTER TABLE eval_takes_quality_runs ENABLE ROW LEVEL SECURITY;
    -- v0.32.6 contradiction probe tables
    ALTER TABLE eval_contradictions_cache ENABLE ROW LEVEL SECURITY;
    ALTER TABLE eval_contradictions_runs ENABLE ROW LEVEL SECURITY;
    -- v0.36.1.0 Hindsight calibration wave tables
    ALTER TABLE calibration_profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE take_proposals ENABLE ROW LEVEL SECURITY;
    ALTER TABLE take_grade_cache ENABLE ROW LEVEL SECURITY;
    ALTER TABLE take_nudge_log ENABLE ROW LEVEL SECURITY;
    -- v0.26 OAuth 2.1 tables
    ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
    ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;

    -- CREATE POLICY is a utility command and cannot run inside this DO block.
    RAISE NOTICE 'v0.42 #6: RLS enabled (role % has BYPASSRLS; source-isolation policies are inert until app role is restricted + app.source_id is set per request)', current_user;
  ELSE
    RAISE WARNING 'Skipping RLS: role % does not have BYPASSRLS privilege. Run as postgres role to enable.', current_user;
  END IF;
END $$;

-- Keep fresh Postgres installs equivalent to migration v112. The policies
-- are intentionally outside the bootstrap DO block because CREATE POLICY is
-- a utility command. DROP-first makes this safe when a schema bootstrap is
-- followed by migrations, which recreate the same policies.
-- Force the same core RLS boundary on fresh Postgres installs.
ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages FORCE ROW LEVEL SECURITY;
ALTER TABLE content_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_request_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_request_log FORCE ROW LEVEL SECURITY;
ALTER TABLE external_file_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_file_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE page_external_file_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_external_file_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion_event_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_event_state FORCE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.voltmind_source_read_scope_matches(target_source TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT target_source = ANY(string_to_array(
    COALESCE(NULLIF(current_setting('app.source_ids', true), ''), current_setting('app.source_id', true)), ','
  ));
$fn$;

-- Federated source IDs are read-only scope.  Keep every mutating command
-- bound to the scalar app.source_id so a read grant for source B cannot be
-- used to delete B or move/update a row across source boundaries.
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sources_source_read ON sources;
DROP POLICY IF EXISTS sources_source_insert ON sources;
DROP POLICY IF EXISTS sources_source_update ON sources;
DROP POLICY IF EXISTS sources_source_delete ON sources;
CREATE POLICY sources_source_read ON sources
  FOR SELECT USING (public.voltmind_source_read_scope_matches(id));
CREATE POLICY sources_source_insert ON sources
  FOR INSERT WITH CHECK (id = current_setting('app.source_id', true));
CREATE POLICY sources_source_update ON sources
  FOR UPDATE USING (id = current_setting('app.source_id', true))
  WITH CHECK (id = current_setting('app.source_id', true));
CREATE POLICY sources_source_delete ON sources
  FOR DELETE USING (id = current_setting('app.source_id', true));
DROP POLICY IF EXISTS pages_source_isolation ON pages;
DROP POLICY IF EXISTS pages_source_read ON pages;
DROP POLICY IF EXISTS pages_source_insert ON pages;
DROP POLICY IF EXISTS pages_source_update ON pages;
DROP POLICY IF EXISTS pages_source_delete ON pages;
CREATE POLICY pages_source_read ON pages
  FOR SELECT
  USING (public.voltmind_source_read_scope_matches(source_id));
CREATE POLICY pages_source_insert ON pages
  FOR INSERT
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY pages_source_update ON pages
  FOR UPDATE
  USING (source_id = current_setting('app.source_id', true))
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY pages_source_delete ON pages
  FOR DELETE
  USING (source_id = current_setting('app.source_id', true));

CREATE OR REPLACE FUNCTION public.voltmind_chunk_source_scope_matches(target_page_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.pages p
    WHERE p.id = target_page_id
      AND public.voltmind_source_read_scope_matches(p.source_id)
  );
$fn$;

CREATE OR REPLACE FUNCTION public.voltmind_chunk_source_write_scope_matches(target_page_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.pages p
    WHERE p.id = target_page_id
      AND p.source_id = current_setting('app.source_id', true)
  );
$fn$;

DROP POLICY IF EXISTS content_chunks_source_isolation ON content_chunks;
DROP POLICY IF EXISTS content_chunks_source_read ON content_chunks;
DROP POLICY IF EXISTS content_chunks_source_insert ON content_chunks;
DROP POLICY IF EXISTS content_chunks_source_update ON content_chunks;
DROP POLICY IF EXISTS content_chunks_source_delete ON content_chunks;
CREATE POLICY content_chunks_source_read ON content_chunks
  FOR SELECT
  USING (public.voltmind_chunk_source_scope_matches(page_id));
CREATE POLICY content_chunks_source_insert ON content_chunks
  FOR INSERT
  WITH CHECK (public.voltmind_chunk_source_write_scope_matches(page_id));
CREATE POLICY content_chunks_source_update ON content_chunks
  FOR UPDATE
  USING (public.voltmind_chunk_source_write_scope_matches(page_id))
  WITH CHECK (public.voltmind_chunk_source_write_scope_matches(page_id));
CREATE POLICY content_chunks_source_delete ON content_chunks
  FOR DELETE
  USING (public.voltmind_chunk_source_write_scope_matches(page_id));

DROP POLICY IF EXISTS files_source_isolation ON files;
DROP POLICY IF EXISTS files_source_read ON files;
DROP POLICY IF EXISTS files_source_insert ON files;
DROP POLICY IF EXISTS files_source_update ON files;
DROP POLICY IF EXISTS files_source_delete ON files;
CREATE POLICY files_source_read ON files
  FOR SELECT
  USING (public.voltmind_source_read_scope_matches(source_id));
CREATE POLICY files_source_insert ON files
  FOR INSERT
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY files_source_update ON files
  FOR UPDATE
  USING (source_id = current_setting('app.source_id', true))
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY files_source_delete ON files
  FOR DELETE
  USING (source_id = current_setting('app.source_id', true));

DROP POLICY IF EXISTS access_tokens_source_isolation ON access_tokens;
DROP POLICY IF EXISTS access_tokens_source_read ON access_tokens;
DROP POLICY IF EXISTS access_tokens_source_insert ON access_tokens;
DROP POLICY IF EXISTS access_tokens_source_update ON access_tokens;
DROP POLICY IF EXISTS access_tokens_source_delete ON access_tokens;
CREATE POLICY access_tokens_source_read ON access_tokens
  FOR SELECT
  USING (public.voltmind_source_read_scope_matches(source_id));
CREATE POLICY access_tokens_source_insert ON access_tokens
  FOR INSERT
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY access_tokens_source_update ON access_tokens
  FOR UPDATE
  USING (source_id = current_setting('app.source_id', true))
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY access_tokens_source_delete ON access_tokens
  FOR DELETE
  USING (source_id = current_setting('app.source_id', true));

DROP POLICY IF EXISTS mcp_request_log_source_isolation ON mcp_request_log;
DROP POLICY IF EXISTS mcp_request_log_source_read ON mcp_request_log;
DROP POLICY IF EXISTS mcp_request_log_source_insert ON mcp_request_log;
DROP POLICY IF EXISTS mcp_request_log_source_update ON mcp_request_log;
DROP POLICY IF EXISTS mcp_request_log_source_delete ON mcp_request_log;
CREATE POLICY mcp_request_log_source_read ON mcp_request_log
  FOR SELECT
  USING (public.voltmind_source_read_scope_matches(source_id));
CREATE POLICY mcp_request_log_source_insert ON mcp_request_log
  FOR INSERT
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY mcp_request_log_source_update ON mcp_request_log
  FOR UPDATE
  USING (source_id = current_setting('app.source_id', true))
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY mcp_request_log_source_delete ON mcp_request_log
  FOR DELETE
  USING (source_id = current_setting('app.source_id', true));

ALTER TABLE external_file_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_external_file_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_event_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS external_file_refs_source_isolation ON external_file_refs;
DROP POLICY IF EXISTS external_file_refs_source_read ON external_file_refs;
DROP POLICY IF EXISTS external_file_refs_source_insert ON external_file_refs;
DROP POLICY IF EXISTS external_file_refs_source_update ON external_file_refs;
DROP POLICY IF EXISTS external_file_refs_source_delete ON external_file_refs;
CREATE POLICY external_file_refs_source_read ON external_file_refs
  FOR SELECT
  USING (public.voltmind_source_read_scope_matches(source_id));
CREATE POLICY external_file_refs_source_insert ON external_file_refs
  FOR INSERT
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY external_file_refs_source_update ON external_file_refs
  FOR UPDATE
  USING (source_id = current_setting('app.source_id', true))
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY external_file_refs_source_delete ON external_file_refs
  FOR DELETE
  USING (source_id = current_setting('app.source_id', true));

CREATE OR REPLACE FUNCTION public.voltmind_file_ref_page_source_scope_matches(target_page_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.pages p
    WHERE p.id = target_page_id
      AND public.voltmind_source_read_scope_matches(p.source_id)
  );
$fn$;

CREATE OR REPLACE FUNCTION public.voltmind_file_ref_page_source_write_scope_matches(target_page_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.pages p
    WHERE p.id = target_page_id
      AND p.source_id = current_setting('app.source_id', true)
  );
$fn$;

DROP POLICY IF EXISTS page_external_file_refs_source_isolation ON page_external_file_refs;
DROP POLICY IF EXISTS page_external_file_refs_source_read ON page_external_file_refs;
DROP POLICY IF EXISTS page_external_file_refs_source_insert ON page_external_file_refs;
DROP POLICY IF EXISTS page_external_file_refs_source_update ON page_external_file_refs;
DROP POLICY IF EXISTS page_external_file_refs_source_delete ON page_external_file_refs;
CREATE POLICY page_external_file_refs_source_read ON page_external_file_refs
  FOR SELECT
  USING (public.voltmind_file_ref_page_source_scope_matches(page_id));
CREATE POLICY page_external_file_refs_source_insert ON page_external_file_refs
  FOR INSERT
  WITH CHECK (public.voltmind_file_ref_page_source_write_scope_matches(page_id));
CREATE POLICY page_external_file_refs_source_update ON page_external_file_refs
  FOR UPDATE
  USING (public.voltmind_file_ref_page_source_write_scope_matches(page_id))
  WITH CHECK (public.voltmind_file_ref_page_source_write_scope_matches(page_id));
CREATE POLICY page_external_file_refs_source_delete ON page_external_file_refs
  FOR DELETE
  USING (public.voltmind_file_ref_page_source_write_scope_matches(page_id));

DROP POLICY IF EXISTS ingestion_event_state_source_isolation ON ingestion_event_state;
DROP POLICY IF EXISTS ingestion_event_state_source_read ON ingestion_event_state;
DROP POLICY IF EXISTS ingestion_event_state_source_insert ON ingestion_event_state;
DROP POLICY IF EXISTS ingestion_event_state_source_update ON ingestion_event_state;
DROP POLICY IF EXISTS ingestion_event_state_source_delete ON ingestion_event_state;
CREATE POLICY ingestion_event_state_source_read ON ingestion_event_state
  FOR SELECT
  USING (public.voltmind_source_read_scope_matches(source_id));
CREATE POLICY ingestion_event_state_source_insert ON ingestion_event_state
  FOR INSERT
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY ingestion_event_state_source_update ON ingestion_event_state
  FOR UPDATE
  USING (source_id = current_setting('app.source_id', true))
  WITH CHECK (source_id = current_setting('app.source_id', true));
CREATE POLICY ingestion_event_state_source_delete ON ingestion_event_state
  FOR DELETE
  USING (source_id = current_setting('app.source_id', true));

-- Compatibility helper for later H6 source-owned policies. Read scope may
-- contain app.source_ids; mutating policies use scalar app.source_id.
CREATE OR REPLACE FUNCTION public.voltmind_source_scope_contains(target_source_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT target_source_id = ANY(string_to_array(
    COALESCE(NULLIF(current_setting('app.source_ids', true), ''), current_setting('app.source_id', true)), ','
  ));
$fn$;

CREATE OR REPLACE FUNCTION public.voltmind_source_write_scope_contains(target_source_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT target_source_id = current_setting('app.source_id', true);
$fn$;

-- Complete the same read/write split for source-owned tables that were
-- added by earlier migrations. Federated IDs are read-only: a SELECT
-- may use app.source_ids, but UPDATE/DELETE always use app.source_id.
CREATE OR REPLACE FUNCTION public.voltmind_page_source_scope_matches(target_page_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.pages p
    WHERE p.id = target_page_id
      AND public.voltmind_source_read_scope_matches(p.source_id)
  );
$fn$;
CREATE OR REPLACE FUNCTION public.voltmind_page_source_write_scope_matches(target_page_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.pages p
    WHERE p.id = target_page_id
      AND public.voltmind_source_write_scope_contains(p.source_id)
  );
$fn$;

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ingest_log', 'minion_jobs', 'query_cache', 'facts',
    'code_edges_chunk', 'code_edges_symbol', 'migration_impact_log',
    'action_index', 'action_runs'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_source_scope ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_source_read ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_source_insert ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_source_update ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_source_delete ON public.%I', table_name);
      EXECUTE format('CREATE POLICY voltmind_source_read ON public.%I FOR SELECT USING (public.voltmind_source_read_scope_matches(source_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_source_insert ON public.%I FOR INSERT WITH CHECK (public.voltmind_source_write_scope_contains(source_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_source_update ON public.%I FOR UPDATE USING (public.voltmind_source_write_scope_contains(source_id)) WITH CHECK (public.voltmind_source_write_scope_contains(source_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_source_delete ON public.%I FOR DELETE USING (public.voltmind_source_write_scope_contains(source_id))', table_name);
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'tags', 'raw_data', 'timeline_entries', 'page_versions', 'drift_decisions'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_scope ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_read ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_insert ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_update ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_delete ON public.%I', table_name);
      EXECUTE format('CREATE POLICY voltmind_page_read ON public.%I FOR SELECT USING (public.voltmind_page_source_scope_matches(page_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_page_insert ON public.%I FOR INSERT WITH CHECK (public.voltmind_page_source_write_scope_matches(page_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_page_update ON public.%I FOR UPDATE USING (public.voltmind_page_source_write_scope_matches(page_id)) WITH CHECK (public.voltmind_page_source_write_scope_matches(page_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_page_delete ON public.%I FOR DELETE USING (public.voltmind_page_source_write_scope_matches(page_id))', table_name);
    END IF;
  END LOOP;

  IF to_regclass('public.links') IS NOT NULL THEN
    ALTER TABLE public.links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.links FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS voltmind_page_scope ON public.links;
    DROP POLICY IF EXISTS voltmind_page_read ON public.links;
    DROP POLICY IF EXISTS voltmind_page_insert ON public.links;
    DROP POLICY IF EXISTS voltmind_page_update ON public.links;
    DROP POLICY IF EXISTS voltmind_page_delete ON public.links;
    CREATE POLICY voltmind_page_read ON public.links
      FOR SELECT USING (
        public.voltmind_page_source_scope_matches(from_page_id)
        AND public.voltmind_page_source_scope_matches(to_page_id)
      );
    CREATE POLICY voltmind_page_insert ON public.links
      FOR INSERT WITH CHECK (
        public.voltmind_page_source_write_scope_matches(from_page_id)
        AND public.voltmind_page_source_write_scope_matches(to_page_id)
      );
    CREATE POLICY voltmind_page_update ON public.links
      FOR UPDATE USING (
        public.voltmind_page_source_write_scope_matches(from_page_id)
        AND public.voltmind_page_source_write_scope_matches(to_page_id)
      ) WITH CHECK (
        public.voltmind_page_source_write_scope_matches(from_page_id)
        AND public.voltmind_page_source_write_scope_matches(to_page_id)
      );
    CREATE POLICY voltmind_page_delete ON public.links
      FOR DELETE USING (
        public.voltmind_page_source_write_scope_matches(from_page_id)
        AND public.voltmind_page_source_write_scope_matches(to_page_id)
      );
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'project_tracking_receipts', 'project_tracking_receipt_history'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_source_scope ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_source_scope_insert ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_source_scope_update ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_page_source_scope_delete ON public.%I', table_name);
      EXECUTE format('CREATE POLICY voltmind_page_source_scope ON public.%I FOR SELECT USING (public.voltmind_source_read_scope_matches(page_source_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_page_source_scope_insert ON public.%I FOR INSERT WITH CHECK (public.voltmind_source_write_scope_contains(page_source_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_page_source_scope_update ON public.%I FOR UPDATE USING (public.voltmind_source_write_scope_contains(page_source_id)) WITH CHECK (public.voltmind_source_write_scope_contains(page_source_id))', table_name);
      EXECUTE format('CREATE POLICY voltmind_page_source_scope_delete ON public.%I FOR DELETE USING (public.voltmind_source_write_scope_contains(page_source_id))', table_name);
    END IF;
  END LOOP;

  IF to_regclass('public.synthesis_evidence') IS NOT NULL THEN
    ALTER TABLE public.synthesis_evidence ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.synthesis_evidence FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS voltmind_page_scope ON public.synthesis_evidence;
    DROP POLICY IF EXISTS voltmind_page_read ON public.synthesis_evidence;
    DROP POLICY IF EXISTS voltmind_page_insert ON public.synthesis_evidence;
    DROP POLICY IF EXISTS voltmind_page_update ON public.synthesis_evidence;
    DROP POLICY IF EXISTS voltmind_page_delete ON public.synthesis_evidence;
    CREATE POLICY voltmind_page_read ON public.synthesis_evidence
      FOR SELECT USING (
        public.voltmind_page_source_scope_matches(synthesis_page_id)
        AND public.voltmind_page_source_scope_matches(take_page_id)
      );
    CREATE POLICY voltmind_page_insert ON public.synthesis_evidence
      FOR INSERT WITH CHECK (
        public.voltmind_page_source_write_scope_matches(synthesis_page_id)
        AND public.voltmind_page_source_write_scope_matches(take_page_id)
      );
    CREATE POLICY voltmind_page_update ON public.synthesis_evidence
      FOR UPDATE USING (
        public.voltmind_page_source_write_scope_matches(synthesis_page_id)
        AND public.voltmind_page_source_write_scope_matches(take_page_id)
      ) WITH CHECK (
        public.voltmind_page_source_write_scope_matches(synthesis_page_id)
        AND public.voltmind_page_source_write_scope_matches(take_page_id)
      );
    CREATE POLICY voltmind_page_delete ON public.synthesis_evidence
      FOR DELETE USING (
        public.voltmind_page_source_write_scope_matches(synthesis_page_id)
        AND public.voltmind_page_source_write_scope_matches(take_page_id)
      );
  END IF;
END
$rls$;
-- H6 source-owned RLS completion for tables added after the core policy set.
CREATE OR REPLACE FUNCTION public.voltmind_source_scope_all(target_source_ids TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT target_source_ids IS NOT NULL
     AND cardinality(target_source_ids) > 0
     AND NOT EXISTS (
       SELECT 1
       FROM unnest(target_source_ids) AS requested(source_id)
       WHERE NOT public.voltmind_source_scope_contains(requested.source_id)
     );
$fn$;
CREATE OR REPLACE FUNCTION public.voltmind_source_write_scope_all(target_source_ids TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT target_source_ids IS NOT NULL
     AND cardinality(target_source_ids) > 0
     AND NOT EXISTS (
       SELECT 1 FROM unnest(target_source_ids) AS requested(source_id)
       WHERE NOT public.voltmind_source_write_scope_contains(requested.source_id)
     );
$fn$;


CREATE OR REPLACE FUNCTION public.voltmind_take_id_source_write_scope_matches(target_take_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  matches BOOLEAN;
BEGIN
  -- `schema.sql` is also run against an empty bootstrap database, before
  -- older schema packs create `takes`. Resolve the table only at execution
  -- time so the helper remains fail-closed without breaking that bootstrap.
  IF to_regclass('public.takes') IS NULL OR to_regclass('public.pages') IS NULL THEN
    RETURN FALSE;
  END IF;

  EXECUTE $sql$
    SELECT EXISTS (
      SELECT 1 FROM public.takes t
      JOIN public.pages p ON p.id = t.page_id
      WHERE t.id = $1
        AND public.voltmind_source_write_scope_contains(p.source_id)
    )
  $sql$ INTO matches USING target_take_id;
  RETURN COALESCE(matches, FALSE);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.voltmind_take_id_source_scope_matches(target_take_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  matches BOOLEAN;
BEGIN
  -- See the write helper below: the bootstrap schema may precede `takes`.
  IF to_regclass('public.takes') IS NULL OR to_regclass('public.pages') IS NULL THEN
    RETURN FALSE;
  END IF;

  EXECUTE $sql$
    SELECT EXISTS (
      SELECT 1 FROM public.takes t
      JOIN public.pages p ON p.id = t.page_id
      WHERE t.id = $1
        AND public.voltmind_source_scope_contains(p.source_id)
    )
  $sql$ INTO matches USING target_take_id;
  RETURN COALESCE(matches, FALSE);
END;
$fn$;


CREATE OR REPLACE FUNCTION public.voltmind_job_source_scope_matches(target_job_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.minion_jobs j
    WHERE j.id = target_job_id
      AND public.voltmind_source_scope_contains(j.source_id)
  );
$fn$;
CREATE OR REPLACE FUNCTION public.voltmind_job_source_write_scope_matches(target_job_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.minion_jobs j
    WHERE j.id = target_job_id
      AND public.voltmind_source_write_scope_contains(j.source_id)
  );
$fn$;

DO $rls$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'calibration_profiles', 'take_proposals', 'take_nudge_log', 'think_ab_results'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_source_scope ON public.%I', table_name);
      EXECUTE format(
        'CREATE POLICY voltmind_source_scope ON public.%I USING (public.voltmind_source_scope_contains(source_id)) WITH CHECK (public.voltmind_source_write_scope_contains(source_id))',
        table_name
      );
    END IF;
  END LOOP;

  IF to_regclass('public.eval_candidates') IS NOT NULL THEN
    ALTER TABLE public.eval_candidates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.eval_candidates FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS voltmind_source_array_scope ON public.eval_candidates;
    CREATE POLICY voltmind_source_array_scope ON public.eval_candidates
      USING (public.voltmind_source_scope_all(source_ids))
      WITH CHECK (public.voltmind_source_write_scope_all(source_ids));
  END IF;


  FOREACH table_name IN ARRAY ARRAY[
    'minion_inbox', 'minion_attachments', 'subagent_messages',
    'subagent_tool_executions'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
      EXECUTE format('DROP POLICY IF EXISTS voltmind_job_scope ON public.%I', table_name);
      EXECUTE format(
        'CREATE POLICY voltmind_job_scope ON public.%I USING (public.voltmind_job_source_scope_matches(job_id)) WITH CHECK (public.voltmind_job_source_write_scope_matches(job_id))',
        table_name
      );
    END IF;
  END LOOP;

  IF to_regclass('public.subagent_rate_leases') IS NOT NULL THEN
    ALTER TABLE public.subagent_rate_leases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.subagent_rate_leases FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS voltmind_job_scope ON public.subagent_rate_leases;
    CREATE POLICY voltmind_job_scope ON public.subagent_rate_leases
      USING (public.voltmind_job_source_scope_matches(owner_job_id))
      WITH CHECK (public.voltmind_job_source_write_scope_matches(owner_job_id));
  END IF;
END
$rls$;

-- H6 association RLS completion and legacy bearer authentication bridge
CREATE OR REPLACE FUNCTION public.voltmind_file_id_source_scope_matches(target_file_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.files f
    WHERE f.id = target_file_id
      AND public.voltmind_source_scope_contains(f.source_id)
  );
$fn$;
CREATE OR REPLACE FUNCTION public.voltmind_file_id_source_write_scope_matches(target_file_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.files f
    WHERE f.id = target_file_id
      AND public.voltmind_source_write_scope_contains(f.source_id)
  );
$fn$;

CREATE OR REPLACE FUNCTION public.voltmind_lookup_legacy_access_token(target_hash TEXT)
RETURNS TABLE(name TEXT, scopes TEXT[], source_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT a.name, a.scopes, a.source_id
  FROM public.access_tokens a
  WHERE a.token_hash = target_hash
    AND a.revoked_at IS NULL;
$fn$;

CREATE OR REPLACE FUNCTION public.voltmind_touch_legacy_access_token(target_hash TEXT)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  UPDATE public.access_tokens
     SET last_used_at = now()
   WHERE token_hash = target_hash
     AND revoked_at IS NULL;
$fn$;

DO $rls$
BEGIN
  IF to_regclass('public.take_domain_assignments') IS NOT NULL THEN
    ALTER TABLE public.take_domain_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.take_domain_assignments FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS voltmind_take_scope ON public.take_domain_assignments;
    CREATE POLICY voltmind_take_scope ON public.take_domain_assignments
      USING (public.voltmind_take_id_source_scope_matches(take_id))
      WITH CHECK (public.voltmind_take_id_source_write_scope_matches(take_id));
  END IF;

  IF to_regclass('public.file_migration_ledger') IS NOT NULL THEN
    ALTER TABLE public.file_migration_ledger ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.file_migration_ledger FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS voltmind_file_scope ON public.file_migration_ledger;
    CREATE POLICY voltmind_file_scope ON public.file_migration_ledger
      USING (public.voltmind_file_id_source_scope_matches(file_id))
      WITH CHECK (public.voltmind_file_id_source_write_scope_matches(file_id));
  END IF;

  IF to_regclass('public.admin_audit_log') IS NOT NULL THEN
    ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.admin_audit_log FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS voltmind_admin_audit_scope ON public.admin_audit_log;
    CREATE POLICY voltmind_admin_audit_scope ON public.admin_audit_log
      USING (source_id IS NULL OR public.voltmind_source_scope_contains(source_id))
      WITH CHECK (source_id IS NULL OR public.voltmind_source_write_scope_contains(source_id));
  END IF;
END
$rls$;

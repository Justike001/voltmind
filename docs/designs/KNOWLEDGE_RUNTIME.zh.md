# VoltMind Knowledge Runtime — 设计文档

**状态：** CEO review 草案。
**日期：** 2026-04-18。
**Supersedes：** 早先的 “Feynman Ideas Assessment + Phase A/B” 计划。

---

## 0. Context

在一次 CEO review 中，原本狭窄的两功能计划（借鉴 Feynman 的 bare-tweet citation repair + completeness score）被重新定义了 scope。狭窄计划重复了 Garry 的 OpenClaw 已经在做的工作，并错过真正的 leverage point：**OpenClaw 中隐藏的 bespoke abstractions——resolvers、enrichment orchestration、scheduling、deterministic output——应该作为 first-class primitives 生活在 VoltMind 里。**

North star：*"When Garry's OpenClaw's Claw upgrades to this version of VoltMind, it should immediately recognize brilliance and completeness and say 'It's time to switch to these abstractions.'"*

这就是本文档要通过的测试。其他一切都是下游。

---

## 1. The Four Layers

设计由四层 abstraction 构成。每层都可以独立产生价值；合在一起就是 Knowledge Runtime。

```
  ┌───────────────────────────────────────────────────────────────────┐
  │                   KNOWLEDGE RUNTIME (new)                         │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 4: Deterministic Output Builder                            │
  │     BrainWriter · Scaffolds · Back-link enforcer · Slug registry  │
  │     Rule: LLM picks WHAT to write. Code guarantees WHERE and HOW. │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 3: Scheduler                                               │
  │     ScheduledResolver · TZ-aware quiet hours (enforced) ·         │
  │     Auto-stagger · Durable state · Retry/circuit-break            │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 2: Enrichment Orchestrator                                 │
  │     Trigger convergence · Tier routing · Budget · Cascade ·       │
  │     Evidence-weighted completeness · Fail-safe transactions       │
  ├───────────────────────────────────────────────────────────────────┤
  │  Layer 1: Resolver SDK                                            │
  │     Resolver<I,O> interface · Registry · Factory · Plugin recipes │
  │     Ported reference impls: X-API, Perplexity, Mistral, brain     │
  └───────────────────────────────────────────────────────────────────┘
          │                                                │
          ▼                                                ▼
     REUSES (polished primitives already in VoltMind)  REPLACES (ad-hoc code)
     FailImproveLoop · backoff · storage factory ·   enrichment-service ·
     check-resolvable · operations validators ·      embedding · transcription ·
     engine interface · publish · backlinks          2 recipe formats
```

---

## 2. 为什么按这个顺序（L1 → L4）

每个更高层都依赖下面的层。**L1 必须先落地，否则后续都会漏 abstraction。**

- **L1（Resolvers）** 是 substrate。没有统一 lookup interface，每个 orchestrator + writer 都会有 bespoke callers。
- **L2（Orchestrator）** 使用 L1 fetch；没有 L1，它仍是 ad-hoc。
- **L3（Scheduler）** 定期运行 L2；没有 L2，它调度的不是结构化工作。
- **L4（Output Builder）** 是每层最终写入的通道；没有它，我们会有 14 个 call sites 继续用手写 citation discipline 调 `fs.writeFile`。

早期实现可以先 ship L1 + L4（两个最“纯”的层），以最快产生 integrity impact，再添加 L2 + L3。但最终状态必须包含全部四层。

---

## 3. Layer 1 — Resolver SDK

### 3.1 今天哪里坏了

Garry 的 OpenClaw 有 **69 种不同 external-lookup patterns**，横跨 X API（14 种 shape）、Perplexity、Mistral OCR、Gmail、Calendar、Slack、GitHub、YouTube、Diarize.io、YC tools、OSINT collectors 和 brain-local lookups。每个都是 `scripts/` 下的 bespoke script，带着各自的 error handling、retry logic 和 output shape。VoltMind 有 3 个 ad-hoc wrappers（`embedding.ts`、`transcription.ts`、`enrichment-service.ts`），它们不共享 interface。

共同后果：
- 没有统一 retry/backoff strategy（有些 script retry，大多数没有）
- 没有 cost tracking（Perplexity 返回 no-substance results 时账单被悄悄吃掉）
- 没有 confidence/provenance propagation（caller 无法判断答案是 verified 还是 inferred）
- 用户无法在不 fork VoltMind 的情况下添加 resolver

### 3.2 Interface

```typescript
// src/core/resolvers/interface.ts

export type ResolverCost = 'free' | 'rate-limited' | 'paid';

export interface ResolverRequest<I> {
  input: I;
  context: ResolverContext;
  timeoutMs?: number;
}

export interface ResolverResult<O> {
  value: O;
  confidence: number;      // 0.0–1.0; 1.0 = deterministic from ground-truth API
  source: string;          // e.g. "x-api-v2", "perplexity-sonar", "brain-local"
  fetchedAt: Date;
  costEstimate?: number;   // dollars; 0 if free
  raw?: unknown;           // for sidecar preservation via put_raw_data
}

export interface Resolver<I, O> {
  readonly id: string;           // stable, slug-like: "x_handle_to_tweet"
  readonly cost: ResolverCost;
  readonly backend: string;      // "x-api-v2", "perplexity", "brain-local"
  readonly inputSchema: JSONSchema;
  readonly outputSchema: JSONSchema;

  available(ctx: ResolverContext): Promise<boolean>;
  resolve(req: ResolverRequest<I>): Promise<ResolverResult<O>>;
}
```

### 3.3 Context

```typescript
export interface ResolverContext {
  engine: BrainEngine;
  storage: StorageBackend;
  config: VoltMindConfig;
  logger: Logger;
  metrics: MetricsRecorder;
  budget: BudgetLedger;       // hard spend caps, queried pre-resolve
  requestId: string;
  remote: boolean;            // trust boundary — untrusted callers get stricter validation
  deadline?: Date;
}
```

### 3.4 Registry + Factory（镜像 `src/core/storage.ts`）

```typescript
// src/core/resolvers/registry.ts
export class ResolverRegistry {
  register<I, O>(r: Resolver<I, O>): void;
  get(id: string): Resolver<unknown, unknown>;
  list(filter?: { cost?: ResolverCost; backend?: string }): Resolver[];
  async resolve<I, O>(id: string, input: I, ctx: ResolverContext): Promise<ResolverResult<O>>;
}

// src/core/resolvers/factory.ts (dynamic import like engine-factory)
export async function createResolver(
  type: 'x-api' | 'perplexity' | 'mistral-ocr' | 'brain-local' | 'plugin',
  config: ResolverConfig,
): Promise<Resolver>;
```

### 3.5 Plugin format（统一 `recipes/` + `data-research` 格式）

Plugin 是 YAML + JS module，通过扫描 `~/.voltmind/resolvers/` 和 `recipes/` 发现。

```yaml
# Example: resolvers/x-api/handle-to-tweet.yaml
id: x_handle_to_tweet
version: 1
category: lookup
cost: rate-limited
backend: x-api-v2
module: ./handle-to-tweet.ts
input_schema:
  type: object
  properties:
    handle:   { type: string, pattern: "^[A-Za-z0-9_]{1,15}$" }
    keywords: { type: string }
  required: [handle]
output_schema:
  type: object
  properties:
    url:        { type: string, format: uri }
    tweet_id:   { type: string }
    text:       { type: string }
    created_at: { type: string, format: date-time }
requires:
  env: [X_API_BEARER_TOKEN]
health_check:
  kind: http
  url: https://api.twitter.com/2/tweets/1
  expect: { status: [200, 401] }   # 401 = auth failure but endpoint reachable
tests:
  - input:  { handle: "garrytan" }
    expect: { url: { pattern: "^https://x\\.com/garrytan/status/\\d+$" } }
```

Trust flagging 沿用现有 `src/commands/integrations.ts` pattern：只有 package-bundled resolvers 是 `embedded=true`，可以运行任意命令；用户提供的 resolvers 限制为 `http` 且 schemas 会被验证。

### 3.6 用 `FailImproveLoop` 包装每个 resolver

现有 `src/core/fail-improve.ts` 是 deterministic-first/LLM-fallback pattern。每个 resolver 自动被包装：如果 deterministic path（例如 X API）返回 valid result，就使用它；如果失败，可选择 fallback 到 LLM-based resolver；记录两条路径，供未来 pattern analysis 和 auto-test generation。

### 3.7 要 ship 的 reference implementations

OpenClaw survey 盘点了 69 种 resolver shape。全部 ship 是 over-scoped；一个都不 ship 是 under-scoped。Dogfood set：

| # | Resolver | Purpose | Used by |
|---|---|---|---|
| 1 | `x_handle_to_tweet` | Bare-tweet citation repair（原 Phase A） | `voltmind integrity` |
| 2 | `url_reachable` | Dead-link detection | `voltmind integrity` |
| 3 | `brain_slug_lookup` | Name/email → slug（wraps existing `resolveSlugs`） | Output Builder |
| 4 | `openai_embedding` | 将 `src/core/embedding.ts` refactor 为 Resolver | Import pipeline |
| 5 | `perplexity_query` | Query → synthesis + citations | Enrichment Orchestrator |
| 6 | `text_to_entities` | LLM entity extraction（structured JSON） | Enrichment Orchestrator |

剩余 63 个 OpenClaw patterns 按用户需求逐步 port。每次 port 都是在 `recipes/` 或 `~/.voltmind/resolvers/` 下添加新的 YAML + module，不需要 framework 变更。

---

## 4. Layer 2 — Enrichment Orchestrator

### 4.1 今天哪里坏了

Garry 的 OpenClaw enrichment **数据层 polished，control layer hacky**：

- **Completeness = “length > 500 chars + no `needs-enrichment` tag”**（`lib/enrich.mjs:351-355`）。很天真。一页由重复 Perplexity summary 组成的富页面（见 `brain/people/0interestrates.md` — 38 个重复块）也会通过。
- **30-day auto-re-enrichment** 永远运行。没有 “done” state。2023 年见过一次的人仍会每月被重新 research。
- **Cascade 只是 convention。** Person→company stubs 会自动创建；company→investors、company→employees traversals 有文档但未实现。
- **没有 hard budget cap。** Cost 只按 batch 估算，不跨 batch 或按天强制。
- **Failure silent。** 坏的 Perplexity response log 后继续；partial writes 可能留下有 timeline entry 但没有 raw-data sidecar 的页面。

### 4.2 Orchestrator

```typescript
// src/core/enrichment/orchestrator.ts

export interface EnrichmentRequest {
  entitySlug: string;
  trigger: 'mention' | 'stub-creation' | 'cron-sweep' | 'manual' | 'cascade';
  tier?: 1 | 2 | 3;                // optional override; auto-computed if absent
  cascadeDepth?: number;           // 0 = no cascade; default 1
}

export interface EnrichmentResult {
  entitySlug: string;
  completenessBefore: number;
  completenessAfter: number;
  resolversUsed: string[];         // e.g. ["perplexity_query", "x_handle_to_tweet"]
  costSpent: number;
  writtenTo: string[];             // page paths touched, for transaction audit
  cascadedTo: string[];            // related entities enriched
  status: 'enriched' | 'skipped' | 'failed' | 'budget-exhausted';
  reason?: string;
}

export class EnrichmentOrchestrator {
  constructor(
    private registry: ResolverRegistry,
    private writer: BrainWriter,
    private budget: BudgetLedger,
    private scorer: CompletenessScorer,
    private graph: EntityGraph,
  ) {}

  async enrich(req: EnrichmentRequest): Promise<EnrichmentResult>;
  async enrichBatch(reqs: EnrichmentRequest[]): Promise<EnrichmentResult[]>;
}
```

### 4.3 Evidence-weighted completeness（替代长度 heuristic）

Completeness 是按 entity type 定义的 rubric，写入时保存在 frontmatter 中，也可按需重新计算。

```typescript
// src/core/enrichment/completeness.ts
export interface CompletenessRubric<Page> {
  entityType: PageType;
  dimensions: {
    name: string;
    weight: number;                // sum must = 1.0
    check: (page: Page) => number; // 0.0–1.0
  }[];
}

// Example rubric for persons:
//   - has_role_and_company   0.20
//   - has_source_urls        0.20  (≥1 URL with resolver-verified reachability)
//   - has_timeline_entries   0.15  (≥1)
//   - has_citations          0.15  (every claim has [Source: ...])
//   - has_backlinks          0.10  (every linked page links back)
//   - recency_score          0.10  (last_verified within 90 days)
//   - non_redundancy         0.10  (no repeated blocks; distinct-lines/total-lines > 0.8)
```

**关键属性：** `non_redundancy` + `recency_score` 明确击杀 audit 中观察到的两种 brain pathology（Wilco-style repeating blocks；没有 `last_verified` 的 stale pages）。

`completeness` 字段以 `0.0–1.0` 放在 frontmatter 中。它可通过 `list_pages(where: completeness < 0.5)` 查询。

### 4.4 Tier routing with hard budget

二维 routing：**importance**（来自 person-score 的 tier 1/2/3）× **budget state**。

```typescript
// src/core/enrichment/tiers.ts
export const TIER_CONFIG = {
  1: { models: ['opus', 'sonar-deep'], maxCostUsd: 0.10, cascadeDepth: 2 },
  2: { models: ['sonar'],              maxCostUsd: 0.02, cascadeDepth: 1 },
  3: { models: ['sonar'],              maxCostUsd: 0.005, cascadeDepth: 0 },
};

// src/core/enrichment/budget.ts
export class BudgetLedger {
  // Hard caps. Queryable pre-resolve.
  dailyCapUsd: number;
  perEntityCapUsd: number;
  perResolverCapUsd: Map<string, number>;

  async reserve(resolverId: string, estimateUsd: number): Promise<Reservation | 'exhausted'>;
  async commit(reservation: Reservation, actualUsd: number): Promise<void>;
  async rollback(reservation: Reservation): Promise<void>;
  async state(): Promise<{ spent: number; remaining: number; perResolver: Record<string, number> }>;
}
```

**属性：** 如果达到 daily cap，`orchestrator.enrich()` 立刻返回 `status: 'budget-exhausted'`。没有 silent overages。Circuit-breaker 在用户配置 TZ 的午夜重置。

### 4.5 Cascade（entity graph traversal）

```typescript
// src/core/enrichment/cascade.ts
export class EntityGraph {
  // Deterministic, no LLM. Uses engine.getLinks() + engine.getBacklinks().
  async neighbors(slug: string, depth: number): Promise<string[]>;
  async cascadeFrom(trigger: string, depth: number): Promise<EnrichmentRequest[]>;
}
```

如果 person X 被 enrich 并获得新的 `company: Acme` 字段，cascade 会检查：`companies/acme` 是否存在？如果不存在，创建 stub + enqueue at tier 2。`companies/acme` 是否 link back 到 X？如果没有，写入 back-link。**Iron Law 由机器强制，而不是靠 skill 约束。**

### 4.6 Fail-safe transactions

每次 enrichment 都包在 BrainWriter transaction（Layer 4）中。Partial writes 会 rollback。不会出现 timeline-entry-without-raw-sidecar 这种 asymmetric state。

```typescript
await writer.transaction(async (tx) => {
  const research = await registry.resolve('perplexity_query', {...}, ctx);
  await tx.appendTimeline(slug, {...});
  await tx.putRawData(slug, 'perplexity', research.raw);
  await tx.setFrontmatterField(slug, 'completeness', score);
  // All-or-nothing commit on exit.
});
```

---

## 5. Layer 3 — Scheduler

### 5.1 今天哪里坏了

Garry 的 OpenClaw cron 是 **externally-driven JSON**（`cron/jobs.json`），约 30 个 job 手动 stagger 到不同分钟。VoltMind **没有 native scheduling**：`src/commands/autopilot.ts` 是单 daemon loop，`docs/guides/cron-schedule.md` 是架构指引，不是代码。

在 Garry 的 OpenClaw 实际状态中观察到的 failures：
- `X OAuth2 Token Refresh`: 11 次连续 timeout（critical-path silent failure）
- `flight-tracker daily scan`: 5 次连续 timeout
- `morning-briefing`: 4 次连续 timeout
- Quiet hours 在 skill 内 runtime 检查；忘记检查的 skill 仍会凌晨 3 点发 DM
- Staggering 是手动 convention；config edit 后两个 job 可能相撞，没有保护

### 5.2 ScheduledResolver interface

```typescript
// src/core/scheduling/scheduler.ts
export interface Schedule {
  kind: 'cron' | 'interval';
  expr?: string;                    // cron string
  intervalMs?: number;
  tz: string;                       // IANA: "America/Los_Angeles"
  quietHours?: {
    startHour: number;              // 22 = 10 PM local
    endHour: number;                // 7 = 7 AM local
    policy: 'skip' | 'defer' | 'silent-run';
  };
  staggerKey?: string;              // jobs with same key auto-offset
  maxConcurrent?: number;           // global concurrency cap
  maxDurationMs?: number;           // timeout
}

export interface ScheduledResolver extends Resolver<void, ScheduledResult> {
  schedule: Schedule;
  retryPolicy: { maxRetries: number; backoffMs: number };
  circuitBreaker: { failureThreshold: number; cooldownMs: number };
  state: DurableState;              // watermark, content-hash, idempotency key
}
```

### 5.3 Enforcement vs convention（相对 Garry 的 OpenClaw 的关键差异）

| Concern | Garry's OpenClaw today | Knowledge Runtime |
|---|---|---|
| Quiet hours | 每个 skill 内检查（基于信任） | Scheduler 强制，skill 不能 override |
| Staggering | `jobs.json` 中手动 minute-offset | Scheduler 通过 hashed staggerKey 分配 slots |
| Concurrency | `MAX_BATCH_PROCESSES=2` 在 backoff 中，被 cron 忽略 | Scheduler 中的 global semaphore |
| Timeout | JSON 中的 per-job string，不总是被遵守 | 通过 `AbortController` 强制，timeout 抛出 `TimeoutError` 并由 orchestrator 捕获 |
| Retry | Cron 层没有 | 带 exponential backoff 的 `retryPolicy` |
| Silent failure | “11 consecutive timeouts” 没人注意 | 达到 threshold 时 circuit breaker 打开 → escalate 给用户 |
| Idempotency | 每个 job 的 state files，无 framework | `DurableState` primitive：watermark/ID/content-hash |

### 5.4 Native engine + OS cron adapter

Scheduler 以两种模式运行：
1. **Embedded**（`voltmind autopilot` 默认）：daemon 进程内的 native event loop。一个进程，多个 ScheduledResolvers。
2. **OS-driven**（用于 Railway/launchd/systemd）：由 OS cron 调用 `voltmind schedule run <id>`，scheduler state durable，因此跨 invocation 仍可 dedup。

两种模式共享同一套 `Schedule` config + state。

### 5.5 Observability

每次 scheduled run 都 emit structured events：`started`、`skipped-quiet-hours`、`deferred-to-active-hours`、`failed-retrying`、`circuit-opened`、`completed`。Events 去向：
- `~/.voltmind/scheduler/events.jsonl`（本地，始终）
- `engine.logIngest`（brain DB 中的 audit trail）
- 可选 webhook（Slack/Telegram 给用户）

`voltmind doctor` 读取 event log 并报告：当前 circuit-breaker state、任何 >3 consecutive failures 的 resolver、任何未在 3× interval 内触发的 resolver（像 Garry 的 OpenClaw 的 `freshness-check.mjs`，但内置）。

---

## 6. Layer 4 — Deterministic Output Builder

### 6.1 Anti-hallucination invariant

**Iron Law：LLM picks WHAT. Code guarantees WHERE and HOW.**

Garry 的 OpenClaw 现有 `lib/enrich.mjs:buildTweetEntry` 已经接近这点：tweet URL 由 X API 返回的 `tweet.id` 构造，永远不靠 LLM 记忆。但：

- 过去事件：*"Sub-agent test #2 FAILED — hallucinated 'Philip Leung' entity links across all daily files. LLM rewriting of daily files is too error-prone."*（Garry 的 OpenClaw memory log，2026-04-13。）
- Back-links 依赖各处都调用 `appendTimeline`；漏掉时 silent。
- Slug collisions 未检查（`slugify` 没有 conflict detection）。
- Citation format 是事后每周 lint，不是 pre-write enforcement。

### 6.2 BrainWriter

```typescript
// src/core/output/writer.ts
export class BrainWriter {
  constructor(
    private engine: BrainEngine,
    private slugRegistry: SlugRegistry,
    private scaffolder: Scaffolder,
  ) {}

  async transaction<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T>;
}

export interface WriteTx {
  // High-level typed operations; never raw string writes.
  createEntity(input: EntityInput): Promise<string>;          // returns slug, conflict-checked
  appendTimeline(slug: string, entry: TimelineInput): Promise<void>;
  setCompiledTruth(slug: string, body: CompiledTruthInput): Promise<void>;
  setFrontmatterField(slug: string, key: string, value: unknown): Promise<void>;
  putRawData(slug: string, source: string, data: object): Promise<void>;
  addLink(from: string, to: string, context: string): Promise<void>;  // auto-creates reverse back-link

  // Validators (called implicitly on commit)
  validate(): Promise<ValidationReport>;
}
```

### 6.3 Scaffolder — deterministic link + citation construction

每个用户可见 URL/link/citation 都由代码从 resolver outputs 构建，不来自 LLM text。

```typescript
// src/core/output/scaffold.ts
export class Scaffolder {
  tweetCitation(handle: string, tweetId: string, dateISO: string): string {
    // "[Source: [X/garrytan, 2026-04-18](https://x.com/garrytan/status/123456)]"
  }
  emailCitation(account: string, messageId: string, subject: string): string {
    // deterministic Gmail URL per OpenClaw pattern
  }
  sourceCitation(resolverResult: ResolverResult<unknown>): string {
    // pulls .source, .fetchedAt, .raw from the result
  }
  entityLink(slug: string): string {
    // slugRegistry checks existence; returns resolvable wikilink
  }
}
```

### 6.4 SlugRegistry — conflict detection

```typescript
// src/core/output/slug-registry.ts
export class SlugRegistry {
  async create(desiredSlug: string, displayName: string, type: PageType): Promise<CreatedSlug>;
  // Throws SlugCollision if another entity already occupies desiredSlug and isn't
  // confirmed as the same person (via email / x_handle / disambiguator).
  // Auto-resolves near-collisions by appending disambiguator.

  async confirmSame(slugA: string, slugB: string, confidence: number): Promise<void>;
  async merge(canonical: string, duplicate: string): Promise<void>;
}
```

### 6.5 Pre-write validators（integrity fail-closed）

在 commit 前，`WriteTx.validate()` 会执行：

1. **Citation validator。** `compiled_truth` 中每个事实句都必须在 N 行内带 inline `[Source: ...]`。不合规段落会被 flag。Configurable：strict-mode 拒绝 transaction，lint-mode warn。
2. **Link validator。** 每个 `[text](path)` 必须指向存在的页面，或指向 Scaffolder 构建的 URL（因此 guaranteed-valid）。没有 raw LLM-composed URLs。
3. **Back-link validator。** 每个 outbound link 必须在同一 transaction 中写入 reverse link。
4. **Triple-HR validator。** Compiled truth / timeline split 在 schema 层强制。

**Fails closed**：默认 strict-mode。放宽必须显式 `writer.transaction({ strictMode: false }, ...)`，并向 ingest log 写 warning。

### 6.6 LLM output sanitization

任何要进入 brain page 的 LLM output 都先通过 JSON-Schema-validated parser。没有 free-form markdown 直接落盘。

- Entity extraction：按现有 `extractEntities` pattern 输出 JSON array `{ name, type, context }`，严格 validation。
- Compiled-truth synthesis：LLM 输出 structured `{ sections: [{heading, paragraphs: [{text, sources: [...]}]}]}`，scaffolder 渲染为 markdown。
- Timeline entries：LLM 输出 `{ date, summary, detail, sources }`，scaffolder 渲染。

LLM 永远看不到 file paths，永远不写文件，永远不产出 finished markdown。

---

## 7. Integration with existing VoltMind

### 7.1 Reuse（已经 polished）

| Existing | Used by | Change |
|---|---|---|
| `src/core/fail-improve.ts` (9/10) | Wraps every Resolver in L1 | None; becomes default wrapper |
| `src/core/backoff.ts` (9/10) | ResolverContext.backoff | None |
| `src/core/storage.ts` (9/10) | Template for Resolver factory pattern | None; serves as pattern reference |
| `src/core/check-resolvable.ts` (9/10) | Extend to validate Resolver plugins | Add `checkResolvers()` mode |
| `src/commands/publish.ts` (9/10) | Uses BrainWriter under the hood | Minor: route through L4 |
| `src/commands/backlinks.ts` (8/10) | Folded into L4 validator | Keep as CLI-facing lint entry point |
| `src/core/operations.ts` validators | Reused in ResolverContext trust enforcement | None |
| `src/core/engine.ts` BrainEngine (35 methods) | ResolverContext.engine | Extend with `getResolverRegistry()` |

### 7.2 Replace（今天是 ad-hoc）

| Existing | Replace with |
|---|---|
| `src/core/enrichment-service.ts` (5/10) | `src/core/enrichment/orchestrator.ts` (L2) |
| `src/core/embedding.ts` (monolithic) | `src/core/resolvers/builtin/embedding/openai.ts` |
| `src/core/transcription.ts` (monolithic) | `src/core/resolvers/builtin/transcription/{groq,openai}.ts` |
| `src/commands/integrations.ts` recipe format | Unified Resolver plugin format (§3.5) |
| `src/core/data-research.ts` recipe format | Same unified format |
| `src/commands/autopilot.ts` hard-coded daemon loop | Wraps a set of ScheduledResolvers |

### 7.3 Extend

- `src/core/engine.ts`：添加 `getResolverRegistry()`、`getWriter()`、`getScheduler()`。Engine 成为 runtime root container。
- `src/core/operations.ts`：`OperationContext` 继承 `ResolverContext`（或反过来）。Trust flags 统一。
- `src/core/types.ts`：给 `Page` 添加 `completeness: number`，给 provenance 添加 `sourcedBy: string[]`。

---

## 8. Migration Path（phased, shippable）

每个 phase 独立 ship，通过完整 E2E，有 feature flag，并且可逆。没有 big-bang。

### Phase 0 — Foundation（human: 约 1 周 / CC: 约 4 h）
- 定义 `Resolver<I,O>`、`ResolverContext`、`ResolverRegistry`、`ResolverResult`（§3.2–3.4）。
- 添加 `src/core/resolvers/index.ts` wiring + registry tests（register/get/list）。
- 无行为变化；以 `v0.11.0-alpha` ship，带 feature flag。

### Phase 1 — Three reference resolvers（human: 约 1 周 / CC: 约 4 h）
- Port `src/core/embedding.ts` → `resolvers/builtin/embedding/openai.ts`。
- 实现 `resolvers/builtin/brain-local/slug-lookup.ts`（wraps `engine.resolveSlugs`）。
- 实现 `resolvers/builtin/url-reachable.ts`（HEAD-check）。
- 证明 interface：旧 callers 改用 `registry.resolve('openai_embedding', ...)`。

### Phase 2 — BrainWriter + Slug Registry（human: 约 1.5 周 / CC: 约 6 h）
- L4 core：`BrainWriter.transaction`、`Scaffolder`、`SlugRegistry` with conflict detection。
- Pre-write validators：citation、link、back-link、triple-HR。
- 迁移 `src/commands/publish.ts` + `src/commands/backlinks.ts`，经 BrainWriter 路由。
- **此时** Garry 的 OpenClaw 的 “Philip Leung” hallucination 在结构上不可能发生：LLM output 必须先过 JSON-Schema validator，才能到 Scaffolder。

### Phase 3 — `voltmind integrity` command（human: 约 0.5 周 / CC: 约 2 h）
- 在新 foundation 上 ship 原本 scoped 的 user-facing feature。
- 使用 Resolver SDK：`x_handle_to_tweet` + `url_reachable`。
- 使用 BrainWriter：所有 auto-repairs 都走 validated writes。
- `--auto --confidence 0.8` mode，按用户在 cherry-pick #1 中批准。
- **User-visible value 在 Phase 3 ship，而不是 Phase 7。**

### Phase 4 — Enrichment Orchestrator（human: 约 2 周 / CC: 约 8 h）
- L2 core：`EnrichmentOrchestrator`、`BudgetLedger`、`CompletenessScorer`、`EntityGraph.cascadeFrom`。
- 迁移 `src/core/enrichment-service.ts` callers（之后 deprecate 旧文件）。
- 每次 write 都在 frontmatter 写 completeness score（dogfooding cascades）。

### Phase 5 — Scheduler（human: 约 2 周 / CC: 约 8 h）
- L3 core：`Scheduler`、`ScheduledResolver`、`DurableState`、circuit breaker、quiet-hours enforcer。
- 将 `src/commands/autopilot.ts` 迁移为一组 ScheduledResolver。
- Ship `voltmind schedule list|run|pause|tail` CLI，用于 observability。

### Phase 6 — Port 5–8 OpenClaw resolvers（human: 约 1.5 周 / CC: 约 6 h）
- `perplexity_query`、`text_to_entities`、`mistral_ocr_pdf`、`x_search_all`、`x_user_to_tweets`、`gmail_query_to_threads`、`calendar_date_to_events`。
- 每个都作为 YAML + TS module ship 到 `resolvers/builtin/` 下 —— **证明 plugin format。**

### Phase 7 — OpenClaw Adoption Integration（human: 约 1 周 / CC: 约 4 h）
- 写 `docs/openclaw/ADOPTION.md`，展示你的 OpenClaw 如何用 `voltmind registry.resolve(...)` 替换 69 个 bespoke scripts。
- Ship `voltmind claw-bridge` subcommand，将 Garry 的 OpenClaw 当前 script invocations proxy 到 resolver registry —— 零编辑 adoption path。
- **这是 north star 的测试。** 如果你的 OpenClaw 能立起 1-line shim 并删除 `scripts/x-api-client.mjs`，这个 abstraction 就成功了。

总计：human 约 10 周 / CC 约 42 小时 / 单人实施 calendar 约 3–4 周。

---

## 9. Critical Files

### New directories / files

```
src/core/
  runtime/
    index.ts                       # RuntimeContext (engine, storage, config, logger, metrics, budget)
    registry.ts                    # ResolverRegistry
    factory.ts                     # createResolver()
  resolvers/
    interface.ts                   # Resolver<I, O>
    fail-improve-wrapper.ts        # auto-wraps every resolver in FailImproveLoop
    builtin/
      x-api/
        handle-to-tweet.ts
        handle-to-tweet.yaml
      perplexity/
        query.ts
        query.yaml
      brain-local/
        slug-lookup.ts
        url-reachable.ts
      embedding/
        openai.ts                  # refactored from src/core/embedding.ts
      transcription/
        groq.ts
        openai.ts
  enrichment/
    orchestrator.ts                # EnrichmentOrchestrator
    tiers.ts                       # TIER_CONFIG
    budget.ts                      # BudgetLedger
    completeness.ts                # CompletenessScorer + per-type rubrics
    cascade.ts                     # EntityGraph
  scheduling/
    scheduler.ts                   # Scheduler + ScheduledResolver
    schedule.ts                    # Schedule type, cron expr parser
    state.ts                       # DurableState primitives
    quiet-hours.ts                 # TZ-aware enforcement
    stagger.ts                     # deterministic slot assignment
  output/
    writer.ts                      # BrainWriter
    scaffold.ts                    # Scaffolder (typed URL builders)
    slug-registry.ts               # SlugRegistry (conflict detection)
    validators/
      citation.ts
      link.ts
      back-link.ts
      triple-hr.ts

src/commands/
  integrity.ts                     # ships in Phase 3, replaces Feynman Phase A/B
  schedule.ts                      # voltmind schedule list|run|pause|tail (Phase 5)

docs/openclaw/
  ADOPTION.md                      # written in Phase 7
```

### Replaced / removed
- `src/core/enrichment-service.ts` — fold into `enrichment/orchestrator.ts`
- `src/core/embedding.ts` — move into `resolvers/builtin/embedding/openai.ts`
- `src/core/transcription.ts` — move into `resolvers/builtin/transcription/`

### Extended
- `src/core/engine.ts` — add `getResolverRegistry()`、`getWriter()`、`getScheduler()`
- `src/core/operations.ts` — unify with ResolverContext；每个 operation validator 可被 resolvers 复用
- `src/core/types.ts` — add `completeness: number`、`sourcedBy: string[]`、`lastVerified: Date`

---

## 10. Testing Strategy

### Contract tests
每个 Resolver implementation 都按 interface spec 测试。Table-driven：对 `openai_embedding`、`x_handle_to_tweet` 等运行同一套 suite。确保 plugin authors 不能 ship broken resolvers。

### Property tests
- **Idempotency：** 用同一 state 运行 ScheduledResolver 两次，产出相同 output，且不会 double-write。
- **Atomicity：** BrainWriter transaction 中途 throw 后，brain 与 transaction 前 bit-for-bit identical。
- **Deterministic scaffolds：** 给定相同 resolver outputs，Scaffolder 产生 byte-identical citations/links。

### Integration tests
- `EnrichmentOrchestrator` end-to-end against PGLite（in-memory，无 API keys），mocked resolver registry。
- `Scheduler` with fake clock + quiet-hours scenarios。
- BrainWriter transaction rollback on validator failure。

### Chaos tests
- 在 enrichment 中途 kill process；下一次 run 必须 cleanly resume。
- 模拟 API timeout mid-transaction；transaction 必须完全 rollback。
- Corrupted state file；scheduler 必须 escalate，不能 silent skip。

### Regression tests vs. Garry's OpenClaw behavior
对每个 port 的 OpenClaw pattern（例如 X-handle → tweet URL），regression test 证明新 resolver 在 brain audit 的 real-world inputs 上产生相同答案。这是 “your OpenClaw would adopt” 的证明。

---

## 11. Open Questions（标记给 CEO re-review）

1. **Scope shape。** 这个四层 decomposition 对吗，还是某些层更适合留在 OpenClaw（例如 Scheduling 是否应位于 VoltMind 之上，而不是里面）？
2. **Phase 3 user-value break。** Phase 3（user-visible `voltmind integrity`）是否足够早 ship，还是需要更小 MVP？
3. **LLM-as-resolver。** `text_to_entities` 是否应该是 Resolver，还是会模糊 invariant 依赖的 “code vs LLM” 边界？
4. **Plugin format。** YAML + TS module（§3.5）vs. 带 decorator-style metadata 的纯 TS module。后者类型更安全；前者更 discoverable。
5. **Cross-resolver transactions。** 是否支持 L2 层的 “atomic fetch-from-Perplexity + write-to-brain”？当前设计说 yes；实现很 tricky（Perplexity call 无法 rollback）。
6. **OpenClaw bridge scope。** Phase 7 `voltmind claw-bridge` 是否值得独立 phase，还是 adoption 只写文档？
7. **Completeness rubric coverage。** 是否 upfront 定义所有 9 个 PageTypes 的 rubric，还是先 ship people/company/meeting 再逐步扩展？
8. **Budget config UX。** Hard daily cap 很严格；是否也暴露 soft-cap warning mode？cap 如何设置（env var？config file？首次使用 prompt？）
9. **Backwards compat。** `src/commands/publish.ts` 和 `src/commands/backlinks.ts` 已稳定运行数周。改经 BrainWriter 有迁移风险。可接受吗？
10. **Existing TODOS alignment。** `TODOS.md` 有 P0 “Runtime MCP access control” 和 P2 security hardening。新的 RuntimeContext.remote flag 与两者交互 —— 是否把 MCP access control 折入 Phase 0，还是保持独立？

---

## 12. Verification（“your OpenClaw would adopt” test）

设计成功 iff：

- [ ] 用户可以通过把 YAML + TS module 放入 `~/.voltmind/resolvers/` 添加新 resolver，无需编辑 VoltMind source。
- [ ] 你的 OpenClaw 可以删除 `scripts/x-api-client.mjs`，并把所有 caller 替换为 1-line `await registry.resolve('x_handle_to_tweet', ...)`。
- [ ] 任何 brain page 都无法被写入 bare tweet reference、missing back-link 或 unverified URL（validators 在 pre-commit 捕获）。
- [ ] 对真实 brain 运行 `voltmind integrity --auto --confidence 0.8`，无需人工 review 即可修复 1,424 个已知 bare-tweet citations 中的 ≥1,000 个。
- [ ] 完整 E2E test suite 在 PGLite + Postgres engines 上都通过。
- [ ] Knowledge Runtime 跨 7 个 phase ship，每个 phase 都可独立 ship 且可逆。

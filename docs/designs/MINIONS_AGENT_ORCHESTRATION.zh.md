---
status: ACTIVE
---
# CEO Plan: Minions 作为通用 Agent Orchestration Protocol
由 /plan-ceo-review 于 2026-04-15 生成
Branch: garrytan/minions-jobs | Mode: SCOPE EXPANSION
Repo: garrytan/voltmind

## Vision

### 10x Check
不要做成 “VoltMind 有一个 queue，OpenClaw 使用它”，而要让 Minions 成为通用 agent orchestration protocol。任何平台（OpenClaw、Hermes、Claude Code、Codex、自定义 scripts）都通过同一个 Postgres-native protocol 提交、监控、引导和组合 agents。VoltMind 就是 agent control plane。

### Platonic Ideal（aspirational North Star，不在 v1 scope）
打开终端，输入 `voltmind jobs dashboard`。看到跨所有平台的每个 agent。它们的 progress、tool calls、token spend。点击任意 agent 查看完整 execution trace。给运行中的 agent 发送消息，mid-flight redirect。看到 governor 的决策可视化。在 agent configurations 之间运行 A/B tests。感觉是：对你的 AI workforce 拥有完整 situational awareness。

**说明：** Dashboard、A/B testing 和 visual governor 是未来阶段。本计划构建它们之上的 primitives：real-time events、structured progress、token accounting、带 ack 的 inbox，以及 session transcripts。

## Scope Decisions

| # | Proposal | Effort | Decision | Reasoning |
|---|----------|--------|----------|-----------|
| 1 | pg LISTEN/NOTIFY real-time events | S | ACCEPTED | 亚秒级 event delivery，而不是 5s polling。每个平台受益。 |
| 2 | Structured progress protocol | S | ACCEPTED | 标准 progress 使 unified dashboard 成为可能。 |
| 3 | Job cost tracking (token accounting) | M | ACCEPTED | Token cost 是用户最想知道的 agent work 信息。 |
| 4 | Job replay | S | ACCEPTED | Surface area 小，debug failures 的实用性高。 |
| 5 | Job groups / waves | M | DEFERRED | Parent-child 已提供 grouping。存在重叠顾虑。 |
| 6 | Inbox acknowledgment (read receipts) | S | ACCEPTED | 没有它，inbox 就是 fire-and-forget，正是我们在修的问题。 |
| 7 | Universal agent protocol | S | ACCEPTED | 设计 framing，不是额外代码。Platform-agnostic naming/docs。 |
| 8 | Session transcript capture | M | ACCEPTED | 每次 agent run 的完整 audit trail。 |

## Accepted Scope — Implementation Detail

### 0a. Pause/resume（来自 base plan）

**Schema：** 将 `'paused'` 加入 `MinionJobStatus`（migration v6 constraint 中已有）。

**New methods：**
- `MinionQueue.pauseJob(id): MinionJob | null`
  将 `waiting` 或 `active` → `paused`。对 `active` jobs，清除 `lock_token` 和 `lock_until`（worker 会检测 lock loss 并停止）。如果 job 不处于可 pause 状态，返回 null。
- `MinionQueue.resumeJob(id): MinionJob | null`
  将 `paused` → `waiting`。重置以便 claim。如果不是 paused，返回 null。

**Worker integration：** Worker 的 lock renewal loop 检查 `isActive()`。Job 被 paused 时 lock 被清除，因此 `renewLock()` 返回 false，worker 优雅停止 execution（与 stall detection 同一路径）。Job 的 progress 和 state 保存在 DB 中，resume 时继续。

**MCP operations：** `pause_job`、`resume_job`（在 implementation plan Step 3 中添加）。

**PGLite compatibility：** Full。

### 0b. Resource governor（来自 base plan）

**New file：** `src/core/minions/governor.ts`

```typescript
interface GovernorConfig {
  maxConcurrency: number;       // ceiling
  minConcurrency: number;       // floor (default 1)
  checkIntervalMs: number;      // default 10000
  cpuThreshold: number;         // default 0.80 (80%)
  memoryThreshold: number;      // default 0.85 (85%)
  circuitBreakerMemory: number; // default 0.90 (90%)
}

class ResourceGovernor {
  getEffectiveConcurrency(): number;  // current allowed concurrency
  start(): void;                       // begin polling system metrics
  stop(): void;                        // stop polling
  onCircuitBreak(cb: (jobId) => void): void; // kill callback
}
```

**System metrics：** 复用 `src/core/backoff.ts` 中的 `getSystemLoad()`（已实现 CPU 和 memory checks）。通过 `perf_hooks.monitorEventLoopDelay()` 添加 event loop lag measurement。

**Worker integration：** `MinionWorker.start()` 在 claim 新 job 前查询 `governor.getEffectiveConcurrency()`。如果当前 in-flight count >= effective concurrency，则跳过 claim。

**Circuit breaker：** 如果 memory > 90%，governor 用最低优先级 active job ID 调用 `onCircuitBreak`。Worker 通过 `failJob()` 取消该 job，并使用 `UnrecoverableError("circuit breaker: memory pressure")`。

**Prerequisite：** 必须先实现 concurrent job processing（见下方 Concurrency Note）。

**PGLite compatibility：** Full（governor 是 app-level，不是 DB-level）。

### 1. pg LISTEN/NOTIFY（real-time events）

**Schema：** 无新列。在 state transitions 上添加 NOTIFY triggers。

**SQL trigger：**
```sql
CREATE OR REPLACE FUNCTION notify_minion_job_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('minion_jobs', json_build_object(
    'id', NEW.id, 'status', NEW.status, 'name', NEW.name,
    'queue', NEW.queue, 'prev_status', COALESCE(OLD.status, 'new')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER minion_job_notify AFTER INSERT OR UPDATE OF status ON minion_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_minion_job_change();
```

**New method：** `MinionQueue.subscribe(callback: (event) => void): () => void`
返回 unsubscribe function。需要 direct Postgres connection（不是 pooled）。

**PGLite compatibility：** PGLite 不支持 LISTEN/NOTIFY。Fallback：通过 `getJob()` 按可配置 interval polling（默认 2s）。`subscribe()` 方法检测 engine type，并自动使用 polling fallback。

**Supabase constraint：** 需要 direct connection（port 5432），不是 pgBouncer pooler（port 6543）。在 skill file 和 setup guide 中记录。

### 2. Structured progress protocol

**TypeScript interface（convention，不在 DB 层强制）：**
```typescript
interface AgentProgress {
  step: number;           // current step (1-based)
  total: number;          // total expected steps (0 = unknown)
  message: string;        // human-readable status
  tokens_in: number;      // cumulative input tokens
  tokens_out: number;     // cumulative output tokens
  last_tool: string;      // name of last tool called
  started_at: string;     // ISO 8601 when this step started
}
```

**Storage：** 现有 `progress JSONB` column。无需 schema change。Handlers 使用 `ctx.updateProgress(agentProgress)`。非 agent jobs 可使用任何 JSONB shape（backward compatible）。

**Validation：** `updateProgress()` 接受任意 JSONB。`AgentProgress` interface 是由 agent handler 强制的 convention，不由 queue 强制。

### 3. Job cost tracking（token accounting）

**Schema changes（migration v6）：**
```sql
ALTER TABLE minion_jobs ADD COLUMN tokens_input INTEGER DEFAULT 0;
ALTER TABLE minion_jobs ADD COLUMN tokens_output INTEGER DEFAULT 0;
ALTER TABLE minion_jobs ADD COLUMN tokens_cache_read INTEGER DEFAULT 0;
ALTER TABLE minion_jobs ADD COLUMN cost_usd NUMERIC(10,6) DEFAULT 0;
```

**New method：** `MinionQueue.updateTokens(id, lockToken, { input, output, cache_read, cost_usd })`
累加（加到现有值上，而不是替换）。

**Parent rollup：** 调用 `completeJob()` 时，如果设置了 `parent_job_id`，通过以下 SQL 将 child token counts 加到 parent：
```sql
UPDATE minion_jobs SET
  tokens_input = tokens_input + $child_input,
  tokens_output = tokens_output + $child_output,
  tokens_cache_read = tokens_cache_read + $child_cache,
  cost_usd = cost_usd + $child_cost
WHERE id = $parent_id;
```

**PGLite compatibility：** Full support（standard columns）。

### 4. Job replay

**New method：** `MinionQueue.replayJob(id, dataOverrides?: Record<string, unknown>): MinionJob`

实现：读取 completed/failed/dead job。创建一个 NEW job，带：
- 相同的 `name`、`queue`、`priority`、`max_attempts`、`backoff_type`、`backoff_delay`
- `data` = 原始 data + overrides 的 deep merge
- 新的 `attempts_made: 0`、`status: 'waiting'`
- `parent_job_id` = null（replay 是新的 top-level job，不是 child）
- 不 clone children（replay 是单 job，不是 DAG）

**Constraint：** 只适用于 terminal statuses（completed/failed/dead）。返回新 job record。

**Idempotency：** 每次 replay 创建不同的新 job。不做 deduplication。如果原 job 有 side effects，replay 可能重复它们。在 skill file 中记录这是用户责任。

### 5. Inbox（sidechannel messaging）

**Schema changes（migration v6）：**
```sql
ALTER TABLE minion_jobs ADD COLUMN inbox JSONB DEFAULT '[]';
```

**Inbox message format：**
```typescript
interface InboxMessage {
  id: string;          // UUIDv4
  sent_at: string;     // ISO 8601
  read_at: string | null;  // null until worker reads it
  sender: string;      // 'parent' | 'user' | job ID
  payload: unknown;    // arbitrary directive
}
```

**New methods：**
- `MinionQueue.sendMessage(jobId, payload, sender?): InboxMessage`
  通过 atomic JSONB append（`inbox = inbox || $1::jsonb`）向 inbox array 追加消息，而不是 read-modify-write。返回带 id + sent_at 的 message。
- `MinionQueue.readInbox(jobId, lockToken): InboxMessage[]`
  返回 unread messages（read_at = null）。将其标为 read（设置 read_at）。Token-fenced：只有持有 lock 的 worker 可以读取。

**Worker integration：** Agent handler 在每次 iteration 调用 `readInbox()`。如果存在消息，将其作为 system messages 注入 agent context。

**PGLite compatibility：** Full support（standard JSONB column）。

### 6. Inbox acknowledgment（read receipts）

已内建在上述 inbox 设计中。每个 `InboxMessage` 的 `read_at` 字段提供 receipt。`sendMessage()` 返回 message ID；sender 之后可以 `getJob(id)` 并检查 `inbox`，看哪些消息已读。

除了 #5 中的内容外，不需要额外 schema 或 methods。

### 7. Universal agent protocol（platform-agnostic framing）

**这是设计决策，不是代码。** 它意味着：

1. Skill file（`skills/minion-orchestrator/SKILL.md`）面向任意 agent platform 编写，而不只是 OpenClaw。示例展示 MCP tool calls，不展示 OpenClaw-specific commands。

2. Agent handler（`agent-handler.ts`）接受通用 interface：
   ```typescript
   interface AgentJobData {
     prompt: string;
     tools?: string[];        // MCP tool names
     model?: string;          // e.g., 'claude-opus-4-6', 'gpt-4o'
     context?: string;        // additional context
     platform?: string;       // 'openclaw' | 'hermes' | 'claude-code' | 'custom'
     max_iterations?: number; // agent loop budget
   }
   ```

3. OpenClaw plugin 是一个 consumer。Hermes、Claude Code extensions 或自定义 scripts 都可以通过相同 MCP operations 提交 `agent` jobs。

4. **不在 v1 scope：** Multi-tenant auth、cross-network connectivity、protocol versioning、API key isolation。这些是 Phase 2 concerns，等真实 multi-platform usage 出现后再做。v1 是 single-user、single-brain。

### Agent Handler Architecture（关键设计决策）

Agent handler 不住在 VoltMind 里。VoltMind 提供 queue infrastructure 和干净的 handler contract。真正的 agent execution 生活在 platform plugin 中。

```
VoltMind (this repo):
  MinionQueue  — queue/claim/complete/inbox/tokens/NOTIFY
  MinionWorker — poll/lock/stall/governor framework
  Handler contract — AgentJobData interface + MinionJobContext

OpenClaw plugin (separate repo):
  Registers "agent" handler with MinionWorker
  Handler calls OpenClaw's PI agent core (the actual LLM loop)
  Each iteration: readInbox → inject as system message, updateProgress, updateTokens
  Completion: store result + session transcript in job.result + job.stacktrace

VoltMind ships a test/echo handler for unit testing only.
```

**Handler contract（VoltMind side）：**
```typescript
// The handler receives this context (already exists in worker.ts)
interface MinionJobContext {
  id: number;
  name: string;
  data: Record<string, unknown>;  // AgentJobData when name="agent"
  attempts_made: number;
  updateProgress(progress: unknown): Promise<void>;
  updateTokens(tokens: TokenUpdate): Promise<void>;  // NEW
  log(message: string | TranscriptEntry): Promise<void>;
  isActive(): Promise<boolean>;
  readInbox(): Promise<InboxMessage[]>;  // NEW
}
```

**为什么这是对的：** VoltMind 是 orchestration，不是 execution。OpenClaw 有 PI agent core。Hermes 有 AIAgent。Claude Code 有自己的 loop。每个平台带来自己的 engine 并注册 handler。VoltMind 管理围绕它的 lifecycle、progress、steering、cost tracking 和 persistence。

### 8. Session transcript capture

**扩展现有 stacktrace 机制。** `stacktrace` 字段（JSONB array of strings）已经捕获 log messages。Session transcripts 使用同一字段，存 structured entries：

```typescript
type TranscriptEntry =
  | { type: 'log'; message: string; ts: string }
  | { type: 'tool_call'; tool: string; args_size: number; result_size: number; ts: string }
  | { type: 'llm_turn'; model: string; tokens_in: number; tokens_out: number; ts: string }
  | { type: 'error'; message: string; stack?: string; ts: string };
```

**Storage：** 现有 `stacktrace JSONB` column。无 schema change。Agent handler 追加 `TranscriptEntry` object，而不是 plain string。Backward compatible：非 agent jobs 继续追加 strings。

**Size concern：** 长 agent run 可能生成大 transcript。添加 `max_transcript_entries` 选项（默认 1000），超出时旋转最旧 entries（FIFO）。用于 forensic analysis 的完整 transcript 可以通过 `voltmind files upload-raw` 存为 brain file。

## Schema Migration v6

所有 schema changes 都是 additive（ALTER TABLE ADD COLUMN）。不需要 backfill。现有 jobs 继续用默认值工作。

```sql
-- Migration v6: Agent orchestration primitives
ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_input INTEGER DEFAULT 0;
ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_output INTEGER DEFAULT 0;
ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS tokens_cache_read INTEGER DEFAULT 0;

-- Separate inbox table (not JSONB on job row)
CREATE TABLE IF NOT EXISTS minion_inbox (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  payload JSONB NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_minion_inbox_unread
  ON minion_inbox (job_id) WHERE read_at IS NULL;

-- Status constraint update: add 'paused'
ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS minion_jobs_status_check;
ALTER TABLE minion_jobs ADD CONSTRAINT minion_jobs_status_check
  CHECK (status IN ('waiting','active','completed','failed','delayed','dead','cancelled','waiting-children','paused'));

-- NOTIFY trigger for real-time events (Postgres only, not PGLite)
CREATE OR REPLACE FUNCTION notify_minion_job_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('minion_jobs', json_build_object(
    'id', NEW.id, 'status', NEW.status, 'name', NEW.name,
    'queue', NEW.queue, 'prev_status', COALESCE(OLD.status, 'new')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER minion_job_notify AFTER INSERT OR UPDATE OF status ON minion_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_minion_job_change();
```

## PGLite Compatibility Matrix

| Feature | Postgres | PGLite | Fallback |
|---|---|---|---|
| Pause/resume | Full | Full | — |
| Inbox + ack | Full | Full | — |
| Token accounting | Full | Full | — |
| Job replay | Full | Full | — |
| LISTEN/NOTIFY | Full | NO | Polling (2s interval) |
| NOTIFY trigger | Full | NO | Skipped in PGLite schema |
| Structured progress | Full | Full | — |
| Session transcripts | Full | Full | — |
| Resource governor | Full | Full | — |
| Worker daemon | Full | NO (existing limitation) | — |

## Concurrency Note

当前 `MinionWorker.start()` 仍然顺序处理 jobs（一次一个），尽管 `MinionWorkerOpts` 中声明了 `concurrency`。实现真正的 concurrent job processing（Promise pool）是 resource governor 有意义的前提。Governor 调整 effective concurrency，而这要求实际并发处理存在。

**Action：** 在 governor step 之前或其中实现 `worker.ts` 中的 concurrent job processing。使用 semaphore pattern：最多维持 N 个 in-flight promises，随着 slots 释放 claim new jobs。

## Outside Voice Decisions（来自 adversarial review）

1. **AbortController for pause/resume** — Handler contract 获得 `signal: AbortSignal`。Pause 清除 lock 并发出 abort signal。Handler 必须在每次 iteration 检查 `signal.aborted`。没有它，pause active jobs 会造成 duplicate execution。

2. **Drop cost_usd column** — Token counts（input/output/cache_read）是稳定事实。USD pricing 是 volatile。成本在 display/read time 从 pricing table 计算，而不是写入时计算。因此从 migration v6 移除 `cost_usd NUMERIC(10,6)`。

3. **Separate minion_inbox table** — 不在 job row 上用 JSONB array，而是使用 dedicated table 存 inbox messages。避免每次 send 都重写整行 inbox 造成 row bloat。标准 INSERT 下 properly concurrent-safe（无 JSONB append concerns）。
   ```sql
   CREATE TABLE minion_inbox (
     id SERIAL PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
     sender TEXT NOT NULL,
     payload JSONB NOT NULL,
     sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     read_at TIMESTAMPTZ
   );
   CREATE INDEX idx_minion_inbox_unread ON minion_inbox (job_id) WHERE read_at IS NULL;
   ```

4. **One release, not two** — 在一个 migration（v6）中 ship 所有功能。用户偏好 cohesive release，而不是该 feature set 的 incremental delivery。

5. **Selective column projection** — 修复 getJobs()、claim()、handleStalled() 中的 SELECT * queries，排除 stacktrace column。只在 getJob() detail view 中包含 stacktrace。防止 transcript bloat 影响 query performance。

## Future Phases（accepted trajectory）

- **Phase 2: Dashboard CLI** — `voltmind jobs dashboard` live TUI，显示所有 agents。
  Enabled by: LISTEN/NOTIFY、structured progress、token accounting。
- **Phase 3: Multi-tenant auth** — Runtime MCP access control、per-platform API keys。
  Enabled by: platform-agnostic framing、sender validation on inbox。
- **Phase 4: Agent composition patterns** — Map-reduce、pipeline、approval gates 作为 first-class primitives。
  Enabled by: parent-child DAGs、inbox sidechannel。

## Deferred to TODOS.md
- Job groups / waves（parent-child 覆盖此需求；如果真实 grouping need 出现再 revisit）
- cost_usd column（未来有 pricing API 时，在 read time 从 pricing table 计算）

## Key Premises Confirmed
1. VoltMind 正在有意从 knowledge brain 演进为 agent infrastructure（用户确认）
2. OpenClaw 与 VoltMind Postgres 的耦合可接受（OpenClaw 已依赖 VoltMind）
3. 选择 Full Infrastructure approach（全部 8+ steps），而不是 Minimal Viable 或 Sidecar Tracking
4. 先前学习 [agent-dx-instruction-layer] 验证 teaching layer（skill + evals）是 mandatory

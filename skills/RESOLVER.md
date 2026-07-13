# VoltMind MVP Skill Resolver

This is the agent-side dispatcher for the VoltMind MVP. Skills are the implementation.
Read the matched skill file before acting.

## MVP Freeze Rule

VoltMind is currently a local-first knowledge-base MVP. Route only to skills and
commands that sit inside the runtime MVP boundary. Inherited GBrain skills remain
in the tree for later phases, but are frozen from public agent routing.

If the user asks for a frozen capability, say it is not included in VoltMind MVP
yet and offer the closest MVP-safe path. Do not call hidden runtime commands, do
not suggest inherited `gbrain` commands, and do not route through advanced skills
just because the file still exists.

## Always-on

| Trigger | Skill |
|---------|-------|
| Any VoltMind read/write/lookup/citation | `skills/brain-ops/SKILL.md` |

`skills/signal-detector/SKILL.md` is partially available for MVP as controlled
signal enrichment. It may run only on explicit, source-backed write paths
(`capture`, `import`, `sync`, `put_page`, meeting ingestion, and
`extract-conversation-facts --source-id`). It must not run ambient web/social
crawlers, monthly re-enrichment loops, autopilot, dream, or unsourced
background page creation.

## MVP Routes

## Brain operations

| Trigger | Skill |
|---------|-------|
| "meeting notes", "meeting transcript", "process this meeting", "会议整理", "会议纪要", "会议抽取" | `skills/meeting-ingestion/SKILL.md` |
| "daily plan", "daily review", "today brief", "每日", "今日计划", "明日计划" | `skills/daily/SKILL.md` |
| "project update", "update project page", "project context", "open threads", "项目更新", "项目上下文" | `skills/project/SKILL.md` |
| "review draft", "approve changes", "reject changes", "edit before writing", "确认写入", "审核草稿" | `skills/review/SKILL.md` |
| "enrich", "create person page", "update company page", "who is this person", "look up this company" | `skills/enrich/SKILL.md` |
| "fix citations", "fix broken citations", "citation audit", "check citations", "citation fixer" | `skills/citation-fixer/SKILL.md` |
| "validate skills", "test skills", "skill health check", "run conformance tests", "run the tests", "how are the tests", "what's broken", "daily test run" | `skills/testing/SKILL.md` |
| "what do we know about", "tell me about", "search for", "who is", "background on", "notes on" | `skills/query/SKILL.md` |
| "who knows who", "relationship between", "connections", "backlinks", "links", "timeline", "tags" | `skills/query/SKILL.md` |
| "build the graph", "link these entities", "create relationship", "connect pages", "整理实体关系", "建链" | `skills/brain-ops/SKILL.md` |
| "capture this", "save this thought", "remember this", "drop this in the inbox", "save to brain" | `skills/capture/SKILL.md` |
| "ingest this", "import this folder", "sync this source", "embed stale chunks" | `skills/ingest/SKILL.md` |
| "enrich signals", "signal enrichment", "run enrichment", "enrich this source" | `skills/enrich/SKILL.md` |
| "cold start", "fill my brain", "bootstrap brain", "import my data", "what should I import first", "populate brain", "now what?", "离线导入", "初始化数据", "冷启动" | `skills/cold-start/SKILL.md` |
| "Set up VoltMind", first boot, Bun install, local init | `skills/setup/SKILL.md` |
| "brain health", "doctor", "status", "embedding freshness", "job status", "cancel job" | `skills/maintain/SKILL.md` |
| "minions", "job queue", "background jobs", "what jobs are running", "jobs stats" | `skills/minion-orchestrator/SKILL.md` |
| "schedule a job", "cron", "recurring job", "autopilot schedule", "daily maintenance" | `skills/cron-scheduler/SKILL.md` |
| "install autopilot", "set up autopilot", "autopilot install", "one-step autopilot + Minions", "Windows Task Scheduler", "launchd autopilot" | `skills/setup/SKILL.md` |
| "where should this page go", filing rules, source selection | `skills/brain-ops/SKILL.md` plus `skills/_brain-filing-rules.md` |
| "present options", "ask before proceeding", "choice gate", "user decision" | `skills/ask-user/SKILL.md` |

## Content & media ingestion

Phase 1 routes meeting notes and transcripts through `skills/meeting-ingestion/SKILL.md`; inherited media/book/PDF pipelines are frozen unless explicitly working on future phases.

## Operational

Use setup, maintain, review, and jobs visibility skills only inside the MVP command surface below.

## MVP Command Surface

Agent-facing skills may use only these public runtime commands unless the user is
explicitly working on VoltMind internals:

- Setup/runtime: `voltmind init`, `voltmind config`, `voltmind storage`,
  `voltmind providers`, `voltmind sources`, `voltmind status`, `voltmind doctor`,
  `voltmind apply-migrations`.
- Page CRUD: `voltmind get`, `voltmind put`, `voltmind list`,
  `voltmind delete`, `voltmind restore`, `voltmind search`,
  `voltmind query`.
- Ingestion: `voltmind import`, `voltmind capture`, `voltmind sync`,
  `voltmind embed`, `voltmind enrich`.
- File migration: `voltmind files mirror`, `voltmind files redirect`,
  `voltmind files restore`, `voltmind files clean`, `voltmind files status`,
  `voltmind files upload-raw`, and related `voltmind files` host-local
  subcommands. Run these on the machine that owns the files; do not route them
  through thin-client or MCP tool calls.
- Retrieval enrichment: `voltmind extract`, `voltmind extract-conversation-facts`,
  `voltmind transcripts`. Write-mode extraction must use explicit `--source-id`;
  use `--dry-run` for previews. MCP may use read-only `get_recent_transcripts`
  and `find_contradictions`.
- Judgment readouts: `voltmind takes <slug>`, `voltmind takes search <query>`,
  and `voltmind conversation-parser` diagnostics. MCP may use read-only
  `find_trajectory`, `takes_list`, and `takes_search`.
- Basic graph/context: `voltmind link`, `voltmind unlink`,
  `voltmind backlinks`, `voltmind tags`, `voltmind timeline`,
 `voltmind timeline-add`, `voltmind graph`. For outgoing-link inspection, use
 MCP `get_links` through `voltmind call`.
 For typed/directional graph traversal, use `voltmind graph-query`.
- Knowledge insights: `voltmind salience`, `voltmind anomalies`,
  `voltmind whoknows`, `voltmind calibration`. MCP may use
  `get_recent_salience`, `find_anomalies`, `find_experts`, and
  `get_calibration_profile`.
- Provenance/review: `voltmind candidates list|get|preview|apply|reject`.
  Apply requires explicit source, citation, and confirmation. MCP may use
  candidate propose/preview/apply/reject ops with the same explicit-source
  boundary.
- Signal enrichment: `voltmind enrich preview|apply --source-id <id>`.
  MCP may use `preview_signal_enrichment` and `apply_signal_enrichment`.
  Apply requires explicit source-backed signal and confirmation.
- Controlled memory: `voltmind recall` is one-shot/read-only. `voltmind forget`
  is limited to `preview` and explicit `apply`; no direct legacy forget path.
- MCP: `voltmind serve`, `voltmind call`.
- Jobs: `voltmind jobs list`, `voltmind jobs get`,
  `voltmind jobs cancel`, `voltmind jobs progress`, `voltmind jobs failures`,
  `voltmind jobs checkpoints`, `voltmind jobs undo-report`,
  `voltmind jobs plan --dry-run`, `voltmind jobs stats`.
- Autopilot (host-local): `voltmind autopilot --install`,
  `voltmind autopilot --status`, `voltmind autopilot --uninstall`,
  `voltmind autopilot --help`. Runs on the host with a supervised Minions
  worker; requires Postgres/Supabase. Not routed through remote MCP.

Use `VOLTMIND_HOME`, `VOLTMIND_SOURCE`, `.voltmind-source`, and
`voltmind.yml`. Old `GBRAIN_*`, `.gbrain`, and `gbrain.yml` names are not part
of the MVP route.

## Frozen Inherited Routes

Keep these files/modules recoverable, but do not dispatch to them in MVP:

- Autonomous or agentic systems: `agent`, `dream`, `think`,
  recall watch/auto-briefing loops, direct legacy forget, `onboard`, `founder`.
  Note: `voltmind autopilot` is public for host-local Postgres/Supabase
  installs (Windows Task Scheduler / macOS launchd / Linux systemd/cron).
  It is NOT routed through remote MCP or thin-client execution.
- Advanced runtime analysis: `eval`, search-mode tuning, code intelligence,
  trajectory mutation/scorecard flows, and takes mutation/scorecard flows. The
  narrow retrieval-enrichment, judgment-readout, and knowledge-insight commands
  above are public in the MVP runtime.
- Skill platform features: `skillpack`, `skillify`, skill harvesting,
  schema authoring/evolution, functional-area resolver compression.
- Advanced ingestion: media/book/podcast/PDF pipelines,
  social/web research enrichers, archive crawler, academic verification,
  publish/export flows.
- Background orchestration beyond MVP visibility: Minion submit/shell/worker,
  subagent routing, host scheduler installation, and dream
  maintenance. Host-local `voltmind autopilot --install` (which supervises a
  single Minions worker consuming the Postgres queue) is allowed on the host;
  remote `submit_job`, remote shell, and remote subagent remain frozen.
  Source-backed signal enrichment on explicit MVP write paths is
  allowed; ambient webhook/social crawlers remain frozen. Jobs readouts and
  dry-run plans remain allowed.
- Multi-brain/topology flows: mounts, cross-brain federation, thin-client setup,
  remote artifact brains, and remote/cloud topology setup beyond host-local
  `voltmind files` migration.

When a frozen route is requested, prefer one of:

- Store the raw information with `voltmind capture`.
- Import local markdown with `voltmind import`.
- Refresh retrieval with `voltmind embed --stale`.
- Retrieve context with `voltmind search`, `voltmind query`, `voltmind get`,
  or graph commands.
- Materialize explicit page relationships with `voltmind link` or MCP
  `add_link` when the relationship is part of an agent-curated page.
- Preserve raw enrichment evidence with MCP `put_raw_data` through
  `voltmind call`; retrieve it with `get_raw_data`.
- Preview or run explicit retrieval enrichment with `voltmind extract --dry-run`,
  `voltmind extract --source-id <id>`, or
  `voltmind extract-conversation-facts --source-id <id>`.
- Inspect cached contradiction readouts with MCP `find_contradictions`; do not
  launch fresh eval probes as part of normal MVP routing.
- Read active judgment context with `voltmind takes <slug>`,
  `voltmind takes search <query>`, MCP `takes_list`, MCP `takes_search`, or
  MCP `find_trajectory`; do not write back judgment changes automatically.
- Use `voltmind candidates preview/apply` for reviewed enrichment writes and
  `voltmind forget preview/apply` for explicit forgets; both require citations.
- Report "not included in VoltMind MVP yet" for anything outside that surface.

## Disambiguation rules

1. Prefer the narrowest MVP skill that can complete the user request.
2. If a request mixes MVP and frozen capability, do the MVP-safe part and state
   what is frozen.
3. If the user mentions a URL, PDF, video, podcast, or transcript, capture or
   import the text only unless they explicitly ask for a future design plan.
4. If the user asks for background jobs, expose only list/get/cancel/readout/dry-run plan commands.
5. When in doubt, ask the user for the target source or whether to save content.

## Conventions

These apply to all MVP brain-writing skills:

- `skills/conventions/quality.md` — citations, back-links, notability gate.
- `skills/conventions/brain-first.md` — check VoltMind before external APIs.
- `skills/conventions/brain-routing.md` — local PGLite brain plus active source.
- `skills/ask-user/SKILL.md` — choice-gate pattern for human input.
- `skills/_brain-filing-rules.md` — where pages go.
- `skills/_output-rules.md` — output quality standards.

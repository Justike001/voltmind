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

`skills/signal-detector/SKILL.md` is frozen for MVP. Do not run ambient entity
detection or background enrichment loops automatically.

## MVP Routes

## Brain operations

| Trigger | Skill |
|---------|-------|
| "meeting notes", "meeting transcript", "process this meeting", "会议整理", "会议纪要", "会议抽取" | `skills/meeting/SKILL.md` |
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
| "cold start", "fill my brain", "bootstrap brain", "import my data", "what should I import first", "populate brain", "now what?", "离线导入", "初始化数据" | `skills/cold-start/SKILL.md` |
| "Set up VoltMind", first boot, Bun install, local init | `skills/setup/SKILL.md` |
| "brain health", "doctor", "status", "embedding freshness", "job status", "cancel job" | `skills/maintain/SKILL.md` |
| "minions", "job queue", "background jobs", "what jobs are running", "jobs stats" | `skills/minion-orchestrator/SKILL.md` |
| "schedule a job", "cron", "recurring job", "autopilot schedule", "daily maintenance" | `skills/cron-scheduler/SKILL.md` |
| "where should this page go", filing rules, source selection | `skills/brain-ops/SKILL.md` plus `skills/_brain-filing-rules.md` |
| "present options", "ask before proceeding", "choice gate", "user decision" | `skills/ask-user/SKILL.md` |

## Content & media ingestion

Phase 1 routes meeting notes through `skills/meeting/SKILL.md`; inherited media/book/PDF and enrichment skills are frozen unless explicitly working on future phases.

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
  `voltmind embed`.
- Basic graph/context: `voltmind link`, `voltmind unlink`,
  `voltmind backlinks`, `voltmind tags`, `voltmind timeline`,
  `voltmind timeline-add`, `voltmind graph`. For outgoing-link inspection, use
  MCP `get_links` through `voltmind call`.
- MCP: `voltmind serve`, `voltmind call`.
- Jobs: `voltmind jobs list`, `voltmind jobs get`,
  `voltmind jobs cancel`, `voltmind jobs stats`.

Use `VOLTMIND_HOME`, `VOLTMIND_SOURCE`, `.voltmind-source`, and
`voltmind.yml`. Old `GBRAIN_*`, `.gbrain`, and `gbrain.yml` names are not part
of the MVP route.

## Frozen Inherited Routes

Keep these files/modules recoverable, but do not dispatch to them in MVP:

- Autonomous or agentic systems: `agent`, `autopilot`, `dream`, `think`,
  `recall`, `forget`, `onboard`, `founder`, `takes`, `transcripts`.
- Advanced runtime analysis: `eval`, search-mode tuning, salience, anomaly,
  calibration, experts, contradiction, trajectory, code intelligence.
- Skill platform features: `skillpack`, `skillify`, skill harvesting,
  schema authoring/evolution, functional-area resolver compression.
- Advanced ingestion: media/book/podcast/PDF pipelines, inherited meeting enrichment,
  social/web research enrichers, archive crawler, academic verification,
  publish/export flows.
- Background orchestration beyond MVP visibility: Minion submit/shell/worker,
  subagent routing, webhook transforms, host scheduler installation, autopilot,
  and dream maintenance. Jobs list/get/cancel/stats remain allowed.
- Multi-brain/topology flows: mounts, cross-brain federation, thin-client setup,
  remote artifact brains, cloud storage migration.

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
- Report "not included in VoltMind MVP yet" for anything outside that surface.

## Disambiguation rules

1. Prefer the narrowest MVP skill that can complete the user request.
2. If a request mixes MVP and frozen capability, do the MVP-safe part and state
   what is frozen.
3. If the user mentions a URL, PDF, video, podcast, or transcript, capture or
   import the text only unless they explicitly ask for a future design plan.
4. If the user asks for background jobs, expose only list/get/cancel/stats.
5. When in doubt, ask the user for the target source or whether to save content.

## Conventions

These apply to all MVP brain-writing skills:

- `skills/conventions/quality.md` — citations, back-links, notability gate.
- `skills/conventions/brain-first.md` — check VoltMind before external APIs.
- `skills/conventions/brain-routing.md` — local PGLite brain plus active source.
- `skills/ask-user/SKILL.md` — choice-gate pattern for human input.
- `skills/_brain-filing-rules.md` — where pages go.
- `skills/_output-rules.md` — output quality standards.

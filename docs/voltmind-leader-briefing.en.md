# VoltMind — Complete Leader Presentation Script

> Core slide script: approximately 15 minutes at a measured speaking pace. The Resolver table, demos, architecture notes, and Q&A are optional appendix material.
>
> Current checkout version: `0.42.0.0`, based on `package.json`.

## Executive positioning

**VoltMind is a persistent knowledge brain and knowledge runtime for AI agents. It turns scattered Markdown files, meetings, people, projects, and ideas into a system that agents can search, trace, reason over, and continuously improve. Instead of returning a list of documents, VoltMind can produce a cited answer, explain the relationships behind it, and identify what the brain still does not know.**

The shortest version of the product differentiation is:

> Traditional RAG returns documents. VoltMind returns a cited answer, explains the relationships, and tells the agent what is still unknown.

---

## Slide 1 — The problem and the product

### Suggested slide title

**AI agents are intelligent, but they do not have durable knowledge of our world**

### Full speaking script

Today I would like to introduce VoltMind, a persistent knowledge brain built specifically for AI agents.

Modern agents are already very capable at reasoning, writing, coding, and using tools. However, they still have a major weakness: they do not naturally maintain a durable understanding of the people, projects, meetings, decisions, and commitments in our world.

This creates three practical problems.

First, agents suffer from conversational amnesia. We may discuss a project or make a commitment on Monday, but by Friday the agent may need the same background again.

Second, retrieval is not the same as an answer. A conventional search engine or RAG system may return five relevant pages, but a human still has to open them, compare them, and work out what actually matters.

Third, knowledge does not improve automatically. New meetings, emails, files, and ideas often remain isolated. They do not become relationships, timelines, structured facts, or follow-up actions.

VoltMind addresses these problems by adding a long-running brain layer between the agent and the user's personal or organizational knowledge.

I would describe it using three words.

It is **persistent**, because the context survives across conversations, agents, and devices.

It is **structured**, because it stores more than text chunks. It understands entities, page types, typed relationships, timelines, facts, takes, projects, risks, and actions.

And it is **actionable**, because the final output is not simply a file list. It can be an answer, a briefing, a risk, an action, or an explicit knowledge gap.

The goal is not to build another note-taking application. The goal is to give agents a durable and continuously improving model of the user's world.

---

## Slide 2 — Search is a step; the answer is the product

### Suggested slide title

**From page retrieval to cited answers**

### Full speaking script

The easiest way to understand VoltMind is through a meeting-preparation example.

Imagine that I ask:

> What do I need to know before my meeting with Alice tomorrow?

A conventional personal knowledge system may return a person page, two meeting notes, a company page, and a daily note. These may all be relevant, but I still have to read and combine them myself.

VoltMind is designed to return the answer instead.

It can explain who Alice is, what she is working on, when we last spoke, which commitments remain open, and which relationships or projects are relevant to tomorrow's conversation.

It also adds an important final section: what the brain does not know.

For example, it may say that there has been no new information about Alice or her company for six weeks, or that a claim appears in one page but has no supporting citation, or that two notes disagree about the current status of a project.

Every claim should remain traceable to its source page.

That is the central product distinction: **search is an intermediate operation; the answer is the product.**

---

## Slide 3 — Thin Client–Host Server architecture

![VoltMind Thin Client–Host Server Architecture](images/voltmind-thin-client-host-architecture.png)

### Full speaking script

This diagram shows the recommended thin client–Host architecture.

Starting on the left, the thin client contains the AI agent, the VoltMind CLI, OAuth credentials, and optional mappings for workstation-local file roots.

The most important point is that the thin client does not have its own local brain database. It does not run a parallel copy of the index, and it does not perform local embedding, graph extraction, or background maintenance.

Instead, the client communicates with the VoltMind Host over HTTPS using MCP and OAuth 2.1.

Access is constrained by explicit scopes such as `read`, `write`, and `admin`. A client can also be bound to one source for writes while being allowed to read from a specific federated set of sources.

On the Host, the HTTP MCP server routes every request through a shared operation contract. That contract is the same foundation used by the CLI and the MCP surface, which reduces the risk of behavioral drift between local and remote access paths.

Behind that contract, the Host provides hybrid retrieval, knowledge-graph traversal, synthesis and gap analysis, ingestion and synchronization, Autopilot maintenance, and the Minions durable job system.

At the bottom of the diagram is the data model.

The brain repository, stored as Markdown with frontmatter, is the system of record. Postgres or PGLite is the derived search and execution index. If the derived database is damaged, the user knowledge can be rebuilt from the Markdown repository.

This architecture creates four important benefits.

First, it gives us one shared source of truth. Multiple clients and multiple agents can use the same brain without creating separate, conflicting indexes.

Second, it centralizes expensive or operationally complex work. Embedding, reranking, graph extraction, synchronization, and background jobs run on the Host. The normal thin client does not require Docker, PostgreSQL, or Python.

Third, it gives us a clear least-privilege boundary. OAuth scopes, source scopes, remote trust rules, and `localOnly` operations constrain what a remote agent can do.

Fourth, it protects workstation-local file information. A drive letter or user-specific UNC path can remain on the client. The Host stores only a canonical file locator, and each client reconstructs its own local open path.

The architecture can therefore be summarized in one sentence:

> The thin client keeps interaction local, while the Host centralizes knowledge, compute, and policy.

---

## Slide 4 — The compounding intelligence loop

![VoltMind Capability Loop](images/voltmind-capability-loop.png)

### Full speaking script

This diagram shows how VoltMind turns individual interactions into a compounding knowledge loop.

The first stage is **Capture**.

VoltMind can receive signals from messages, meetings, files, links, webhooks, voice workflows, email and calendar integrations, or direct CLI capture.

The second stage is **Retrieve**.

Retrieval combines vector similarity, BM25 keyword matching, reciprocal-rank fusion, source-aware ranking, graph signals, and optional reranking. This is important because no single retrieval strategy works for every question.

The third stage is **Synthesize**.

VoltMind can combine evidence from several pages into a cited answer. It can also identify stale information, contradictions, missing citations, and gaps in the available evidence.

The fourth stage is **Structure**.

Schema packs define which page types exist, which types can be used for expert routing or fact extraction, and which typed links are meaningful. Timelines preserve how facts, decisions, and relationships change over time.

The fifth stage is **Act**.

Knowledge can produce concrete actions, reports, or durable background jobs. The Minions queue gives long-running work persistent state, progress reporting, retries, checkpoints, and recovery instead of treating sub-agent work as a fire-and-forget promise.

The sixth stage is **Improve**.

Autopilot continuously synchronizes, extracts, embeds, enriches, consolidates, checks contradictions, and evaluates brain quality. This allows the brain to improve even when the user is not actively querying it.

Under the loop are five trust foundations:

- Markdown as the system of record;
- Brain and Source as explicit routing dimensions;
- OAuth scopes and a fail-closed trust boundary;
- interchangeable PGLite and Postgres engines;
- and Skills plus Resolver-based workflow routing.

The outcome is simple: **every useful interaction should make the next answer better.**

---

## Slide 5 — Why the retrieval stack is different

### Suggested slide title

**Vector search alone is not enough**

### Full speaking script

VoltMind uses a layered retrieval pipeline rather than relying on a single embedding score.

The pipeline begins with deterministic intent classification. Depending on the active search mode, it may then perform query expansion.

The query enters a hybrid retrieval stage with vector search and BM25 keyword search. Their rankings are merged using reciprocal-rank fusion, or RRF.

Source-aware signals and graph signals then adjust the ranking. A cross-encoder reranker can jointly read the query and each candidate to correct cases where the initial retrieval signals agree on a semantically related but topically incorrect page.

Finally, the system enforces a token budget and deduplicates multiple chunks from the same page.

Each component solves a different problem.

Vector search is effective for semantic similarity and paraphrases.

BM25 is effective for exact names, phrases, code identifiers, and terms that should not be blurred into thematic neighbors.

RRF lets multiple retrieval strategies vote without depending on one globally calibrated score.

The knowledge graph follows factual relationships such as `works_at`, `invested_in`, `founded`, `advises`, and `attended`. This is how the system can answer relationship questions that vector similarity alone cannot solve.

The project's BrainBench results reported in the README show a P@5 of 49.1 percent and an R@5 of 97.9 percent on a 240-page synthetic rich-prose corpus. The full stack improved P@5 by roughly 31 percentage points over the graph-disabled variant.

I would present these numbers carefully. They are evidence from the project's own benchmark and synthetic corpus, not a guarantee that every production dataset will produce the same result. The important architectural conclusion is that typed graph structure contributes materially rather than acting as a cosmetic add-on.

---

## Slide 6 — Thin harness, fat skills, and two Resolvers

### Suggested slide title

**Deterministic execution below; adaptable judgment above**

### Full speaking script

VoltMind separates deterministic runtime behavior from agent judgment.

The deterministic layer owns operations that must be reliable and repeatable: database reads, access checks, synchronization, indexing, graph traversal, counts, job status, and file-path confinement.

The skill layer owns workflows that require judgment and adaptation: meeting ingestion, entity enrichment, research, daily preparation, idea capture, clarification, correction, reporting, and skill improvement.

The skills are Markdown procedures. They describe how the agent should execute a workflow, which checks it must perform, when it should ask a question, and what evidence it must preserve.

The Resolver is a routing table that selects the correct skill based on user intent. This prevents the agent from loading every operating procedure into every prompt. It loads only the context required for the current task.

There are two different Resolvers in this repository, and the distinction is important.

`skills/RESOLVER.md` is the workflow router. It answers: **Which skill should handle this request?**

`brain/RESOLVER.md` is the filing authority. It answers: **Where should the knowledge produced by that workflow be stored?**

The first Resolver selects behavior. The second Resolver preserves information architecture.

This is a practical implementation of the “thin harness, fat skills” principle: intelligence and judgment live in focused, dynamically loaded skills, while deterministic execution remains in testable code.

---

## Slide 7 — Three real application examples

### Example A: Meeting preparation

#### User trigger

> I am meeting Alice tomorrow. Tell me what I need to know.

#### Full speaking script

The workflow Resolver routes this request into brain-first query and meeting-preparation behavior.

VoltMind first searches the relevant person, meeting, project, commitment, and action pages. It can then traverse graph relationships to find connected companies, projects, previous meetings, and outstanding commitments.

The synthesis layer returns a concise briefing with citations and explicitly warns about stale or missing information.

The business value is that a twenty-minute manual review becomes a short, actionable briefing while preserving traceability.

### Example B: Ingesting a meeting and producing follow-up actions

#### User trigger

> Put these meeting notes into the brain and organize the follow-up actions.

#### Full speaking script

The workflow Resolver selects the meeting-ingestion skill.

The raw evidence is preserved under `sources/`. A structured analysis belongs under `meetings/`. New information about participants and companies updates the relevant entity pages. A bounded body of work may produce a `projects/` page, while a report or proposal belongs under `artifacts/`.

Concrete executable follow-ups are represented separately under `state/actions/`.

Every durable fact requires a citation, and entity references create links or backlinks so the meeting does not become an isolated document.

The result is not simply one saved transcript. The same evidence becomes a traceable source, a meeting summary, entity updates, relationships, and executable actions.

### Example C: Capturing an idea and promoting it into a project

#### User trigger

> Remember this idea: we could use customer-support conversations to generate a product-requirements map.

#### Full speaking script

At first, this is a possibility without an owner, milestone, execution scope, or completion condition. According to the brain filing Resolver, its primary home is `ideas/`.

If the user later assigns an owner, defines the goal, creates milestones, and establishes an end condition, it becomes a bounded work unit and should have a page under `projects/`.

Its concrete report or design document belongs under `artifacts/`. Its smallest executable steps belong under `state/actions/`. If it becomes an ongoing responsibility with no defined end state, it belongs under `workstreams/` instead.

This illustrates an important property of the system: the knowledge structure can evolve as the work matures, without collapsing ideas, projects, deliverables, and actions into one generic note type.

---

## Resolver trigger examples

| User request | Workflow route | Filing route | Expected result |
|---|---|---|---|
| “What do we know about X?” | `query` | Read-only | Keyword search first, followed by hybrid query or direct page retrieval as needed; return a cited answer. |
| “What is the relationship between A and B?” | `query` plus graph query | Read-only | Traverse typed edges and return the relationship path. |
| “Save this idea.” | `capture` or `idea-ingest` | `ideas/` or `originals/` | Preserve the user's wording, citations, entity links, and backlinks. |
| “Process these meeting notes.” | `meeting-ingestion` | `sources/`, `meetings/`, and entity pages | Separate raw evidence from analysis and durable entity updates. |
| “Turn this into a tracked project.” | `project` | `projects/`, or `workstreams/` when there is no end condition | Establish goals, ownership, milestones, source bindings, and status. |
| “What matters today?” | `briefing` | Normally read-only; a saved deliverable goes to `artifacts/` | Aggregate meetings, actions, commitments, and risks. |
| “This action is complete.” | `daily-task-manager` or `schedule-actions` | `state/actions/` | Update the authoritative local Markdown action lifecycle. |
| “That is not what I said. Correct it.” | `correction-pipeline` | Repair the canonical page and evidence chain | Prevent the incorrect claim from continuing to propagate. |
| “Audit these citations and facts.” | `citation-fixer` or `fact-check` | Repair the corresponding canonical pages | Keep durable claims traceable to evidence. |
| “Which team does this person belong to, and which projects are connected?” | `query` or `find_experts` | Read-only | Combine person, organization, project, and typed-link evidence. |

---

---

## Important architectural decisions

### Markdown is the system of record

User knowledge is stored as human-readable Markdown with frontmatter. The database is a derived index.

This gives the user ownership, Git history, readable diffs, portability, and a clear disaster-recovery path. If the index is lost, the knowledge can be synchronized and extracted again from the repository.

There are deliberate DB-only exceptions, including OAuth credentials, request logs, runtime locks, caches, and job-queue state. These are infrastructure state rather than user-authored knowledge.

### Brain and Source are orthogonal dimensions

A **Brain** selects the database. It normally represents a data-ownership and access-policy boundary.

A **Source** selects a content repository inside that database. It normally represents a repo or topic boundary under the same owner.

The simplest rule is:

> If the data owner changes, switch Brain. If the owner remains the same but the repository changes, switch Source.

Cross-brain federation is intentionally agent-driven rather than hidden behind one database query. The agent explicitly queries relevant brains, synthesizes the findings, and cites `brain:source:slug`. This makes access and debugging easier to audit.

### Contract-first, with two database engines

`src/core/operations.ts` is the single operation contract used to generate the CLI and MCP behavior. The current checkout statically lists 126 operations across page management, retrieval, links, timelines, files, jobs, actions, facts, takes, schemas, and diagnostics.

The `BrainEngine` contract is implemented by both PGLite and Postgres.

PGLite provides a zero-configuration embedded Postgres-compatible engine for local and personal use. The README positions it for brains of approximately 50,000 pages or fewer.

Postgres with pgvector supports shared, larger, multi-machine, and Host deployments.

The project treats engine parity as a load-bearing invariant: new database behavior should be implemented and tested for both engines.

### Remote callers are untrusted by default

The local CLI explicitly identifies trusted local calls. MCP and HTTP calls are treated as remote and untrusted.

Security-sensitive checks use fail-closed semantics: anything not explicitly local is treated as remote. Source isolation is applied through shared scoping helpers rather than being reimplemented in each operation. Operations marked `localOnly` are not exposed through the HTTP MCP surface.

This is an important architectural quality: authorization is part of the operation model, not a thin wrapper added after the feature is implemented.

---

## Likely leader questions and suggested answers

### “Is this just another RAG system?”

RAG is one component of the system, but it is not the complete product.

VoltMind adds typed graph relationships, timelines, schemas, citations, synthesis, knowledge-gap analysis, continuous ingestion, background maintenance, and an action and job runtime.

RAG answers, “Where is the related text?” VoltMind is designed to answer, “What should the agent know, what should it trust, and what should happen next?”

### “Why not use the database as the only system of record?”

User knowledge benefits from being readable, versioned, auditable, and portable. Markdown and Git are a strong durable truth layer. The database is better suited to embeddings, indexes, caches, graphs, and runtime state.

This division reduces lock-in and makes disaster recovery much simpler.

### “Why is the thin-client architecture important?”

It allows multiple devices and multiple agent platforms to share one governed brain while centralizing the database, embedding, background jobs, and access policy on the Host.

The client remains lightweight, and knowledge or policy does not fork across machines.

### “How do we prevent data leakage across users or sources?”

The Brain is the database boundary, while Source is the repository boundary inside a brain. OAuth clients can be bound to one write source and a specific federated-read set.

Remote operations do not inherit the Host process's local dotfile or environment routing. They use the authorization context attached to the caller. Sensitive checks fail closed, and local-only operations are excluded from HTTP exposure.

### “What happens when the stored knowledge is wrong?”

Durable claims require source attribution. Facts, takes, timelines, and relationships remain traceable to Markdown evidence.

The system includes correction, citation repair, fact checking, contradiction detection, page versions, reversion, and explicit forget workflows. Gap analysis also warns when evidence is stale, missing, or contradictory.

### “How should we measure success?”

At the retrieval level, we can measure precision, recall, MRR, and nDCG.

At the workflow level, more useful metrics include meeting-preparation time, repeated-question frequency, missed-action rate, knowledge freshness, citation coverage, and successful retrieval of named entities.

At the engineering level, the project supports LongMemEval, captured-query replay, NamedThingBench, engine-parity tests, trust-boundary tests, and operation-contract tests.

### “What are the biggest risks?”

The first risk is input quality. Incorrect ingestion can compound, so citations, correction workflows, and review gates are essential.

The second risk is graph and schema coverage. Fresh pages may initially be sparse, and relationship quality depends on extraction and taxonomy quality.

The third risk is LLM cost and uncertainty in synthesis. Search modes, caching, token budgets, reranking and expansion controls, and explicit gap analysis are the main controls.

The fourth risk is skill growth. As the number of workflows increases, routing overlap can become a maintenance problem. Resolver checks, reachability tests, skill evaluation, and disciplined context loading are therefore part of the platform rather than optional documentation work.

---

## Complete 45-second closing statement

> VoltMind is not primarily about putting more documents into a vector database. It is about giving AI agents a persistent, structured, and traceable cognitive foundation. Markdown provides ownership and recoverability. PGLite or Postgres provides efficient indexing and retrieval. Graphs and schemas represent relationships and domain structure. Synthesis turns evidence into cited answers. Skills, Resolvers, Autopilot, and Minions turn knowledge into continuously running workflows. The thin client–Host architecture allows this capability to serve multiple agents and devices under one security and data-governance model. The ultimate goal is simple: every interaction should make the next answer better.

---

## Four messages to leave with the audience

1. **From retrieval to answers:** cited synthesis and gap analysis are the product-level differentiators.
2. **From documents to relationships:** typed graphs and schemas connect people, companies, projects, meetings, and commitments.
3. **From one-time use to compounding intelligence:** capture, write, auto-link, synchronize, and Autopilot form a continuous improvement loop.
4. **From a local tool to trusted infrastructure:** thin clients, a centralized Host, OAuth and source scopes, a shared operation contract, and a recoverable system of record support multi-agent and team usage.

## Primary source files

- `README.md` — product positioning, user scenarios, capabilities, and installation paths.
- `AGENTS.md` and `CLAUDE.md` — operating protocol, architectural invariants, trust boundaries, and task routing.
- `docs/architecture/thin-client.md` and `docs/architecture/topologies.md` — thin client–Host deployment model.
- `docs/architecture/system-of-record.md` — Markdown-canonical and database-derived contract.
- `docs/architecture/RETRIEVAL.md` — hybrid and graph retrieval design and benchmark claims.
- `docs/architecture/brains-and-sources.md` — Brain and Source routing model.
- `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` — thin harness, fat skills, and Resolver philosophy.
- `skills/RESOLVER.md` — agent workflow triggers.
- `brain/RESOLVER.md` — page and state-object filing rules.
- `src/core/operations.ts` and `src/core/engine.ts` — contract-first operations and dual-engine interface.
- `package.json` — current version, runtime requirements, and verification commands.

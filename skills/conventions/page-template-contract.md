# Page Template Contract

`docs/drafts/voltmind-company-core-page-templates.draft.md` is the single
source of truth for Personal Brain core semantic-page write format. It defines
the frontmatter fields, enum values, required body headings, and timeline
marker for 19 core types:
`person`, `org`, `company`, `workstream`, `project`, `meeting`, `artifact`,
`concept`, `idea`, `daily`, `policy`, `source`, `contribution_candidate`,
`private`, `inbox`, `decision`, `commitment`, `action`, and `risk`.

This is not a universal template registry for every schema pack. The
`voltmind-personal-brain` pack currently declares 30 types; the remaining 11
are specialized source, lifecycle, index, archive, or fallback types:
`index`, `contribution_published`, `contribution_rejected`,
`contribution_redacted`, `contribution_review`, `source_teams`,
`source_meeting`, `source_email`, `source_calendar`, `archive`, and
`unclassified`. Other bundled domain packs also declare types outside this
document. Do not claim full-pack template coverage from this contract.

The Markdown files under a vault's `brain/templates/` directory are user-facing
reference material. They are not the runtime write contract and must not be
used as a competing schema source.

## Runtime enforcement

Client-first semantic writes have two ordered gates:

1. The local thin-client writer validates the page against the canonical draft
   before touching the local vault, then atomically persists the exact Markdown.
2. Only after that local write succeeds does it forward the same slug and bytes
   to remote MCP `put_page`, which validates again before calling the importer.

Use `voltmind put <slug> < page.md` on the client for this path. Calling the
Host's remote MCP `put_page` directly invokes only the second gate and is not a
client-first write-through operation.

The contract modes are:

- `strict` rejects the write with `template_contract_violation`.
- `warn` writes the page and returns `template_validation` findings.
- `off` disables this contract gate.

Remote/MCP `put_page` calls default to `strict`, including writes to a database
host that has no local vault checkout. Writes also
default to `strict` when `sync.repo_path` points at a local vault. This keeps
resolver, Brain-First Lookup, and client-first ingest from creating ad-hoc
entity formats. Trusted local DB-only maintenance remains `off` by default;
set `writer.template_contract=strict` to opt it in. Set
`writer.template_contract=warn` or `off` only for an intentional migration or
repair workflow.

Template H2 headings remain exactly as authored in the canonical draft
(`## Open Threads`, `## Current Work`, `## Timeline`, and so on). Body prose,
bullet explanations, and timeline summaries are written in Chinese. Timeline
entries use the same format as the runtime scaffold:
`- **YYYY-MM-DD** | 中文摘要 [Source: ...]`.

If the canonical draft cannot be found during any strict write, the operation
fails closed with `template_contract_unavailable`. Packaged runtimes can
provide its absolute path through `VOLTMIND_PAGE_TEMPLATE_DRAFT`.

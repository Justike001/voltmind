# Page Template Contract

`docs/drafts/voltmind-company-core-page-templates.draft.md` is the single
source of truth for Personal Brain entity-page write format. It defines the
frontmatter fields, enum values, required body headings, and timeline marker
for every page type in the Personal Brain schema.

The Markdown files under a vault's `brain/templates/` directory are user-facing
reference material. They are not the runtime write contract and must not be
used as a competing schema source.

## Runtime enforcement

The `put_page` operation validates a page against the canonical draft before
calling the importer:

- `strict` rejects the write with `template_contract_violation`.
- `warn` writes the page and returns `template_validation` findings.
- `off` disables this contract gate.

When `sync.repo_path` points at a local vault, the default is `strict`, so
resolver, Brain-First Lookup, and ingest writes that use `put_page` cannot
create another ad-hoc entity format. Database-only callers remain `off` by
default for compatibility; set `writer.template_contract=strict` to enforce
the contract there too. Set `writer.template_contract=warn` or `off` only for
an intentional migration or repair workflow.

If the canonical draft cannot be found in a strict local-vault write, the
operation fails closed with `template_contract_unavailable`. Packaged runtimes
can provide its absolute path through `VOLTMIND_PAGE_TEMPLATE_DRAFT`.

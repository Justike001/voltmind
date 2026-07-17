# Schema Packs

A schema pack is VoltMind's runtime contract for a brain's directory layout.
It defines page types, path-to-type inference, filing rules, link semantics,
and enrichment eligibility. Runtime code must consult the active pack; it must
not recreate a second directory map in TypeScript.

## Default personal brain

`voltmind init` creates the canonical local-first personal-brain scaffold and
activates `voltmind-personal-brain` unless the user already selected a pack.

The pack mirrors `src/core/personal-brain-scaffold.ts` and the README files in
an initialized vault:

- Primary homes: `inbox/`, `daily/`, `people/`, `orgs/`, `companies/`,
  `workstreams/`, `projects/`, `meetings/`, `artifacts/`, `concepts/`,
  `ideas/`, `policy/`, `sources/`, `private/`, and `archive/`. Raw Teams,
  meeting, email, and calendar evidence uses `sources/teams/`,
  `sources/meetings/`, `sources/emails/`, and `sources/calendar/`.
- Derived state: `state/decisions/`, `state/commitments/`,
  `state/actions/`, `state/risks/`, and `state/indexes/`.
- Contribution records: `contribution/candidates/`, `published/`,
  `rejected/`, `redacted/`, and `reviews/`.

The policy directory is singular: `policy/`. `.system/` is machine-owned and
README files are not knowledge pages.

`voltmind-base` remains available only as an explicit compatibility pack for
older wiki/deals/media layouts. It is not the default for new brains.

## Active-pack resolution

First match wins:

1. CLI-only per-call schema-pack option.
2. `VOLTMIND_SCHEMA_PACK`.
3. Per-source database setting.
4. Brain-wide database setting.
5. `voltmind.yml`.
6. `~/.voltmind/config.json`.
7. `voltmind-personal-brain`.

Inspect or change the current selection with:

```bash
voltmind schema active
voltmind schema list
voltmind schema validate
voltmind schema use voltmind-personal-brain
```

New custom packs created with `voltmind schema init <name>` extend
`voltmind-personal-brain` by default.

## Runtime rules

- `parseMarkdown` uses only `page_types[].path_prefixes` from the active pack.
  An unmatched path is `unclassified`; it is never silently treated as a
  concept or person.
- Prefixes are repository-relative. `people/alice.md` matches `people/`, while
  `archive/people/alice.md` does not.
- Explicit frontmatter `type` still wins over inferred type.
- Pack inheritance is merged parent-first, child-wins. Child page types are
  considered before inherited types, and child filing rules replace rules with
  the same semantic kind.
- Durable enrichment writes resolve `person` and `company` directories through
  the active pack's `filing_rules`. A missing rule or invalid slug skips the
  write instead of guessing a path.
- Bare-name entity resolution uses those same person/company filing rules only
  to find existing canonical pages. It never creates a page or decides that a
  phrase is a person.

## Migration guidance

Existing brains keep their configured pack. To move an old repository to the
personal layout, first add or relocate Markdown files, then select the new
pack and import or sync explicitly:

```bash
voltmind schema use voltmind-personal-brain
voltmind import ./brain --no-embed
voltmind sync --no-pull --no-embed
```

Review unmatched paths as `unclassified` rather than relying on automatic
directory guessing. This makes a schema gap visible and keeps filing decisions
auditable.

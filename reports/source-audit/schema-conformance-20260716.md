# Supabase schema conformance audit

- Checked at: 2026-07-16
- Source: `default`
- Active pack: `voltmind-personal-brain@1.0.0`
- Database rows: 798 total; 85 active; 713 soft-deleted

## Summary

| Category | Count |
|---|---:|
| Structural/template/rules pages accepted as exceptions | 34 |
| Pages whose path and type match the active pack | 41 |
| Pages that do not match the active pack | 10 |

The source audit itself is clean: all 85 active pages correspond to the current
source or its structural documents. The policy rows were retyped to `policy`
with canonical source paths. The empty `orgs/team-slug` placeholder was
soft-deleted. `contribution/rules` is intentionally retained as a rules
document and is not treated as noise.

## Mismatches

### Conversation rows (10)

The active pack declares no `conversation` type and no `conversations/` filing
prefix. There are ten conversation rows: five duplicate root slugs and five
correctly prefixed `conversations/teams/...` rows. These remain the only schema
mismatches in the active database and were not changed in this pass.

- Five duplicate root slugs without `conversations/`: the five current Teams
  transcript names.
- Five correctly prefixed `conversations/teams/...` slugs with `type=conversation`.

### Resolved rows

- The seven `policy/*` pages now have `type=policy`, canonical `source_path`,
  and frontmatter type metadata.
- `orgs/team-slug` was an empty placeholder and is now soft-deleted.
- `contribution/rules` remains active by design as a rules document.

## People check

No malformed active `people/*` entity pages remain. The active person rows are
the current named people; `people/readme` is a structural document and
`templates/people` is a template, not a person entity.

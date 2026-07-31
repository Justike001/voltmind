# Workstreams

Long-running responsibility domains.

Use this for:
- Strategic areas
- Durable operating areas
- Ongoing product or system directions
- Areas containing many projects over time

Examples:
- Enterprise connectors
- Company brain
- Security / DLP
- XR product direction
- Manufacturing systems
- Personal productivity

Tiebreaker:
- `workstreams/` has no fixed end date.
- `projects/` has a goal, owner, scope, status, and completion condition.

Long-running tracking:
- Declare source identities in page Frontmatter with `tracking_bindings`.
- Use `tracking_aliases` only as review-time hints when a source has no stable ID.
- A bound source may update this workstream's Timeline and, for directional,
  priority, portfolio, or cross-project risk changes, its managed current-state block.
- Runtime never creates a workstream from an unbound source; unresolved matches go to
  `state/indexes/project-tracking-review`.

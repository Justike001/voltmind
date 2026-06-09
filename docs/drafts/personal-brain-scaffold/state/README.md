# State

Derived operational state objects.

`state/` is not a primary home. It stores structured execution/status objects extracted from primary pages.

Use state objects for:
- Decisions
- Commitments
- Actions
- Risks
- Generated indexes

Rules:
- Keep background context in primary pages.
- State objects must link back with `source_refs`.
- State objects should be small, structured, and executable/queryable.


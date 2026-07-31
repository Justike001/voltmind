# Projects

Bounded work units with explicit goals and ownership.

Use this for work that has:
- Goal
- Owner
- Scope
- Status
- Milestones or deadline
- Related people/companies/systems
- Decisions, commitments, risks, and actions

Page purpose:
- Current project state
- Open questions
- Links to state objects
- Meetings, sources, tickets, and docs

Long-running tracking:
- Maintain connector identities in Frontmatter `tracking_bindings`; one source may
  bind to multiple projects/workstreams.
- Use `tracking_aliases` for candidate generation only; aliases never authorize a write.
- An exact binding authorizes runtime to append Timeline, refresh the managed current
  state block, and maintain canonical action/decision/commitment/risk pages.
- Unbound or ambiguous evidence is retained and indexed for review; it never creates a
  new project automatically.

Tiebreakers:
- If no one is working on it yet, use `ideas/`.
- If it is a concrete task, use `state/actions/`.
- If it is a deliverable, use `artifacts/`.

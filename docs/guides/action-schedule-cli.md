# Local action scheduling CLI

The canonical CLI contract now lives in
[`skills/schedule-actions/SKILL.md`](../../skills/schedule-actions/SKILL.md),
under **Tool Use** and **Phases**. These sections contain the commands, tool-use
mapping, decision JSON schema, four decision outcomes, concurrency safeguards,
and Desktop automation handoff. Use `next` and `decide --next` for agent-driven
triage, or `review` for direct terminal choices without a model round trip.

This file remains as a stable documentation link for existing references; keep
the skill as the source of truth when the CLI changes.

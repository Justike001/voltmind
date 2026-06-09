# Source Of Truth Map

Defines which system wins for each class of state.

Examples:
- Customer account state -> CRM
- Support work -> ticket system
- Project narrative -> Personal/Team Brain project page
- Meeting evidence -> `sources/` or meeting transcript source
- Action execution event -> `.system/task-registry.jsonl`
- Automation state -> `.system/automation-registry.jsonl`

Rules:
- Do not overwrite source-of-truth systems without policy permission.
- Writeback targets must be explicit for automated actions.
- If systems conflict, record the conflict as a risk or decision candidate.


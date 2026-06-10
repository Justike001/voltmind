# Retention Policy

Defines how long records should remain active.

Defaults:
- Inbox items should be resolved quickly.
- Daily pages remain private and retained unless user archives them.
- State objects can be archived when closed, obsolete, or superseded.
- Source records should preserve evidence pointers as long as linked state objects depend on them.
- Contribution review records should be retained for audit.

Rules:
- Do not delete evidence required by published Company Brain state.
- Archive before delete unless policy explicitly allows deletion.


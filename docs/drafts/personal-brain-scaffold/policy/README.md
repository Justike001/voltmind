# Policy

Phase 0 governance protocol and policy runtime inputs.

This layer is not a user product surface. It defines the rules every later automation, publish flow, shared brain sync, approval flow, and action runtime must obey.

Page frontmatter uses the singular `publish_level` field. The allowed values live in `.system/policy-config.json` as `publish_levels`.

Use this for:
- What is always private
- What can become a publish candidate
- What can enter Team Brain
- What can enter Company Brain
- Which actions can run automatically
- Which actions require confirmation or approval
- Which sources count as evidence
- Which systems are source of truth
- How long records are retained

Files:
- `privacy-policy.md`
- `publish-contract.md`
- `sensitivity-taxonomy.md`
- `source-of-truth-map.md`
- `role-scope-map.md`
- `action-risk-policy.md`
- `retention-policy.md`

# Publish Contract

Defines how Personal Brain content can move toward Team Brain or Company Brain.

Publish levels:
- `never` - never publish or propose.
- `candidate` - can become a candidate for user review.
- `user_approved` - user approved publication.
- `team_reviewed` - reviewed for Team Brain.
- `company_state` - accepted as Company Brain state.

Pages store the current value in `publish_level`. Policy tooling stores the enum in `.system/policy-config.json` under `publish_levels`.

Rules:
- A page with `publish_level: never` must not create a contribution candidate.
- A page with `publish_level: candidate` still requires review before publishing.
- Company Brain publication requires evidence, owner, scope, sensitivity, and writeback target.
- Meeting-derived contributions should go through `contribution/candidates/`.

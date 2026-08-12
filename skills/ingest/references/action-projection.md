# Action Projection and Assignee Coverage

Read this reference for every action candidate or `state/actions/*` write.

## Structured intermediate

Preserve assignees before generating prose:

```yaml
action_slug: state/actions/example-action
assignees:
  - slug: people/alice-example
    display_name: Alice Example
    source_text: Alice Example
```

Use connector mention nodes when available. If rendered Teams text concatenates
adjacent mentions, resolve known entity aliases by their positions in the raw
assignment clause. Do not parse assignees from the later summary.

Keep `owner` for the accountable owner when confirmed. Put all confirmed
participants/assignees in `related_people`; a multi-assignee action must not be
collapsed into `owner: unknown` with anonymous prose.

## Required write surfaces

For every structured assignee:

1. The action frontmatter contains the slug in `owner` or `related_people`.
2. The action body contains an explicit `[[people/slug|Display Name]]` link.
3. The person page exists.
4. The person page links back to the action.
5. The source citation supporting assignment appears on the action and person
   context/timeline as applicable.

Pass `action_assignments` to `register_tracking_evidence` for every affected
action. Omission or any missing surface forces `client_outcome: review_needed`
and `semantic_status: review_required`. Re-submit the same event revision after
repair; only a clean deterministic validation may become complete.

## Scheduling boundary

After all action pages are durable, invoke `skills/schedule-actions/SKILL.md` in
interview mode with exact local paths and slugs. Scheduling reads the canonical
action and its raw evidence. Extraction alone is never execution consent.

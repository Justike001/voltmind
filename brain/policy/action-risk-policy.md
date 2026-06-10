# Action Risk Policy

Defines what actions can run automatically and what requires confirmation or approval.

Action risk levels:
- `low`
- `medium`
- `high`
- `restricted`

Defaults:
- `low` may run automatically when `automation.eligible: true`.
- `medium` requires user confirmation.
- `high` requires explicit approval.
- `restricted` must not run automatically.

Examples:
- Low: organize local markdown, archive inbox, create summaries, update personal action status.
- Medium: create email drafts, update shared project draft, create ticket draft.
- High: send email, create customer ticket, update CRM, modify Team Brain.
- Restricted: delete data, modify ERP/MES, send customer commitments, bypass DLP, process sensitive personal data.


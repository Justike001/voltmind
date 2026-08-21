### Client-vault taxonomy preflight (MANDATORY for client-first semantic writes)

This reference applies when ingest is running on a thin client with a configured
`client_vault_path` and the run will create or route a local semantic page. It
clarifies the difference between the agent skill resolver and the vault's own
filing policy:

- `skills/RESOLVER.md` routes the agent request to the `ingest` skill. It is not
  a vault filing rule and must not be used as a substitute for the vault files.
- The vault's root `RESOLVER.md` describes local filing and placement policy.
- The vault's `index.md` and `schema.md` describe the local layout and field
  contract.
- Directory `README.md` files explain the intended meaning of each local home.
- `voltmind schema show --json` (through `brain-taxonomist`) is still the
  machine-readable authority for page type, path prefixes, aliases, and pack
  behavior. Local prose may constrain or clarify a route, but may not silently
  override an active-pack path.

Before a new semantic route is selected, resolve the vault root from the local
client configuration/environment and read, when present:

1. Root: `index.md`, `RESOLVER.md`, `schema.md`, and `README.md`.
2. Every directory `README.md` whose directory is declared by an active-pack
   `path_prefixes` entry. This includes the current personal-brain homes:
   `inbox/`, `daily/`, `people/`, `orgs/`, `companies/`, `workstreams/`,
   `projects/`, `meetings/`, `artifacts/`, `concepts/`, `ideas/`, `policy/`,
   `sources/`, `private/`, `archive/`, `state/`, and `contribution/`.
3. Nested declared directories, including:
   `state/decisions/`, `state/commitments/`, `state/actions/`,
   `state/risks/`, `state/indexes/`, `contribution/candidates/`,
   `contribution/published/`, `contribution/rejected/`,
   `contribution/redacted/`, `contribution/reviews/`, `sources/teams/`,
   `sources/meetings/`, `sources/emails/`, and `sources/calendar/`.

Use the documents in this order:

1. Active schema pack: determine the candidate type and canonical prefix.
2. Vault `RESOLVER.md` and `schema.md`: apply local placement and field
   constraints that are compatible with that pack.
3. Root index and relevant directory README files: resolve local terminology,
   subdirectory intent, and naming conventions.

If the pack and vault documents disagree about the canonical destination, do
not guess or hardcode a folder. Preserve the evidence locally and route the
conflict to clarification review. A missing README or optional root document is
not an error; continue with the active pack and record the missing local
context only when it affects the route. Do not recursively read arbitrary page
content merely to discover taxonomy.

After the route is selected, write the exact Markdown through local
`voltmind put <slug> < page.md`. The local vault write must succeed before the
remote `put_page` synchronization is attempted.

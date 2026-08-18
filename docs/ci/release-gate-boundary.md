# VoltMind release-gate — CI setup (the REAL, running gate)

> The actual release gate in this repo is **`.github/workflows/test.yml`** — the
> `tier2-host-mcp`, `heavy`, and `test-status` jobs against the live Host's
> authenticated, **read-only** MCP surface. It uses the harness's native
> thin-client OAuth path, driven by the `VOLTMIND_REMOTE_*` vars/secrets.
>
> A standalone tailnet-based `release-gate.yml` was drafted earlier and then
> **removed as redundant** — it duplicated what `test.yml` already does with a
> different secret namespace. Do not reintroduce a parallel gate; extend this
> one instead.

## 0. Three CI security domains

- **Client CI** runs on pull requests, including fork pull requests. It runs
  `bun run verify`, `bun run test:e2e:tier1`, CLI/Admin builds, and the PGLite
  source-isolation contract. `DATABASE_URL`, `VOLTMIND_DATABASE_URL`, and
  `VOLTMIND_RESTRICTED_DATABASE_URL` are asserted to be absent.
- **Host MCP black-box CI** keeps only the two remote URLs and the OAuth client
  ID/secret. It authenticates through OAuth and calls the deployed Host through
  MCP; it never receives a database URL.
- **Host Postgres white-box CI** receives only private, disposable test URLs
  from the `host-ci` Environment. It runs the OAuth E2E with the
  migration/test-owner URL, then runs the source-scope E2E with a separate
  `NOBYPASSRLS` URL and asserts `rolbypassrls = false`.

Host jobs use the protected `host-ci` Environment and are enabled only for
trusted master pushes, merge-queue runs, or an explicitly approved manual
dispatch. They never use `pull_request_target`.

---

## 1. The gate, end to end

`scripts/host-mcp-e2e.ts` is the probe (`bun run test:e2e:tier2` / `test:heavy:host`).

- `inspectHost()`:
  - `whoami` → transport is `oauth`; `client_id` equals the CI client; **exactly
    one scope: `read`** (a broader client fails the gate on purpose).
  - `get_brain_identity` → engine `postgres`, a version string, valid
    page_count / chunk_count.
  - `schema_stats` → schema_version `1`; per-source array; totals agree with
    identity page_count.
  - `recall { limit:1, include_pending:true }` → facts array, total,
    pending_consolidation_count (proves the Host prepared-statement read path).
- `runHeavy()` → 10 sequential identity/schema iterations (bounded soak, not a load test).
- `test-status` (in `test.yml`) aggregates **every** job and fails the release if any fail.

Boundary: the CI runner is a **thin client — it never opens a PostgreSQL
connection**. Every assertion goes through the Host's read-scope MCP surface.

---

## 2. Secrets / Variables to configure on GitHub

Repository → **Settings → Environments → `host-ci`**. Keep the credentials
environment-scoped; do not put them in repository-wide secrets, files, logs, or
artifacts.

| Name | Kind | Example value |
|---|---|---|
| `VOLTMIND_REMOTE_ISSUER_URL` | **host-ci variable** | Host issuer URL |
| `VOLTMIND_REMOTE_MCP_URL` | **host-ci variable** | Host `/mcp` URL |
| `VOLTMIND_REMOTE_CLIENT_ID` | **host-ci secret** | read-only OAuth client ID |
| `VOLTMIND_REMOTE_CLIENT_SECRET` | **host-ci secret** | read-only OAuth client secret |
| `VOLTMIND_CI_DATABASE_URL` | **host-ci secret** | disposable database URL using the migration/test owner |
| `VOLTMIND_CI_RESTRICTED_DATABASE_URL` | **host-ci secret** | disposable database URL using `rolbypassrls=false` |

`tier2`/`heavy` read the URLs from `vars.VOLTMIND_REMOTE_*` and both OAuth
credentials from `secrets.VOLTMIND_REMOTE_*` (see `test.yml`). The issuer
URL must serve `/.well-known/oauth-authorization-server` and the MCP URL the
`/mcp` tools endpoint.

The Postgres job does not connect to the deployed Host. The two URLs must point
to an isolated, disposable test database and must never point at production.
`VOLTMIND_CI_DATABASE_URL` must use the migration/test owner role; the
restricted URL must use a separate role whose `rolbypassrls` is false. The two
E2E files run sequentially so fixture cleanup cannot race across processes.

---

## 3. VoltMind client requirement (the one this gate needs)

- grant `client_credentials`, auth `client_secret_post`
- scope **exactly `read`** (the gate hard-asserts exactly one `read` scope)
- `source_id = personal-justike-liu`, `federated_read = {personal-justike-liu}`
- optional `budget_usd_per_day` cap (e.g. `1.00`) as hardening

The current **`voltmind-ci-release-gate`** client matches and is the intended one.
`git log`/`voltmind auth list` (post-`auth list` enhancement) will show it.

Verify from the runner side with:

```bash
bun run scripts/host-mcp-e2e.ts   # needs the 4 VOLTMIND_REMOTE_* above
```

---

## 4. Reachability note

The runner must reach both `VOLTMIND_REMOTE_ISSUER_URL` and
`VOLTMIND_REMOTE_MCP_URL`. `test.yml`'s tier2/heavy already pass today, so a
working path exists (public tunnel or otherwise). **If that path ever goes away,
restore reachability before touching the gate's secrets.** The Host runs
`voltmind serve --http --port 3131 --bind 0.0.0.0 --public-url
https://voltage3d.tailce7d39.ts.net --admin-api-only` (`--admin-api-only` only
hides the admin SPA; `/mcp` + OAuth endpoints still serve).

---

## 5. Operation / rotation

- Rotating the Host client: `voltmind auth revoke-client <id>` on the Host, then
  `register-client` a new read-only one, then update
  `VOLTMIND_REMOTE_CLIENT_ID` (secret) + `VOLTMIND_REMOTE_CLIENT_SECRET` (secret).
- Any suspected leak, repo-provenance change, or action compromise ⇒ rotate both.
- Review the Host MCP **reachability** (whether it is public or tunnel-only) as a
  deliberate decision; don't widen it casually.

---

## 6. Residual risks (accepted)

| Risk | Mitigation | Residual |
|---|---|---|
| Client secret exposed via GitHub | read-only client, rotation, private repo | Low |
| Runner compromise reads Host data | read scope only, thin-client (no DB creds) | Low |
| Public MCP path reachable by third parties | read-only scope + budget cap | Low |
| Reachability/tunnel outage blocks release | hard-fail gate | Operational, accepted |

## 6. Security naming check

The release sweep runs `scripts/check-security-product-name.sh` through
`bun run check:all`. It requires `SECURITY.md` to identify the current
VoltMind product and rejects the retired `gbrain` name.

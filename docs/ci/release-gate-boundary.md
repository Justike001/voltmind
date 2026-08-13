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

Repo → **Settings → Secrets and variables → Actions**.

| Name | Kind | Example value |
|---|---|---|
| `VOLTMIND_REMOTE_ISSUER_URL` | **variable** | `https://voltage3d.tailce7d39.ts.net` |
| `VOLTMIND_REMOTE_MCP_URL` | **variable** | `https://voltage3d.tailce7d39.ts.net/mcp` |
| `VOLTMIND_REMOTE_CLIENT_ID` | **variable** | `voltmind_cl_...` (read-only client) |
| `VOLTMIND_REMOTE_CLIENT_SECRET` | **secret** | `voltmind_cs_...` |

> `tier2`/`heavy` read these from `vars.VOLTMIND_REMOTE_*` and
> `secrets.VOLTMIND_REMOTE_CLIENT_SECRET` directly (see `test.yml`). The issuer
> URL must serve `/.well-known/oauth-authorization-server` and the MCP URL the
> `/mcp` tools endpoint.

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
  `VOLTMIND_REMOTE_CLIENT_ID` (var) + `VOLTMIND_REMOTE_CLIENT_SECRET` (secret).
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

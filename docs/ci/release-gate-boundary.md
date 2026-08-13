# VoltMind release-gate — CI boundary & setup guide

> Hand this file to the agent configuring the GitHub CI. It defines the exact
> security boundary, the secrets to create, the tailnet ACL, and the rotation
> discipline. **Do not commit real secret values to the repo.**

---

## 1. What this integration is

A GitHub Actions job connects briefly to the private tailnet as an **ephemeral,
tagged node**, mints a short-lived **`read`-only** OAuth `client_credentials`
token, and makes one read MCP call to VoltMind as a release gate. It has no
write/admin capability and can reach only one service on one port.

---

## 2. Network boundary (the ACL is the linchpin)

| Direction | src (CI node) | dst (VoltMind host) | Allowed |
|---|---|---|---|
| allowed | `tag:ci` | `100.69.5.107:3131` | `accept` |
| **everything else** | `tag:ci` | any | **deny (implicit)** |

Tailscale ACL (`/api/v2/tailnet/<t>/acl` or admin console → Access Controls).
**Do NOT add anything broader.**

```json
{
  "tagOwners": {
    "tag:ci": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:ci"],
      "dst": ["100.69.5.107:3131"]
    }
  ],
  "ssh": []
}
```

- The `dst` IP MUST equal the VoltMind host's tailscale IP (`100.69.5.107`).
- The host runs `voltmind serve --http --port 3131 --bind 0.0.0.0
  --public-url https://voltage3d.tailce7d39.ts.net --admin-api-only`.
  `--admin-api-only` only hides the admin SPA; `/mcp` + OAuth endpoints serve.
- Persist the public base URL: `https://voltage3d.tailce7d39.ts.net`.

---

## 3. Data boundary (VoltMind side)

- Client: **`voltmind-ci-release-gate`**
- Grant: `client_credentials` • Auth: `client_secret_post`
- Scope: **`read`** ONLY — never admin, never write.
- `source_id`: `personal-justike-liu`
- `federated_read`: `{personal-justike-liu}` (reads only this source)
- Access tokens: short-lived (3600s), auto-rotating; no persistent bearer token.

Anything a leaked credential can do is bounded to: **read pages of the
`personal-justike-liu` source over the tailnet for 1 hour.**

---

## 4. Secrets to create in GitHub (Settings → Secrets and variables → Actions)

| Secret name | Value | Notes |
|---|---|---|
| `VOLTMIND_CLIENT_ID` | <from chat> | VoltMind OAuth client id |
| `VOLTMIND_CLIENT_SECRET` | <from chat> | VoltMind OAuth client secret |
| `TS_OAUTH_CLIENT_ID` | <from chat> | Tailscale OAuth client id |
| `TS_OAUTH_SECRET` | <from chat> | Tailscale OAuth client secret |

Repo must be **Private**. Limit repo/org write access.

---

## 5. Workflow file

`release-gate.yml` (sibling template in the repo) — copy into the target repo:

- `on:` — `push` to `main`, `tags v*`, and `workflow_dispatch`. **No fork PR.**
- `permissions: contents: read` — least privilege.
- Pinned `tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd`
  (commit SHA, not `@v4`).
- Runner joins with `tags: 'tag:ci'` (must match Tailscale OAuth client tags).
- `VOLTMIND_READ_TOOL` / page-slug placeholder (`RELEASE-PLACEHOLDER`) must be
  filled with the real read check.

---

## 6. Setup checklist (for the configuring agent)

1. Create a **dedicated** Tailscale OAuth client (Admin → Settings → OAuth
   Clients) with **`auth_keys` scope** only, tags = `tag:ci`. **Do not** reuse a
   broad/full-scope client. Record id/secret.
2. Apply the **ACL block in §2** verbatim. Verify: `tailscale ping
   voltage3d.tailce7d39.ts.net` from a `tag:ci` node succeeds; no other tailnet
   targets are reachable.
3. Add the **4 secrets in §4** (real values from the operator).
4. Drop the **workflow file** into the target repo, set the read check, push.
5. Confirm the job: joins tailnet → mints read token → read MCP call → pass/fail.
6. Confirm the job does **not** print the token or secrets in logs.

---

## 7. Operation / rotation

- **Both secrets rotate** by: `voltmind auth revoke-client <id>` + re-register
  (VoltMind), and re-generate in Tailscale admin (TS). Then update the secrets.
- Suspicion of leak, repo provenance change, or security incident on the
  action/repo ⇒ rotate both immediately.
- Optional hardening on VoltMind client (both now applied/available):
  - `budget_usd_per_day = 1.00` on `voltmind-ci-release-gate` (set 2026-08-13,
    enforced by the budget-meter; adjust up/down as needed).
  - Narrow `federated_read` further if the gate only needs a subset.
- The tailnet ACL is reviewed/changed only deliberately (any ACL edit widens or
  narrows the entire CI blast radius).

---

## 8. Residual risks (accepted, with mitigations)

| Risk | Mitigation | Residual |
|---|---|---|
| Tailscale/VoltMind secret leak | SHA-pin, rotation, least-privilege ACL | Low if ACL stays narrow |
| Third-party action compromise | Commit-SHA pin | Low |
| Read-only data exposure on runner compromise | `read`-only + LAN-off network path | Low |
| Auth/network outage blocks release | None (gate is hard-fail) | Operational, accepted |

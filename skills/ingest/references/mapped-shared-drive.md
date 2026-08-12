### Mapped shared-drive reference ingest

When the user is configuring or repairing a mapped shared-drive path, run the
following on the thin-client workstation, not on the Host server:

```powershell
voltmind client-roots add synology-public `
  --local-root 'Z:\' `
  --unc-root '\\RaiDrive-CurrentUser\Synology'
voltmind client-roots test synology-public
voltmind client-roots normalize 'Z:\Public\Finance\example.xlsx'
```

Use a stable organization-wide root key; substitute the current workstation's
drive letter and UNC host. If the agent has no local shell on that workstation,
give these commands to the user instead of calling a Host MCP tool. Never run
`client-roots` through remote MCP: it belongs to the client file plane.

For RaiDrive, SMB, or another mapped shared drive, configure the same logical
`root_key` on every client (for example `synology-public`). Keep each
workstation's local drive and UNC roots only in its file-plane
`~/.voltmind/config.json` under `client_file_roots`. Before ingestion, call the
client resolver to emit only `root_key`, `relative_path`, and optional
`file_id`; never send or persist a drive letter or username-bearing RaiDrive
host. At query time, resolve the returned logical locator locally.

If the connector supplies a stable NAS/SMB file ID, send it as `file_id`; this
lets a move or rename update one reference. Without `file_id`, identity is
path-based, so a move or rename cannot be proven to be the same file and may
appear as a new reference. Missing mappings or temporary access failures must
not delete an existing reference.

For lookup, prefer the local wrapper when a workstation path was supplied:

```powershell
voltmind file-refs search 'Z:\Public\Finance\example.xlsx'
```

It normalizes locally, calls `search_file_refs` on the Host, and adds
`resolved_open_path` locally. Agents without client shell access should call
`search_file_refs` with `root_key` and `relative_path` instead.


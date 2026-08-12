# External File References

Read this reference for SharePoint, OneDrive, Outlook/Teams attachments,
RaiDrive, SMB/UNC, mapped-drive paths, file lookup, or materialization.

## Reference contract

Validate every `ExternalFileReferenceV1`; malformed references are retryable
write errors and must not be silently dropped. Include `schema_version: 1` and
a stable occurrence identity.

- Microsoft: preserve tenant/drive/item identity.
- Shared filesystem: preserve logical `root_key + relative_path`, or
  `root_key + file_id` when a stable file ID exists.
- Never persist a drive letter, username-bearing UNC/RaiDrive host, access
  token, or client-only `open_path` in new events.
- Missing mappings or temporary access failures do not delete an existing
  reference.

Attach normalized references to the source page. Prefer `search_file_refs` for
exact service, item ID, MIME, name, or logical-path searches.

## Client root configuration

Run only on the thin-client workstation:

```powershell
voltmind client-roots add synology-public `
  --local-root 'Z:\' `
  --unc-root '\\RaiDrive-CurrentUser\Synology'
voltmind client-roots test synology-public
voltmind client-roots normalize 'Z:\Public\Finance\example.xlsx'
```

Use the same organization-wide `root_key` on every client while keeping local
drive/UNC mappings private to each workstation. Agents without a client shell
must provide the commands rather than run them on the Host.

Never run `client-roots` through remote MCP; it belongs to the client file
plane. For lookup from a workstation path, prefer:

```powershell
voltmind file-refs search 'Z:\Public\Finance\example.xlsx'
```

The local wrapper normalizes the path, queries the Host, and adds a local
`resolved_open_path`. Without client shell access, call `search_file_refs` with
`root_key` and `relative_path` instead.

## Materialization

File references are searchable metadata, not proof of file contents. Call
`file_ref_materialize` only after explicit user request to analyze or refresh
the referenced file. Preserve the original logical reference and attach the
derived artifact/evidence without fabricating unobserved file semantics.

# Windows release acceptance

This is the release gate for the published Windows binary. It is deliberately
separate from unit tests: the final check must use a clean Windows account or
VM, the binary downloaded from the release, and the real Task Scheduler
service.

## Preconditions

- Windows 10/11 with Bun or PowerShell available only for the harness.
- A disposable Postgres/Supabase database reachable from the machine.
- The published `voltmind-windows-x64.exe` URL and its SHA-256 checksum.
- No existing `VoltMind Autopilot` scheduled task in the test account.

The acceptance script refuses to run against PGLite because PGLite cannot host
the supervised Minions worker.

## Run the gate

From a checked-out VoltMind repository, run in PowerShell:

```powershell
./scripts/windows-release-acceptance.ps1 `
  -ReleaseUrl 'https://github.com/Justike001/voltmind/releases/download/vX.Y.Z/voltmind-windows-x64.exe' `
  -ExpectedSha256 '<sha256-from-release>' `
  -DatabaseUrl 'postgresql://<disposable-user>:<password>@<host>:5432/<db>'
```

The script creates a temporary `VOLTMIND_HOME`, downloads and hashes the
published executable, initializes a clean Postgres configuration, registers a
paused Task Scheduler entry, verifies its executable/arguments, starts it,
and polls `voltmind autopilot --status --json` until all of these are true:

- `scheduler_registered=true` and `scheduler_running=true`;
- the Autopilot PID is alive and its heartbeat is fresh;
- `engine=postgres` and `database_ready=true`.

It then pauses, uninstalls, and removes the temporary home. Add
`-KeepTask` only when an operator is deliberately inspecting the task after a
failed run; remove it manually afterward.

## Manual evidence to retain

Attach the following to the release record:

1. The release asset name and SHA-256.
2. The final status JSON (redact the database URL and any paths that identify
   a private user or machine).
3. A screenshot or exported XML of the `VoltMind Autopilot` task showing the
   native executable, `autopilot` arguments, `LogonTrigger`, `IgnoreNew`, and
   `RestartOnFailure`.
4. The task's Last Run Result and the Autopilot log covering startup.

Do not treat “task registered” or “process exists” alone as a successful
acceptance. The business readiness rules and the ongoing reliability checks
are documented in [windows-autopilot-reliability.md](windows-autopilot-reliability.md).

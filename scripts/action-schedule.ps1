# Resolve the configured user-scoped vault without printing its private path.
if (-not $env:VOLTMIND_LOCAL_BRAIN_VAULT) {
    $env:VOLTMIND_LOCAL_BRAIN_VAULT = [Environment]::GetEnvironmentVariable('VOLTMIND_LOCAL_BRAIN_VAULT', 'User')
}
& bun (Join-Path $PSScriptRoot 'action-schedule.ts') @args
exit $LASTEXITCODE

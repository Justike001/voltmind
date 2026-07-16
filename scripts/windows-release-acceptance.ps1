[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedSha256,

  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl,

  [switch]$KeepTask
)

$ErrorActionPreference = 'Stop'
$taskName = 'VoltMind Autopilot'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("voltmind-release-acceptance-" + [guid]::NewGuid().ToString('N'))
$home = Join-Path $root 'home'
$repo = Join-Path $root 'repo'
$runtimeEnv = Join-Path $root 'runtime.env'
$binary = Join-Path $root 'voltmind.exe'

function Invoke-VoltMind {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & $binary @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "voltmind $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Get-Status {
  $json = (& $binary autopilot --status --json | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "autopilot --status --json failed with exit code $LASTEXITCODE" }
  try { return $json | ConvertFrom-Json } catch { throw "Invalid Autopilot status JSON: $json" }
}

try {
  if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    throw 'A disposable Postgres/Supabase connection string is required; PGLite cannot install a supervised Windows worker.'
  }

  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    throw "Task '$taskName' already exists. Run this acceptance on a clean Windows account or remove the existing task first."
  }

  New-Item -ItemType Directory -Force -Path $home, $repo | Out-Null
  Invoke-WebRequest -Uri $ReleaseUrl -OutFile $binary
  $actualHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
  if ($actualHash -ne $ExpectedSha256.ToUpperInvariant()) {
    throw "Published binary SHA-256 mismatch. Expected $ExpectedSha256, got $actualHash."
  }

  $env:VOLTMIND_HOME = $home
  $env:VOLTMIND_DATABASE_URL = $DatabaseUrl

  Write-Host '[1/6] Published binary smoke test'
  Invoke-VoltMind --help | Out-Null
  Invoke-VoltMind init --non-interactive --no-embedding --force | Out-Null
  Invoke-VoltMind doctor --fast --json | Out-Null

  # The Task action starts a fresh process, so provide only the allowlisted
  # runtime variables through the same env-file path production uses.
  @(
    "VOLTMIND_HOME=$home"
    "VOLTMIND_DATABASE_URL=$DatabaseUrl"
  ) | Set-Content -LiteralPath $runtimeEnv -Encoding utf8NoBOM

  Write-Host '[2/6] Register the real Task Scheduler task (paused)'
  Invoke-VoltMind autopilot --install --paused --repo $repo --runtime-env-file $runtimeEnv | Out-Null

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $action = @($task.Actions)[0]
  if ([System.IO.Path]::GetFullPath($action.Execute) -ne [System.IO.Path]::GetFullPath($binary)) {
    throw "Task action executable mismatch: $($action.Execute)"
  }
  if ($action.Arguments -notmatch '(^|\s)autopilot(\s|$)') {
    throw "Task action does not launch autopilot: $($action.Arguments)"
  }
  if ($action.Arguments -notmatch '--runtime-env-file') {
    throw 'Task action does not carry the runtime env file.'
  }

  Write-Host '[3/6] Verify paused state'
  $paused = Get-Status
  if (-not $paused.scheduler_registered -or $paused.scheduler_enabled) {
    throw "Expected a registered disabled task; status was: $($paused | ConvertTo-Json -Compress)"
  }

  Write-Host '[4/6] Start the real scheduled task'
  Invoke-VoltMind autopilot --start --json | Out-Null

  Write-Host '[5/6] Verify scheduler + PID + heartbeat'
  $running = $null
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 5
    $running = Get-Status
    if ($running.scheduler_registered -and $running.scheduler_running -and $running.autopilot_active) { break }
  }
  if (-not $running.scheduler_registered -or -not $running.scheduler_running -or -not $running.autopilot_active) {
    throw "Task/PID/heartbeat did not become healthy: $($running | ConvertTo-Json -Compress)"
  }
  if ($running.engine -ne 'postgres' -or -not $running.database_ready) {
    throw "Autopilot did not connect to Postgres: $($running | ConvertTo-Json -Compress)"
  }

  Write-Host '[6/6] Acceptance passed'
  $running | ConvertTo-Json -Depth 8
}
finally {
  if (-not $KeepTask) {
    try { & $binary autopilot --pause --force --json *> $null } catch { }
    try { & $binary autopilot --uninstall *> $null } catch { }
  }
  Remove-Item Env:VOLTMIND_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:VOLTMIND_DATABASE_URL -ErrorAction SilentlyContinue
  if (-not $KeepTask) {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "Acceptance artifacts retained at $root"
  }
}

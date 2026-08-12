$ErrorActionPreference = 'Stop'

$environmentNames = @(
    'VOLTMIND_ADMIN_HOST',
    'VOLTMIND_ADMIN_UPSTREAM',
    'VOLTMIND_ADMIN_DIST',
    'VOLTMIND_ADMIN_LOG',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME'
)

foreach ($name in $environmentNames) {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if (-not $value) {
        throw "Missing required user environment variable: $name"
    }
    Set-Item -LiteralPath "Env:$name" -Value $value
}

& (Join-Path $PSScriptRoot 'bin\caddy.exe') run `
    --environ `
    --config (Join-Path $PSScriptRoot 'Caddyfile') `
    --adapter caddyfile

exit $LASTEXITCODE

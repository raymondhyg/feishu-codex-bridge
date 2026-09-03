param(
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDirectory = Join-Path $env:USERPROFILE '.codex\private\lark-im-codex-bridge'
$bridgeScript = Join-Path $scriptDirectory 'bridge.mjs'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$pidPath = Join-Path $runtimeDirectory 'bridge.pid'
. (Join-Path $scriptDirectory 'bridge-process-identity.ps1')

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

if (Test-Path -LiteralPath $pidPath) {
    try {
        $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8).Trim()
        $existingIdentity = Get-BridgeProcessIdentity `
            -ProcessId $existingPid `
            -NodeExecutable $nodeExecutable `
            -BridgeScript $bridgeScript
        if ($existingIdentity -eq 'bridge') {
            [pscustomobject]@{
                ok = $true
                status = 'already_running'
                bridge_pid = $existingPid
            } | ConvertTo-Json
            return
        }
        if ($existingIdentity -eq 'unknown') {
            throw 'Unable to verify the process identity for the existing bridge PID.'
        }
    } catch {
        if ($_.Exception.Message -like 'Unable to verify*') {
            throw
        }
        # A malformed or stale PID file must not block a safe restart.
    }
    Remove-Item -LiteralPath $pidPath -Force
}

# The first bot verification after Windows logon can be transient. Keep one
# bounded retry path for both scheduled and manual startup.
$preflightReady = $false
$preflightAttempts = 3
$preflightAttempt = 0
$lastPreflightError = 'unknown preflight failure'
for ($preflightAttempt = 1; $preflightAttempt -le $preflightAttempts; $preflightAttempt++) {
    $preflightOutput = & $nodeExecutable $bridgeScript --preflight 2>&1
    if ($LASTEXITCODE -eq 0) {
        $preflightReady = $true
        break
    }

    $lastLine = @($preflightOutput | Select-Object -Last 1)
    if ($lastLine.Count -gt 0) {
        $lastPreflightError = [string]$lastLine[0]
        $lastPreflightError = $lastPreflightError `
            -replace '(ou_|oc_|om_|cli_|app_)[A-Za-z0-9_-]+', '<redacted-id>' `
            -replace '(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', '<redacted-uuid>' `
            -replace '(?i)Bearer\s+[A-Za-z0-9._~+/\-]+', 'Bearer <redacted>' `
            -replace '(?i)(access[_-]?token|refresh[_-]?token|app[_-]?secret|cookie|authorization)["'' :=]+[^, }]+', '$1=<redacted>'
    }
    if ($preflightAttempt -lt $preflightAttempts) {
        Start-Sleep -Seconds 2
    }
}

if (-not $preflightReady) {
    throw "Bridge preflight failed after $preflightAttempts attempts: $lastPreflightError"
}

if ($Foreground) {
    $bridgeProcess = Start-Process `
        -FilePath $nodeExecutable `
        -ArgumentList @($bridgeScript) `
        -WorkingDirectory $scriptDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDirectory 'service.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDirectory 'service.stderr.log') `
        -PassThru `
        -Wait
    exit $bridgeProcess.ExitCode
}

$bridgeProcess = Start-Process `
    -FilePath $nodeExecutable `
    -ArgumentList @($bridgeScript) `
    -WorkingDirectory $scriptDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtimeDirectory 'service.stdout.log') `
    -RedirectStandardError (Join-Path $runtimeDirectory 'service.stderr.log') `
    -PassThru

[pscustomobject]@{
    ok = $true
    status = 'launched'
    bridge_pid = $bridgeProcess.Id
    preflight_attempts = $preflightAttempt
} | ConvertTo-Json

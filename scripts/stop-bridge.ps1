$ErrorActionPreference = 'Stop'

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeScript = Join-Path $scriptDirectory 'bridge.mjs'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
. (Join-Path $scriptDirectory 'bridge-process-identity.ps1')

$runtimeDirectory = Join-Path $env:USERPROFILE '.codex\private\lark-im-codex-bridge'
$pidPath = Join-Path $runtimeDirectory 'bridge.pid'
$stopRequestPath = Join-Path $runtimeDirectory 'stop.request'

function Remove-BridgePidFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
        # The bridge releases its own PID lock during shutdown. Missing is success.
    }
}

if (-not (Test-Path -LiteralPath $pidPath)) {
    [pscustomobject]@{ ok = $true; status = 'stopped'; detail = 'no pid file' } |
        ConvertTo-Json
    return
}

$pidValue = $null
try {
    $pidValue = [int](Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8).Trim()
} catch {
    Remove-BridgePidFile -Path $pidPath
    Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{ ok = $true; status = 'stopped'; detail = 'removed invalid pid file' } |
        ConvertTo-Json
    return
}
$pidIdentity = Get-BridgeProcessIdentity `
    -ProcessId $pidValue `
    -NodeExecutable $nodeExecutable `
    -BridgeScript $bridgeScript
if ($pidIdentity -eq 'unknown') {
    throw 'Unable to verify the process identity for the existing bridge PID.'
}
if ($pidIdentity -ne 'bridge') {
    Remove-BridgePidFile -Path $pidPath
    Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{ ok = $true; status = 'stopped'; detail = 'removed stale pid file' } |
        ConvertTo-Json
    return
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($stopRequestPath, [DateTime]::UtcNow.ToString('o'), $utf8NoBom)

$stopTimeoutSeconds = 45
$deadline = [DateTime]::UtcNow.AddSeconds($stopTimeoutSeconds)
while ((Test-Path -LiteralPath $pidPath) -and [DateTime]::UtcNow -lt $deadline) {
    $pidValue = [int](Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8).Trim()
    $pidIdentity = Get-BridgeProcessIdentity `
        -ProcessId $pidValue `
        -NodeExecutable $nodeExecutable `
        -BridgeScript $bridgeScript
    if ($pidIdentity -eq 'unknown') {
        Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
        throw 'Unable to verify the bridge process identity while stopping.'
    }
    if ($pidIdentity -ne 'bridge') {
        Remove-BridgePidFile -Path $pidPath
        Remove-Item -LiteralPath $stopRequestPath -Force -ErrorAction SilentlyContinue
        break
    }
    Start-Sleep -Milliseconds 250
}

if (Test-Path -LiteralPath $pidPath) {
    [pscustomobject]@{ ok = $false; status = 'timeout'; detail = "bridge did not stop in $stopTimeoutSeconds seconds" } |
        ConvertTo-Json
    throw "Bridge did not stop in $stopTimeoutSeconds seconds."
}

[pscustomobject]@{ ok = $true; status = 'stopped'; detail = 'graceful control request completed' } |
    ConvertTo-Json

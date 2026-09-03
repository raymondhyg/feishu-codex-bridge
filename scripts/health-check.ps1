[CmdletBinding()]
param(
    [switch]$RequireClean,

    [ValidateRange(0, 120)]
    [int]$WaitSeconds = 0
)

$ErrorActionPreference = 'Stop'
$scriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
if ($WaitSeconds -gt 0) {
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $lastOutput = $null
    $lastExitCode = 1
    do {
        $arguments = @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $scriptPath
        )
        if ($RequireClean) { $arguments += '-RequireClean' }
        $lastOutput = @(& powershell.exe @arguments)
        $lastExitCode = $LASTEXITCODE
        if ($lastExitCode -eq 0) {
            $lastOutput
            exit 0
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    $lastOutput
    exit $lastExitCode
}
$expectedBridgeVersion = '0.12.7'
$expectedStateSchema = 6

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeScript = Join-Path $scriptDirectory 'bridge.mjs'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
. (Join-Path $scriptDirectory 'bridge-process-identity.ps1')

$runtimeDirectory = Join-Path $env:USERPROFILE '.codex\private\lark-im-codex-bridge'
$pidPath = Join-Path $runtimeDirectory 'bridge.pid'
$statePath = Join-Path $runtimeDirectory 'state.json'
$logPath = Join-Path $runtimeDirectory 'bridge.log.jsonl'
$eventStatus = lark-cli event status --json | ConvertFrom-Json
$consumer = @(
    $eventStatus.apps |
        ForEach-Object { $_.consumers } |
        Where-Object { $_.event_key -eq 'im.message.receive_v1' }
)

$pidValue = $null
$pidAlive = $false
$pidIdentity = 'absent'
if (Test-Path -LiteralPath $pidPath) {
    try {
        $pidValue = [int](Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8).Trim()
        $pidIdentity = Get-BridgeProcessIdentity `
            -ProcessId $pidValue `
            -NodeExecutable $nodeExecutable `
            -BridgeScript $bridgeScript
    } catch {
        $pidIdentity = 'invalid'
    }
    $pidAlive = $pidIdentity -eq 'bridge'
}

$stateRecord = $null
if (Test-Path -LiteralPath $statePath) {
    try {
        $stateRecord = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $stateRecord = $null
    }
}

$readyRecord = $null
if (Test-Path -LiteralPath $logPath) {
    Get-Content -LiteralPath $logPath -Tail 200 -Encoding UTF8 |
        ForEach-Object {
            try {
                $record = $_ | ConvertFrom-Json
                if (
                    $record.event -eq 'listener_ready' -and
                    [int]$record.bridgePid -eq $pidValue
                ) {
                    $readyRecord = $record
                }
            } catch {
                # Ignore a partial final log line while the service is writing.
            }
        }
}

$pendingRelayCount = 0
if ($null -ne $stateRecord -and $null -ne $stateRecord.pendingFixedRelays) {
    $pendingRelayCount = @($stateRecord.pendingFixedRelays.PSObject.Properties).Count
}
$pendingReplyCount = 0
if ($null -ne $stateRecord -and $null -ne $stateRecord.pendingReplies) {
    $pendingReplyCount = @($stateRecord.pendingReplies.PSObject.Properties).Count
}
$fixedState = if ($null -ne $stateRecord) {
    $stateRecord.fixedControllerRelay
} else {
    $null
}

$serviceHealthy = (
    $consumer.Count -eq 1 -and
    $null -ne $pidValue -and
    $pidAlive -and
    $null -ne $readyRecord -and
    $readyRecord.bridgeVersion -eq $expectedBridgeVersion -and
    $readyRecord.relayMode -eq 'fixed-controller-only' -and
    $readyRecord.fixedControllerRelayEnabled -eq $true -and
    $readyRecord.fixedControllerRelayTargetReadable -eq $true -and
    $readyRecord.fixedControllerDesktopVisibility -eq 'require' -and
    $readyRecord.fixedControllerRuntimeSandbox -eq 'danger-full-access' -and
    $readyRecord.fixedControllerRuntimeApprovalPolicy -eq 'never' -and
    $null -ne $stateRecord -and
    [int]$stateRecord.version -eq $expectedStateSchema
)
$acceptanceClean = (
    $serviceHealthy -and
    $pendingRelayCount -eq 0 -and
    $pendingReplyCount -eq 0
)

$result = [ordered]@{
    ok = $serviceHealthy
    service_healthy = $serviceHealthy
    acceptance_clean = $acceptanceClean
    bridge_pid = $pidValue
    bridge_pid_alive = $pidAlive
    bridge_pid_identity = $pidIdentity
    bridge_version = $readyRecord.bridgeVersion
    expected_bridge_version = $expectedBridgeVersion
    state_schema = if ($null -ne $stateRecord) { $stateRecord.version } else { $null }
    relay_mode = $readyRecord.relayMode
    fixed_controller_target_readable = $readyRecord.fixedControllerRelayTargetReadable
    fixed_controller_target_title = $fixedState.targetTitle
    desktop_visibility = $readyRecord.fixedControllerDesktopVisibility
    last_transport = $fixedState.lastTransport
    last_desktop_live_visible = $fixedState.lastDesktopLiveVisible
    last_turn_started_at = $fixedState.lastTurnStartedAt
    runtime_sandbox = $readyRecord.fixedControllerRuntimeSandbox
    runtime_approval_policy = $readyRecord.fixedControllerRuntimeApprovalPolicy
    pending_fixed_relays = $pendingRelayCount
    pending_replies = $pendingReplyCount
    active_consumers = $consumer.Count
    received = if ($consumer.Count -eq 1) { $consumer[0].received } else { $null }
    dropped = if ($consumer.Count -eq 1) { $consumer[0].dropped } else { $null }
    state_present = Test-Path -LiteralPath $statePath
}

[pscustomobject]$result | ConvertTo-Json
if (-not $serviceHealthy -or ($RequireClean -and -not $acceptanceClean)) { exit 1 }

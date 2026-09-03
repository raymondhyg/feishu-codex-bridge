[CmdletBinding()]
param(
    [ValidateSet('Upgrade', 'Repair')]
    [string]$Mode = 'Upgrade',

    [string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$canonicalRoot = [IO.Path]::GetFullPath(
    (Join-Path $env:USERPROFILE '.codex\skills\lark-im-codex-bridge')
).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
    $DestinationRoot = $canonicalRoot
}
$DestinationRoot = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
if (-not $DestinationRoot.Equals($canonicalRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Existing-device installation is restricted to the canonical bridge path.'
}
if ($sourceRoot.Equals($DestinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Run this entry from an extracted release, not from the installed canonical skill.'
}
if (-not (Test-Path -LiteralPath $DestinationRoot -PathType Container)) {
    throw 'No existing bridge installation was found. Use prepare-new-computer.ps1 instead.'
}

$runtimeRoot = [IO.Path]::GetFullPath(
    (Join-Path $env:USERPROFILE '.codex\private\lark-im-codex-bridge')
)
$configPath = Join-Path $runtimeRoot 'config.json'
$statePath = Join-Path $runtimeRoot 'state.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'Existing private configuration is missing. Repair installation will not invent a binding.'
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (
    [string]::IsNullOrWhiteSpace([string]$config.fixedControllerThreadId) -or
    [string]::IsNullOrWhiteSpace([string]$config.codexWorkingDirectory)
) {
    throw 'Existing private configuration has no exact fixed-controller binding.'
}

$pendingRelays = 0
$pendingReplies = 0
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $state.pendingFixedRelays) {
        $pendingRelays = @($state.pendingFixedRelays.PSObject.Properties).Count
    }
    if ($null -ne $state.pendingReplies) {
        $pendingReplies = @($state.pendingReplies.PSObject.Properties).Count
    }
}
if ($pendingRelays -ne 0 -or $pendingReplies -ne 0) {
    throw "Refusing replacement with pending work: relays=$pendingRelays replies=$pendingReplies"
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = [IO.Path]::GetFullPath(
    (Join-Path $env:USERPROFILE ".codex\backups\lark-im-codex-bridge-$($Mode.ToLowerInvariant())-$timestamp")
)
$backupPrefix = [IO.Path]::GetFullPath(
    (Join-Path $env:USERPROFILE '.codex\backups\lark-im-codex-bridge-')
)
if (-not $backupRoot.StartsWith($backupPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Backup path failed safety validation.'
}
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupRoot 'config.json')
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    Copy-Item -LiteralPath $statePath -Destination (Join-Path $backupRoot 'state.json')
}

$oldFiles = @(
    Get-ChildItem -LiteralPath $DestinationRoot -Recurse -File -Force |
        Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
        ForEach-Object {
            [ordered]@{
                path = $_.FullName.Substring($DestinationRoot.Length + 1).Replace('\', '/')
                bytes = $_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            }
        }
)
$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText(
    (Join-Path $backupRoot 'pre-install-inventory.json'),
    (([ordered]@{ mode = $Mode; files = $oldFiles } | ConvertTo-Json -Depth 5) + "`n"),
    $utf8WithoutBom
)

$stopScript = Join-Path $DestinationRoot 'scripts\stop-bridge.ps1'
if (Test-Path -LiteralPath $stopScript -PathType Leaf) {
    try {
        & $stopScript | Out-Null
    } catch {
        # A modified stop script may fail after the service already exited.
    }
}
$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
    $bridgeProcesses = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -eq 'node.exe' -and
                $_.CommandLine -and
                $_.CommandLine -match [regex]::Escape((Join-Path $DestinationRoot 'scripts\bridge.mjs'))
            }
    )
    if ($bridgeProcesses.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
if ($bridgeProcesses.Count -ne 0) {
    throw 'The existing bridge did not stop safely. No source replacement was attempted.'
}

$taskReadyDeadline = [DateTime]::UtcNow.AddSeconds(45)
do {
    $startupTask = Get-ScheduledTask -TaskName 'Codex-Lark-IM-Bridge' -ErrorAction SilentlyContinue
    if ($null -eq $startupTask -or [string]$startupTask.State -eq 'Ready') { break }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $taskReadyDeadline)
if ($null -ne $startupTask -and [string]$startupTask.State -ne 'Ready') {
    throw 'The existing startup task did not return to Ready. No source replacement was attempted.'
}

$eventStatus = lark-cli event status --json | ConvertFrom-Json
$activeConsumers = @($eventStatus.apps | Where-Object { $_.running -eq $true })
if ($activeConsumers.Count -gt 0) {
    lark-cli event stop --all | Out-Null
    $eventStatus = lark-cli event status --json | ConvertFrom-Json
    if (@($eventStatus.apps | Where-Object { $_.running -eq $true }).Count -gt 0) {
        throw 'An event consumer remained active after the bridge exited.'
    }
}

$oldSourceBackup = Join-Path $backupRoot 'source-original'
$failedCandidateBackup = Join-Path $backupRoot 'failed-candidate'
$installed = $false
try {
    Move-Item -LiteralPath $DestinationRoot -Destination $oldSourceBackup
    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $sourceRoot -Force | Where-Object { $_.Name -ne 'node_modules' } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $DestinationRoot -Recurse -Force }

    $installedScripts = Join-Path $DestinationRoot 'scripts'
    $npmExecutable = (Get-Command npm.cmd -ErrorAction Stop).Source
    Push-Location $installedScripts
    try {
        & $npmExecutable ci --ignore-scripts --no-audit --no-fund | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        & $npmExecutable run check | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed.' }
        & $npmExecutable test | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Automated tests failed.' }
        & $npmExecutable run preflight | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Transport preflight failed.' }
        & (Join-Path $installedScripts 'install-startup-task.ps1') | Out-Null
        Start-ScheduledTask -TaskName 'Codex-Lark-IM-Bridge'
        $healthOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
            (Join-Path $installedScripts 'health-check.ps1') -RequireClean -WaitSeconds 60
        if ($LASTEXITCODE -ne 0) { throw 'Clean health verification failed.' }
    } finally {
        Pop-Location
    }
    $installed = $true
} catch {
    $installError = $_
    if (Test-Path -LiteralPath $DestinationRoot) {
        Move-Item -LiteralPath $DestinationRoot -Destination $failedCandidateBackup
    }
    if (Test-Path -LiteralPath $oldSourceBackup) {
        Move-Item -LiteralPath $oldSourceBackup -Destination $DestinationRoot
    }
    throw $installError
}

[pscustomobject]@{
    ok = $installed
    mode = $Mode
    version = (Get-Content -LiteralPath (Join-Path $DestinationRoot 'scripts\package.json') -Raw | ConvertFrom-Json).version
    previous_public_source_files = $oldFiles.Count
    previous_public_source_backup = $oldSourceBackup
    private_config_preserved = $true
    private_state_preserved = (Test-Path -LiteralPath $statePath -PathType Leaf)
    pending_fixed_relays = $pendingRelays
    pending_replies = $pendingReplies
    dependency_install = 'passed'
    syntax_check = 'passed'
    automated_tests = 'passed'
    preflight = 'passed'
    startup_task = 'installed'
    clean_health = 'passed'
    real_feishu_round_trip = 'required'
} | ConvertTo-Json

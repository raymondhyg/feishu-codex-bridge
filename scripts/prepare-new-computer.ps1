[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$FixedControllerThreadId,

    [ValidatePattern('^ou_[A-Za-z0-9_-]+$')]
    [string]$AllowedSenderId,

    [Parameter(Mandatory = $true)]
    [ValidateScript({
        [System.IO.Path]::IsPathRooted($_) -and
        (Test-Path -LiteralPath $_ -PathType Container)
    })]
    [string]$FixedControllerWorkingDirectory,

    [switch]$DesktopNativeControllerReadbackConfirmed,

    [switch]$SkipStartupTask
)

$ErrorActionPreference = 'Stop'
$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
$env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$npmExecutable = (Get-Command npm.cmd -ErrorAction Stop).Source

if (-not $DesktopNativeControllerReadbackConfirmed) {
    throw 'Confirm the Desktop-native task was created/listed/read back with native Desktop task tools before installation.'
}

function Resolve-LarkCli {
    $command = Get-Command lark-cli -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    $prefixOutput = @(& $npmExecutable config get prefix 2>$null)
    if ($LASTEXITCODE -ne 0 -or $prefixOutput.Count -eq 0) {
        return $null
    }
    $prefix = ([string]$prefixOutput[-1]).Trim()
    foreach ($candidate in @(
        (Join-Path $prefix 'lark-cli.cmd'),
        (Join-Path $prefix 'lark-cli.ps1'),
        (Join-Path $prefix 'lark-cli.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return $null
}

$larkCliExecutable = Resolve-LarkCli
if ([string]::IsNullOrWhiteSpace($larkCliExecutable)) {
    throw 'lark-cli was not found.'
}

$auth = & $larkCliExecutable auth status --verify --json | ConvertFrom-Json
if ($auth.identities.bot.status -ne 'ready') {
    throw "Bot identity is not ready: $($auth.identities.bot.message)"
}
if ($auth.identities.user.status -ne 'ready') {
    throw 'User identity is not ready. Personal Docs, Drive, Tasks, VC, Minutes, and Note operations require user OAuth.'
}
if ([string]::IsNullOrWhiteSpace($AllowedSenderId)) {
    $AllowedSenderId = [string]$auth.identities.user.openId
}
if (-not $AllowedSenderId.StartsWith('ou_')) {
    throw 'Allowed sender open_id is unavailable.'
}

$runtimePath = [System.IO.Path]::GetFullPath(
    (Join-Path $env:USERPROFILE '.codex\private\lark-im-codex-bridge')
)
$configPath = Join-Path $runtimePath 'config.json'
$workspacePath = Join-Path $runtimePath 'workspace'
$attachmentPath = Join-Path $runtimePath 'attachments'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null
New-Item -ItemType Directory -Path $attachmentPath -Force | Out-Null
$controllerWorkingDirectory = [System.IO.Path]::GetFullPath(
    $FixedControllerWorkingDirectory
)

$requiredSkills = @(
    'lark-shared',
    'lark-event',
    'lark-im',
    'lark-doc',
    'lark-drive',
    'lark-task',
    'lark-vc',
    'lark-minutes',
    'lark-note'
)
$skillsEnvelope = & $larkCliExecutable skills list --json | ConvertFrom-Json
if ($skillsEnvelope.ok -ne $true) {
    throw 'Unable to read the lark-cli embedded skill catalog.'
}
$availableSkills = @($skillsEnvelope.skills | ForEach-Object { [string]$_.name })
$missingSkills = @($requiredSkills | Where-Object { $_ -notin $availableSkills })
if ($missingSkills.Count -gt 0) {
    throw "Required lark-cli skills are missing: $($missingSkills -join ', ')"
}

$backupPath = $null
if (Test-Path -LiteralPath $configPath) {
    $backupPath = "$configPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $configPath -Destination $backupPath
}

$config = [ordered]@{
    allowedSenderIds = @($AllowedSenderId)
    fixedControllerThreadId = $FixedControllerThreadId
    fixedControllerDesktopVisibility = 'require'
    runtimeDirectory = $runtimePath
    codexWorkingDirectory = $controllerWorkingDirectory
    attachmentRoot = $attachmentPath
    maxAttachmentBytes = 52428800
    maxAttachmentTotalBytes = 104857600
    codexControllerTurnTimeoutSeconds = 1800
    maxReplyChars = 12000
}
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$configWritten = $false
$startupActionHost = $null
$startupActionEngine = $null
$startupWindowlessExpected = $false
try {
    [System.IO.File]::WriteAllText(
        $configPath,
        (($config | ConvertTo-Json -Depth 5) + "`n"),
        $utf8WithoutBom
    )
    $configWritten = $true

    Push-Location $scriptDirectory
    try {
        & $npmExecutable ci --omit=dev --ignore-scripts | Out-Null
        & $nodeExecutable (Join-Path $scriptDirectory 'bridge.mjs') --preflight | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'Fixed-controller relay preflight failed.'
        }
        if (-not $SkipStartupTask) {
            & (Join-Path $scriptDirectory 'install-startup-task.ps1') | Out-Null
            $startupTask = Get-ScheduledTask -TaskName 'Codex-Lark-IM-Bridge'
            $startupAction = @($startupTask.Actions)[0]
            $expectedHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
            if (
                $null -eq $startupAction -or
                -not ([System.IO.Path]::GetFullPath([string]$startupAction.Execute)).Equals(
                    [System.IO.Path]::GetFullPath($expectedHost),
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -or
                [string]$startupAction.Arguments -notmatch '//E:JScript' -or
                [string]$startupAction.Arguments -notmatch 'run-bridge-hidden\.js'
            ) {
                throw 'The installed startup task is not using the windowless JScript launcher.'
            }
            $startupActionHost = 'wscript.exe'
            $startupActionEngine = 'JScript'
            $startupWindowlessExpected = $true
        }
    } finally {
        Pop-Location
    }
} catch {
    if ($configWritten) {
        if ($null -ne $backupPath -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            Copy-Item -LiteralPath $backupPath -Destination $configPath -Force
        } elseif (Test-Path -LiteralPath $configPath -PathType Leaf) {
            Remove-Item -LiteralPath $configPath -Force
        }
    }
    throw
}

[pscustomobject]@{
    ok = $true
    relay_mode = 'fixed-controller-only'
    bot_identity_ready = $true
    user_oauth_identity_ready = $true
    required_companion_skills_present = $true
    desktop_native_controller_readback_asserted = $true
    fixed_controller_preflight_passed = $true
    fixed_controller_target_readable = $true
    fixed_controller_working_directory_configured = $true
    config_path = $configPath
    backup_path = $backupPath
    startup_task_installed = -not $SkipStartupTask
    startup_action_host = $startupActionHost
    startup_action_engine = $startupActionEngine
    startup_windowless_expected = $startupWindowlessExpected
    legacy_task_scopes_required = $false
} | ConvertTo-Json

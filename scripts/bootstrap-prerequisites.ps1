[CmdletBinding()]
param(
    [switch]$InstallLarkTooling,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1'
$env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1'

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
$knownSkillRoots = @(
    (Join-Path $env:USERPROFILE '.agents\skills'),
    (Join-Path $env:USERPROFILE '.codex\skills')
)

function Write-BootstrapResult {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IDictionary]$Value,

        [int]$ExitCode = 0
    )

    [pscustomobject]$Value | ConvertTo-Json -Depth 6
    exit $ExitCode
}

function Resolve-LarkCli {
    $command = Get-Command lark-cli -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand) {
        return $null
    }
    $prefixOutput = @(& $npmCommand.Source config get prefix 2>$null)
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

function Get-MissingInstalledSkills {
    return @(
        foreach ($skillName in $requiredSkills) {
            $found = $false
            foreach ($root in $knownSkillRoots) {
                if (Test-Path -LiteralPath (Join-Path $root "$skillName\SKILL.md") -PathType Leaf) {
                    $found = $true
                    break
                }
            }
            if (-not $found) { $skillName }
        }
    )
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand -or $null -eq $npmCommand -or $null -eq $npxCommand) {
    Write-BootstrapResult -ExitCode 2 -Value ([ordered]@{
        ok = $false
        stage = 'node_prerequisite'
        node_ready = $null -ne $nodeCommand
        npm_ready = $null -ne $npmCommand
        npx_ready = $null -ne $npxCommand
        lark_cli_ready = $false
        bot_identity_ready = $false
        user_oauth_identity_ready = $false
        lark_skill_prerequisites_ready = $false
        next_action = 'Install the current Node.js LTS release, then rerun this script.'
    })
}

$installPerformed = $false
$larkCliPath = Resolve-LarkCli
if ($InstallLarkTooling) {
    # Current official AI-agent entry. It installs or updates the CLI and
    # installs the matching larksuite/cli agent skills. It never configures an
    # app or completes user authorization without the later human steps.
    & $npxCommand.Source --yes '@larksuite/cli@latest' install
    if ($LASTEXITCODE -ne 0) {
        Write-BootstrapResult -ExitCode 2 -Value ([ordered]@{
            ok = $false
            stage = 'lark_tooling_install'
            node_ready = $true
            npm_ready = $true
            npx_ready = $true
            lark_cli_ready = $false
            bot_identity_ready = $false
            user_oauth_identity_ready = $false
            lark_skill_prerequisites_ready = $false
            install_attempted = $true
            next_action = 'Inspect the official installer output, network, proxy, and npm global path, then retry.'
        })
    }
    $installPerformed = $true
    $larkCliPath = Resolve-LarkCli
}

if ([string]::IsNullOrWhiteSpace($larkCliPath)) {
    Write-BootstrapResult -ExitCode 2 -Value ([ordered]@{
        ok = $false
        stage = 'lark_tooling_missing'
        node_ready = $true
        npm_ready = $true
        npx_ready = $true
        lark_cli_ready = $false
        bot_identity_ready = $false
        user_oauth_identity_ready = $false
        lark_skill_prerequisites_ready = $false
        install_attempted = $installPerformed
        official_install_command = 'npx @larksuite/cli@latest install'
        next_action = 'Rerun with -InstallLarkTooling or let the receiving Codex use the current official installer.'
    })
}

$versionText = (@(& $larkCliPath --version 2>&1) -join "`n").Trim()
if ($LASTEXITCODE -ne 0) {
    Write-BootstrapResult -ExitCode 2 -Value ([ordered]@{
        ok = $false
        stage = 'lark_cli_version'
        node_ready = $true
        npm_ready = $true
        npx_ready = $true
        lark_cli_ready = $false
        bot_identity_ready = $false
        user_oauth_identity_ready = $false
        lark_skill_prerequisites_ready = $false
        install_attempted = $installPerformed
        next_action = 'Repair the lark-cli executable or PATH, then rerun.'
    })
}

$skillsText = (@(& $larkCliPath skills list --json 2>&1) -join "`n").Trim()
$skillsEnvelope = $null
try {
    $skillsEnvelope = $skillsText | ConvertFrom-Json
} catch {
    $skillsEnvelope = $null
}
$embeddedSkills = if ($null -ne $skillsEnvelope -and $skillsEnvelope.ok -eq $true) {
    @($skillsEnvelope.skills | ForEach-Object { [string]$_.name })
} else {
    @()
}
$missingEmbeddedSkills = @(
    $requiredSkills | Where-Object { $_ -notin $embeddedSkills }
)
$missingInstalledSkills = @(Get-MissingInstalledSkills)
$skillRepairPerformed = $false
if ($InstallLarkTooling -and $missingInstalledSkills.Count -gt 0) {
    # The current official CLI also advertises this repair route. Run it only
    # inside the explicit installation mode, then trust the recheck rather than
    # assuming the installer refreshed a partial existing skill set.
    & $npxCommand.Source --yes skills add larksuite/cli -g -y
    if ($LASTEXITCODE -ne 0) {
        Write-BootstrapResult -ExitCode 2 -Value ([ordered]@{
            ok = $false
            stage = 'lark_agent_skill_repair'
            node_ready = $true
            npm_ready = $true
            npx_ready = $true
            lark_cli_ready = $true
            bot_identity_ready = $false
            user_oauth_identity_ready = $false
            lark_skill_prerequisites_ready = $false
            install_attempted = $installPerformed
            skill_repair_attempted = $true
            next_action = 'Inspect the current official skills installer output and Codex skill roots, then retry.'
        })
    }
    $skillRepairPerformed = $true
    $missingInstalledSkills = @(Get-MissingInstalledSkills)
}

$authArgs = @('auth', 'status', '--json')
if (-not $Offline) {
    $authArgs += '--verify'
}
$authText = (@(& $larkCliPath @authArgs 2>&1) -join "`n").Trim()
$authEnvelope = $null
try {
    $authEnvelope = $authText | ConvertFrom-Json
} catch {
    $authEnvelope = $null
}
$botReady = (
    $null -ne $authEnvelope -and
    $authEnvelope.identities.bot.status -eq 'ready'
)
$userReady = (
    $null -ne $authEnvelope -and
    $authEnvelope.identities.user.status -eq 'ready'
)
$skillsReady = (
    $missingEmbeddedSkills.Count -eq 0 -and
    $missingInstalledSkills.Count -eq 0
)
$readyForControllerSelection =
    $skillsReady -and $botReady -and $userReady -and (-not $Offline)

$nextAction = if ($missingEmbeddedSkills.Count -gt 0 -or $missingInstalledSkills.Count -gt 0) {
    'Repair the official lark-cli and larksuite/cli skill installation, then start a fresh Codex task or reread the embedded skills.'
} elseif ($Offline) {
    'Rerun without -Offline to verify bot and user identities against Feishu.'
} elseif (-not $botReady -or -not $userReady) {
    'Complete the human Feishu app/configuration and user OAuth steps, then rerun this check.'
} else {
    'Create or select one Desktop-native controller, read back its exact thread ID and cwd privately, then run prepare-new-computer.ps1.'
}

Write-BootstrapResult -ExitCode $(if ($readyForControllerSelection) { 0 } else { 3 }) -Value ([ordered]@{
    ok = $readyForControllerSelection
    stage = $(if ($readyForControllerSelection) { 'controller_selection_prerequisites_ready' } else { 'human_feishu_setup_or_skill_recovery_required' })
    node_ready = $true
    npm_ready = $true
    npx_ready = $true
    lark_cli_ready = $true
    lark_cli_version = $versionText
    install_attempted = $installPerformed
    skill_repair_attempted = $skillRepairPerformed
    required_skill_count = $requiredSkills.Count
    missing_embedded_skills = $missingEmbeddedSkills
    missing_agent_skills = $missingInstalledSkills
    bot_identity_ready = $botReady
    user_oauth_identity_ready = $userReady
    auth_verified_online = -not $Offline
    lark_skill_prerequisites_ready = $skillsReady
    ready_for_controller_selection = $readyForControllerSelection
    transport_preflight_required = $true
    resource_operation_readback_required = $true
    next_action = $nextAction
})

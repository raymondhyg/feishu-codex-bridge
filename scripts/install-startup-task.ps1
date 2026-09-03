$ErrorActionPreference = 'Stop'

$taskName = 'Codex-Lark-IM-Bridge'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$hiddenLauncher = Join-Path $scriptDirectory 'run-bridge-hidden.js'
$wscriptExecutable = Join-Path $env:SystemRoot 'System32\wscript.exe'
$userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not (Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) {
    throw 'The hidden bridge launcher is missing.'
}
if (-not (Test-Path -LiteralPath $wscriptExecutable -PathType Leaf)) {
    throw 'Windows Script Host is unavailable.'
}
$arguments = "//E:JScript //B //NoLogo `"$hiddenLauncher`""

$action = New-ScheduledTaskAction -Execute $wscriptExecutable -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$trigger.Delay = 'PT15S'
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Starts the private Feishu to Codex bridge without a visible console.' `
    -Force | Out-Null

Get-ScheduledTask -TaskName $taskName |
    Select-Object TaskName, State, TaskPath |
    ConvertTo-Json

$ErrorActionPreference = 'Stop'

$taskName = 'Codex-Lark-IM-Bridge'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

[pscustomobject]@{ ok = $true; task_name = $taskName; installed = $false } |
    ConvertTo-Json

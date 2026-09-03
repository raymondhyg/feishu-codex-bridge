function Test-BridgeCommandLineIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProcessName,

        [AllowEmptyString()]
        [string]$CommandLine,

        [Parameter(Mandatory = $true)]
        [string]$NodeExecutable,

        [Parameter(Mandatory = $true)]
        [string]$BridgeScript
    )

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return 'unknown'
    }

    $expectedExecutableName = [IO.Path]::GetFileName($NodeExecutable)
    if ($ProcessName -ine $expectedExecutableName) {
        return 'other'
    }

    $expectedBridgeScript = [IO.Path]::GetFullPath($BridgeScript)
    $argumentPattern = '(?i)(?:^|[\s"])' +
        [regex]::Escape($expectedBridgeScript) +
        '(?:[\s"]|$)'
    if ([regex]::IsMatch($CommandLine, $argumentPattern)) {
        return 'bridge'
    }

    return 'other'
}

function Get-BridgeProcessIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,

        [Parameter(Mandatory = $true)]
        [string]$NodeExecutable,

        [Parameter(Mandatory = $true)]
        [string]$BridgeScript
    )

    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        return 'absent'
    }

    try {
        $record = Get-CimInstance `
            -ClassName Win32_Process `
            -Filter ("ProcessId = {0}" -f $ProcessId) `
            -ErrorAction Stop
    } catch {
        return 'unknown'
    }
    if ($null -eq $record) {
        return 'absent'
    }

    return Test-BridgeCommandLineIdentity `
        -ProcessName ([string]$record.Name) `
        -CommandLine ([string]$record.CommandLine) `
        -NodeExecutable $NodeExecutable `
        -BridgeScript $BridgeScript
}

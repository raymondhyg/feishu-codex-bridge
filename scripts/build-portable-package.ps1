[CmdletBinding()]
param(
    [string]$SourceRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [string]$Version
)

$ErrorActionPreference = 'Stop'
$packageName = 'feishu-codex-bridge'
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Join-Path $PSScriptRoot '..'
}
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
if ($SourceRoot -ne [IO.Path]::GetPathRoot($SourceRoot)) {
    $SourceRoot = $SourceRoot.TrimEnd([char[]]@('\', '/'))
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ($OutputDirectory -eq [IO.Path]::GetPathRoot($OutputDirectory)) {
    throw 'The release output cannot be a filesystem root.'
}
$OutputDirectory = $OutputDirectory.TrimEnd([char[]]@('\', '/'))
$sourcePrefix = $SourceRoot.TrimEnd('\') + '\'
if (
    $OutputDirectory.Equals($SourceRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)
) {
    throw 'The release output must not be inside the canonical source root.'
}
if (Test-Path -LiteralPath $OutputDirectory) {
    throw "Refusing to reuse an existing release directory: $OutputDirectory"
}

$packageMetadataPath = Join-Path $SourceRoot 'scripts\package.json'
if (-not (Test-Path -LiteralPath $packageMetadataPath -PathType Leaf)) {
    throw 'Canonical package metadata is missing.'
}
$packageMetadata = Get-Content -LiteralPath $packageMetadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
$canonicalVersion = [string]$packageMetadata.version
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $canonicalVersion
}
if ($Version -ne $canonicalVersion) {
    throw "Requested version $Version does not match canonical version $canonicalVersion."
}

$files = @(
    '.gitignore',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'README.md',
    'README-FIRST.md',
    'SECURITY.md',
    'SKILL.md',
    'THIRD_PARTY_NOTICES.md',
    'agents/openai.yaml',
    'assets/acceptance-fixture.png',
    'assets/acceptance-fixture.txt',
    'references/implementation-plan.md',
    'references/new-computer-deployment-guide.md',
    'scripts/bridge.mjs',
    'scripts/bridge-core.mjs',
    'scripts/bridge-core.test.mjs',
    'scripts/bridge-process-identity.ps1',
    'scripts/bootstrap-prerequisites.ps1',
    'scripts/build-portable-package.ps1',
    'scripts/codex-app-server.mjs',
    'scripts/codex-desktop-ipc.mjs',
    'scripts/codex-desktop-ipc.test.mjs',
    'scripts/config.example.json',
    'scripts/configure-fixed-controller-relay.mjs',
    'scripts/configure-fixed-controller-relay.test.mjs',
    'scripts/controller-thread-tool.mjs',
    'scripts/controller-thread-tool.test.mjs',
    'scripts/controller-thread-transport.mjs',
    'scripts/fixed-controller-relay.mjs',
    'scripts/fixed-controller-relay.test.mjs',
    'scripts/health-check.ps1',
    'scripts/install-startup-task.ps1',
    'scripts/package.json',
    'scripts/package-lock.json',
    'scripts/prepare-new-computer.ps1',
    'scripts/run-bridge-hidden.js',
    'scripts/start-bridge.ps1',
    'scripts/startup-scripts.test.mjs',
    'scripts/stop-bridge.ps1',
    'scripts/uninstall-startup-task.ps1',
    'scripts/upgrade-or-repair-existing-computer.ps1'
) | Sort-Object

$actualSourceFiles = @(
    Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force |
        Where-Object { $_.FullName -notmatch '\\(?:node_modules|\.git)\\' } |
        ForEach-Object {
            $_.FullName.Substring($SourceRoot.Length + 1).Replace('\', '/')
        } |
        Sort-Object
)
$sourceDifference = @(Compare-Object -ReferenceObject $files -DifferenceObject $actualSourceFiles)
if ($sourceDifference.Count -gt 0) {
    $differenceText = ($sourceDifference | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }) -join '; '
    throw "Portable allowlist does not match canonical source: $differenceText"
}

$forbiddenPathPattern = '(^|/)(\.git|node_modules|private|logs?|attachments?|historical|work)(/|$)|(^|/)(config|state|jobs|auth)\.json$|(^|/)\.env($|\.)|\.(jsonl|sqlite|sqlite3|db)$'
$historicalModulePattern = '(^|/)(codex-control|codex-job-manager|job-registry|secretary-investigation)(\.|/)'
foreach ($relativePath in $files) {
    if ($relativePath -match $forbiddenPathPattern -or $relativePath -match $historicalModulePattern) {
        throw "Forbidden package entry: $relativePath"
    }
    $sourcePath = Join-Path $SourceRoot $relativePath.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required package file is missing: $relativePath"
    }
}

$archiveName = "$packageName-v$Version-portable.zip"
$manifestName = "$packageName-v$Version-manifest.json"
$guideName = 'new-computer-deployment-guide.md'
$readmeName = 'README-FIRST.md'
$outputParent = Split-Path -Parent $OutputDirectory
if ([string]::IsNullOrWhiteSpace($outputParent)) {
    throw 'The release output parent is unavailable.'
}
New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
$workRoot = Join-Path $outputParent ('.feishu-codex-package-' + [guid]::NewGuid().ToString('N'))
$workRoot = [IO.Path]::GetFullPath($workRoot)
$expectedPrefix = [IO.Path]::GetFullPath($outputParent).TrimEnd('\') + '\.feishu-codex-package-'
if (-not $workRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Temporary package path failed safety validation.'
}

$publishedByThisRun = $false
$releaseVerified = $false
try {
    $stagingRoot = Join-Path $workRoot 'staging'
    $packageRoot = Join-Path $stagingRoot $packageName
    $releaseRoot = Join-Path $workRoot 'release'
    $verificationRoot = Join-Path $workRoot 'verification'
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $verificationRoot -Force | Out-Null

    foreach ($relativePath in $files) {
        $sourcePath = Join-Path $SourceRoot $relativePath.Replace('/', '\')
        $packagePath = Join-Path $packageRoot $relativePath.Replace('/', '\')
        New-Item -ItemType Directory -Path (Split-Path -Parent $packagePath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $packagePath
    }

    $externalPlanPath = Join-Path $packageRoot 'references\implementation-plan.md'
    $externalPlan = @'
# External Release Operating Plan

This package supports three receiving-device paths: clean installation,
preserve-configuration upgrade, and recoverable repair installation.

The bridge is transport only. It binds one Desktop-native local controller by
an exact private thread ID and working directory. Titles never route messages.

Private configuration, state, credentials, logs, attachments, message bodies,
and device-specific identifiers are not part of this release. Upgrade and
repair preserve the receiving device's private runtime, archive its previous
public source, install the clean release source, and require device-local
preflight, health, and real Feishu acceptance.

Package verification does not prove receiving-device runtime acceptance.
'@
    [IO.File]::WriteAllText($externalPlanPath, ($externalPlan.Trim() + "`n"), $utf8WithoutBom)

    $privateUserLabel = ([char]0x5149).ToString() + ([char]0x54E5)
    $privateControllerLabel = ([char]0x7C73).ToString() + ([char]0x7C92)
    $sourceUserName = 'han' + 'yo'
    $forbiddenContentPatterns = [ordered]@{
        personalized_user_label = '(?i)' + [regex]::Escape($privateUserLabel)
        personalized_controller_label = '(?i)' + [regex]::Escape($privateControllerLabel)
        source_windows_user = '(?i)(?:C:[\\/]+Users[\\/]+|%USERPROFILE%[\\/]+[^\r\n]*?)' + [regex]::Escape($sourceUserName)
        private_thread_uri = '(?i)codex://threads/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    }
    foreach ($textFile in Get-ChildItem -LiteralPath $packageRoot -Recurse -File -Force |
        Where-Object { $_.Extension -in @('.md', '.mjs', '.ps1', '.json', '.yaml', '.yml', '.txt') }) {
        $content = Get-Content -LiteralPath $textFile.FullName -Raw -Encoding UTF8
        foreach ($rule in $forbiddenContentPatterns.GetEnumerator()) {
            if ($content -match $rule.Value) {
                $relative = $textFile.FullName.Substring($packageRoot.Length + 1).Replace('\', '/')
                throw "External content scan rejected $relative ($($rule.Key))."
            }
        }
    }

    $temporaryArchivePath = Join-Path $releaseRoot $archiveName
    $temporaryGuidePath = Join-Path $releaseRoot $guideName
    $temporaryReadmePath = Join-Path $releaseRoot $readmeName
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $temporaryArchivePath -CompressionLevel Optimal
    Copy-Item -LiteralPath (Join-Path $SourceRoot 'references\new-computer-deployment-guide.md') -Destination $temporaryGuidePath
    Copy-Item -LiteralPath (Join-Path $SourceRoot 'README-FIRST.md') -Destination $temporaryReadmePath

    Expand-Archive -LiteralPath $temporaryArchivePath -DestinationPath $verificationRoot
    $verifiedPackageRoot = Join-Path $verificationRoot $packageName
    if (-not (Test-Path -LiteralPath $verifiedPackageRoot -PathType Container)) {
        throw 'Expanded package root is missing.'
    }

    $entries = @(
        foreach ($relativePath in $files) {
            $packagedPath = Join-Path $packageRoot $relativePath.Replace('/', '\')
            $item = Get-Item -LiteralPath $packagedPath
            [ordered]@{
                path = $relativePath
                bytes = $item.Length
                sha256 = (Get-FileHash -LiteralPath $packagedPath -Algorithm SHA256).Hash
            }
        }
    )
    $verifiedFiles = @(
        Get-ChildItem -LiteralPath $verifiedPackageRoot -Recurse -File -Force |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($verifiedPackageRoot.Length + 1).Replace('\', '/')
                    bytes = $_.Length
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                }
            }
    )
    if ($verifiedFiles.Count -ne $entries.Count) {
        throw 'Expanded package file count does not match the allowlist.'
    }
    foreach ($expectedEntry in $entries) {
        $actualEntry = @($verifiedFiles | Where-Object { $_.path -eq $expectedEntry.path })
        if (
            $actualEntry.Count -ne 1 -or
            $actualEntry[0].bytes -ne $expectedEntry.bytes -or
            $actualEntry[0].sha256 -ne $expectedEntry.sha256
        ) {
            throw "Expanded package entry mismatch: $($expectedEntry.path)"
        }
    }

    $npmExecutable = (Get-Command npm.cmd -ErrorAction Stop).Source
    Push-Location (Join-Path $verifiedPackageRoot 'scripts')
    try {
        & $npmExecutable ci --ignore-scripts --no-audit --no-fund | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Expanded package npm ci failed.' }
        & $npmExecutable run check | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Expanded package syntax check failed.' }
        & $npmExecutable test | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Expanded package tests failed.' }
    } finally {
        Pop-Location
    }

    $archiveItem = Get-Item -LiteralPath $temporaryArchivePath
    $archiveHash = (Get-FileHash -LiteralPath $temporaryArchivePath -Algorithm SHA256).Hash
    $guideItem = Get-Item -LiteralPath $temporaryGuidePath
    $readmeItem = Get-Item -LiteralPath $temporaryReadmePath
    $manifest = [ordered]@{
        package = $packageName
        version = $Version
        audience = 'external-new-upgrade-repair-distribution'
        source_computer_runtime_relevant = $false
        architecture = 'authorized-feishu-p2p -> fixed-local-controller -> exact-turn-reply'
        built_utc = [DateTime]::UtcNow.ToString('o')
        archive = [ordered]@{
            file = $archiveName
            bytes = $archiveItem.Length
            sha256 = $archiveHash
        }
        standalone_guide = [ordered]@{
            file = $guideName
            bytes = $guideItem.Length
            sha256 = (Get-FileHash -LiteralPath $temporaryGuidePath -Algorithm SHA256).Hash
        }
        standalone_readme = [ordered]@{
            file = $readmeName
            bytes = $readmeItem.Length
            sha256 = (Get-FileHash -LiteralPath $temporaryReadmePath -Algorithm SHA256).Hash
        }
        smoke_test = [ordered]@{
            extracted_file_count = $entries.Count
            npm_ci = 'passed'
            syntax_check = 'passed'
            automated_tests = 'passed'
            bootstrap_prerequisites_included = $true
            new_install_included = $true
            preserve_config_upgrade_included = $true
            repair_install_included = $true
            private_runtime_preserved_by_upgrade = $true
            external_content_scan = 'passed'
            fresh_install_requires_network = $true
            private_runtime_required_for_package_test = $false
        }
        entries = $entries
    }
    $temporaryManifestPath = Join-Path $releaseRoot $manifestName
    $temporaryHashPath = Join-Path $releaseRoot "$archiveName.sha256"
    [IO.File]::WriteAllText(
        $temporaryManifestPath,
        (($manifest | ConvertTo-Json -Depth 8) + "`n"),
        $utf8WithoutBom
    )
    [IO.File]::WriteAllText(
        $temporaryHashPath,
        "$archiveHash  $archiveName`n",
        [Text.Encoding]::ASCII
    )

    Move-Item -LiteralPath $releaseRoot -Destination $OutputDirectory
    $publishedByThisRun = $true

    $publishedNames = @(
        Get-ChildItem -LiteralPath $OutputDirectory -File -Force |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
    $expectedPublishedNames = @(
        $archiveName,
        "$archiveName.sha256",
        $manifestName,
        $guideName,
        $readmeName
    ) | Sort-Object
    if (@(Compare-Object -ReferenceObject $expectedPublishedNames -DifferenceObject $publishedNames).Count -ne 0) {
        throw 'Published release file set does not match the expected artifact set.'
    }

    $publishedArchivePath = Join-Path $OutputDirectory $archiveName
    $publishedArchiveHash = (Get-FileHash -LiteralPath $publishedArchivePath -Algorithm SHA256).Hash
    $publishedManifest = Get-Content -LiteralPath (Join-Path $OutputDirectory $manifestName) -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
        $publishedArchiveHash -ne $archiveHash -or
        [string]$publishedManifest.version -ne $Version -or
        [string]$publishedManifest.audience -ne 'external-new-upgrade-repair-distribution' -or
        [bool]$publishedManifest.source_computer_runtime_relevant -ne $false -or
        [string]$publishedManifest.archive.sha256 -ne $publishedArchiveHash -or
        @($publishedManifest.entries).Count -ne $entries.Count
    ) {
        throw 'Published archive or manifest read-back failed.'
    }
    foreach ($standaloneField in @('standalone_guide', 'standalone_readme')) {
        $standalone = $publishedManifest.$standaloneField
        $standalonePath = Join-Path $OutputDirectory ([string]$standalone.file)
        if (
            -not (Test-Path -LiteralPath $standalonePath -PathType Leaf) -or
            (Get-FileHash -LiteralPath $standalonePath -Algorithm SHA256).Hash -ne [string]$standalone.sha256
        ) {
            throw "Published $standaloneField read-back failed."
        }
    }
    $releaseVerified = $true

    [ordered]@{
        ok = $true
        package = $packageName
        version = $Version
        entries = $entries.Count
        archive = (Join-Path $OutputDirectory $archiveName)
        bytes = $archiveItem.Length
        sha256 = $publishedArchiveHash
        manifest = (Join-Path $OutputDirectory $manifestName)
        guide = (Join-Path $OutputDirectory $guideName)
        readme = (Join-Path $OutputDirectory $readmeName)
        extracted_smoke_test = 'passed'
        published_readback = 'passed'
    } | ConvertTo-Json -Depth 4
} finally {
    if (Test-Path -LiteralPath $workRoot) {
        $resolvedCleanupPath = [IO.Path]::GetFullPath($workRoot)
        if (-not $resolvedCleanupPath.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing unsafe temporary package cleanup.'
        }
        Remove-Item -LiteralPath $resolvedCleanupPath -Recurse -Force
    }
    if ($publishedByThisRun -and -not $releaseVerified -and (Test-Path -LiteralPath $OutputDirectory)) {
        $resolvedFailedRelease = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd([char[]]@('\', '/'))
        if (-not $resolvedFailedRelease.Equals($OutputDirectory, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing unsafe failed-release cleanup.'
        }
        Remove-Item -LiteralPath $resolvedFailedRelease -Recurse -Force
    }
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function readScript(name) {
  return readFile(new URL(name, import.meta.url), "utf8");
}

test("startup retries refreshed authentication and ignores a live duplicate", async () => {
  const [script, identityScript, packageMetadata] = await Promise.all([
    readScript("start-bridge.ps1"),
    readScript("bridge-process-identity.ps1"),
    readScript("package.json"),
  ]);

  assert.match(script, /status = 'already_running'/);
  assert.match(script, /bridge-process-identity\.ps1/);
  assert.match(script, /Get-BridgeProcessIdentity/);
  assert.match(script, /\$existingIdentity -eq 'bridge'/);
  assert.match(script, /\$existingIdentity -eq 'unknown'/);
  assert.match(identityScript, /Get-CimInstance/);
  assert.match(identityScript, /Win32_Process/);
  assert.match(identityScript, /\[regex\]::Escape\(\$expectedBridgeScript\)/);
  assert.match(identityScript, /return 'unknown'/);
  assert.match(
    packageMetadata,
    /"start": "powershell\.exe .*start-bridge\.ps1 -Foreground"/,
  );
  assert.match(script, /\$preflightAttempts = 3/);
  assert.match(script, /\$bridgeScript --preflight/);
  assert.match(script, /Start-Sleep -Seconds 2/);
  assert.match(script, /-PassThru/);
  assert.match(script, /\[switch\]\$Foreground/);
  assert.match(script, /-Wait/);

  const identityPath = fileURLToPath(
    new URL("bridge-process-identity.ps1", import.meta.url),
  ).replaceAll("'", "''");
  const probe = String.raw`
. '${identityPath}'
$node = 'C:\Program Files\nodejs\node.exe'
$bridge = 'C:\Program Files\Codex Bridge\bridge.mjs'
$cases = [ordered]@{
  non_node = Test-BridgeCommandLineIdentity -ProcessName 'notepad.exe' -CommandLine '"C:\Windows\notepad.exe"' -NodeExecutable $node -BridgeScript $bridge
  other_node = Test-BridgeCommandLineIdentity -ProcessName 'node.exe' -CommandLine '"C:\Program Files\nodejs\node.exe" "C:\other.mjs"' -NodeExecutable $node -BridgeScript $bridge
  exact_quoted = Test-BridgeCommandLineIdentity -ProcessName 'node.exe' -CommandLine '"C:\Program Files\nodejs\node.exe" "C:\Program Files\Codex Bridge\bridge.mjs"' -NodeExecutable $node -BridgeScript $bridge
  exact_case_insensitive = Test-BridgeCommandLineIdentity -ProcessName 'NODE.EXE' -CommandLine '"C:\Program Files\nodejs\node.exe" "C:\PROGRAM FILES\CODEX BRIDGE\BRIDGE.MJS"' -NodeExecutable $node -BridgeScript $bridge
  suffix = Test-BridgeCommandLineIdentity -ProcessName 'node.exe' -CommandLine '"C:\Program Files\nodejs\node.exe" "C:\Program Files\Codex Bridge\bridge.mjs.bak"' -NodeExecutable $node -BridgeScript $bridge
  unreadable = Test-BridgeCommandLineIdentity -ProcessName 'node.exe' -CommandLine '' -NodeExecutable $node -BridgeScript $bridge
}
$cases | ConvertTo-Json -Compress
`;
  const identityProbe = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", probe],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(
    identityProbe.status,
    0,
    identityProbe.stderr || identityProbe.stdout,
  );
  assert.deepEqual(JSON.parse(identityProbe.stdout), {
    non_node: "other",
    other_node: "other",
    exact_quoted: "bridge",
    exact_case_insensitive: "bridge",
    suffix: "other",
    unreadable: "unknown",
  });
});

test("startup task survives battery use and retries launcher failures", async () => {
  const script = await readScript("install-startup-task.ps1");

  assert.match(script, /\$trigger\.Delay = 'PT15S'/);
  assert.match(script, /run-bridge-hidden\.js/);
  assert.match(script, /System32\\wscript\.exe/);
  assert.match(script, /\/\/E:JScript/);
  assert.match(script, /\/\/B \/\/NoLogo/);
  assert.doesNotMatch(script, /New-ScheduledTaskAction -Execute 'powershell\.exe'/);
  assert.match(script, /-RestartCount 3/);
  assert.match(script, /-RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /-AllowStartIfOnBatteries/);
  assert.match(script, /-DontStopIfGoingOnBatteries/);
});

test("windowless launcher waits for the hidden bridge host", async () => {
  const script = await readScript("run-bridge-hidden.js");

  assert.match(script, /start-bridge\.ps1/);
  assert.match(script, /-WindowStyle Hidden/);
  assert.match(script, /-Foreground/);
  assert.match(script, /shell\.Run\(command, 0, true\)/);
  assert.match(script, /WScript\.Quit\(exitCode\)/);
});

test("new-computer setup creates only the fixed relay configuration", async () => {
  const script = await readScript("prepare-new-computer.ps1");

  assert.match(script, /\$FixedControllerThreadId/);
  assert.match(script, /\$FixedControllerWorkingDirectory/);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\][\s\S]*\$FixedControllerWorkingDirectory/);
  assert.match(script, /fixedControllerThreadId = \$FixedControllerThreadId/);
  assert.match(script, /codexWorkingDirectory = \$controllerWorkingDirectory/);
  assert.match(script, /fixedControllerDesktopVisibility = 'require'/);
  assert.match(script, /\$DesktopNativeControllerReadbackConfirmed/);
  assert.match(script, /Desktop-native task was created\/listed\/read back/);
  assert.match(script, /identities\.user\.status -ne 'ready'/);
  assert.match(script, /\$larkCliExecutable skills list --json/);
  assert.match(script, /npm\.cmd/);
  assert.match(script, /config get prefix/);
  assert.match(script, /lark-doc/);
  assert.match(script, /lark-task/);
  assert.match(script, /lark-minutes/);
  assert.match(script, /Get-ScheduledTask -TaskName 'Codex-Lark-IM-Bridge'/);
  assert.match(script, /System32\\wscript\.exe/);
  assert.match(script, /run-bridge-hidden\\\.js/);
  assert.match(script, /Copy-Item -LiteralPath \$backupPath -Destination \$configPath -Force/);
  assert.match(script, /Remove-Item -LiteralPath \$configPath -Force/);
  assert.doesNotMatch(script, /task:task:read|task:task:write/);
  assert.doesNotMatch(script, /enableSecretaryInvestigation|enableCodexJobs/);
});

test("fresh-computer bootstrap uses the official installer only when explicitly requested", async () => {
  const script = await readScript("bootstrap-prerequisites.ps1");

  assert.match(script, /\[switch\]\$InstallLarkTooling/);
  assert.match(script, /if \(\$InstallLarkTooling\)/);
  assert.match(script, /'@larksuite\/cli@latest' install/);
  assert.match(script, /--yes skills add larksuite\/cli -g -y/);
  assert.match(script, /skills list --json/);
  assert.match(script, /bot_identity_ready/);
  assert.match(script, /user_oauth_identity_ready/);
  assert.match(script, /lark_skill_prerequisites_ready/);
  assert.match(script, /transport_preflight_required/);
  assert.match(script, /resource_operation_readback_required/);
  for (const skill of [
    "lark-shared",
    "lark-event",
    "lark-im",
    "lark-doc",
    "lark-drive",
    "lark-task",
    "lark-vc",
    "lark-minutes",
    "lark-note",
  ]) {
    assert.match(script, new RegExp(skill));
  }
  assert.doesNotMatch(script, /config init|auth login/);
});

test("main bridge enforces the configured controller cwd on every target operation", async () => {
  const script = await readScript("bridge.mjs");
  const matches = script.match(/expectedCwd: config\.codexWorkingDirectory/g) || [];

  assert.equal(matches.length, 5);
  assert.match(script, /fixedControllerDesktopVisibility: "require"/);
  assert.match(script, /fixedControllerDesktopVisibility === "prefer"/);
  assert.match(script, /allowHeadlessFallback: desktopVisibility === "off"/);
  assert.match(script, /const shutdownController = new AbortController\(\)/);
  assert.match(script, /signal: shutdownController\.signal/);
  assert.match(script, /shutdownController\.abort\(\)/);
  assert.match(script, /relay_paused_for_shutdown/);
  assert.match(script, /onDesktopActivationRequested/);
  assert.match(script, /onDesktopActivationVerified/);
  assert.match(script, /desktopActivationAttempted/);
  assert.match(script, /desktopDeliveryAttemptCount/);
  assert.match(script, /desktopRecoveryRetryAttempted/);
  assert.match(script, /desktopLastDeliveryCode/);
  assert.match(script, /onDesktopRecoveryRetryRequested/);
  assert.match(script, /DESKTOP_OWNER_BUSY_MAX_WAIT_MS/);
  assert.match(script, /desktop_turn_owner_busy_timeout/);
  assert.match(script, /receiptVerified/);
  assert.match(
    script,
    /routed\.kind === "fixed-controller-relay" && failedRecord/,
  );
  assert.match(script, /await finishRelay\(/);
});

test("graceful stop gives aborted in-flight work time to persist for recovery", async () => {
  const script = await readScript("stop-bridge.ps1");

  assert.match(script, /\$stopTimeoutSeconds = 45/);
  assert.match(script, /stop\.request/);
  assert.match(script, /Get-BridgeProcessIdentity/);
  assert.match(script, /removed stale pid file/);
  assert.match(script, /\$pidIdentity -eq 'unknown'/);
  assert.match(script, /Remove-BridgePidFile/);
  assert.match(script, /ItemNotFoundException/);
  assert.doesNotMatch(script, /Remove-Item -LiteralPath \$pidPath/);
  assert.doesNotMatch(script, /Stop-Process|taskkill/);
});

test("graceful stop tolerates the bridge removing its PID during shutdown", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bridge-stop-race-"));
  const profileDirectory = path.join(temporaryRoot, "profile");
  const scriptDirectory = path.join(temporaryRoot, "scripts");
  const runtimeDirectory = path.join(
    profileDirectory,
    ".codex",
    "private",
    "lark-im-codex-bridge",
  );
  const pidPath = path.join(runtimeDirectory, "bridge.pid");

  try {
    await Promise.all([
      mkdir(scriptDirectory, { recursive: true }),
      mkdir(runtimeDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(scriptDirectory, "stop-bridge.ps1"),
        await readScript("stop-bridge.ps1"),
        "utf8",
      ),
      writeFile(
        path.join(scriptDirectory, "bridge-process-identity.ps1"),
        String.raw`$script:BridgeIdentityProbeCount = 0
function Get-BridgeProcessIdentity {
    param(
        [int]$ProcessId,
        [string]$NodeExecutable,
        [string]$BridgeScript
    )
    $script:BridgeIdentityProbeCount += 1
    if ($script:BridgeIdentityProbeCount -eq 1) {
        return 'bridge'
    }
    $runtimeDirectory = Join-Path $env:USERPROFILE '.codex\private\lark-im-codex-bridge'
    Remove-Item -LiteralPath (Join-Path $runtimeDirectory 'bridge.pid') -Force
    return 'other'
}
`,
        "utf8",
      ),
      writeFile(path.join(scriptDirectory, "bridge.mjs"), "", "utf8"),
      writeFile(pidPath, "4242\n", "utf8"),
    ]);

    const stopProbe = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(scriptDirectory, "stop-bridge.ps1"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, USERPROFILE: profileDirectory },
        windowsHide: true,
      },
    );

    assert.equal(stopProbe.status, 0, stopProbe.stderr || stopProbe.stdout);
    assert.deepEqual(JSON.parse(stopProbe.stdout), {
      ok: true,
      status: "stopped",
      detail: "graceful control request completed",
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("health requires fixed-controller-only mode", async () => {
  const script = await readScript("health-check.ps1");

  assert.match(script, /expectedBridgeVersion = '0\.12\.7'/);
  assert.match(script, /expectedStateSchema = 6/);
  assert.match(script, /pendingReplies/);
  assert.match(script, /pending_fixed_relays/);
  assert.match(script, /service_healthy/);
  assert.match(script, /acceptance_clean/);
  assert.match(script, /bridge_pid_identity/);
  assert.match(script, /\$pidAlive = \$pidIdentity -eq 'bridge'/);
  assert.match(script, /\$RequireClean/);
  assert.match(script, /\$WaitSeconds/);
  assert.match(script, /relayMode -eq 'fixed-controller-only'/);
  assert.match(script, /fixedControllerRelayEnabled -eq \$true/);
  assert.match(script, /fixedControllerRelayTargetReadable -eq \$true/);
  assert.match(script, /fixedControllerDesktopVisibility -eq 'require'/);
  assert.doesNotMatch(script, /controller_enabled|existing_task_control_enabled/);
});

test("portable builder is current-only and smoke-tests the extracted package", async () => {
  const script = await readScript("build-portable-package.ps1");

  assert.match(script, /README-FIRST\.md/);
  assert.match(script, /bootstrap-prerequisites\.ps1/);
  assert.match(script, /upgrade-or-repair-existing-computer\.ps1/);
  assert.match(script, /bridge-process-identity\.ps1/);
  assert.match(script, /fixed-controller-relay\.mjs/);
  assert.match(script, /codex-desktop-ipc\.mjs/);
  assert.match(script, /npmExecutable ci/);
  assert.match(script, /npmExecutable run check/);
  assert.match(script, /npmExecutable test/);
  assert.match(script, /standalone_readme/);
  assert.match(script, /audience = 'external-new-upgrade-repair-distribution'/);
  assert.match(script, /source_computer_runtime_relevant = \$false/);
  assert.match(script, /bootstrap_prerequisites_included/);
  assert.match(script, /fresh_install_requires_network/);
  assert.match(script, /private_runtime_required_for_package_test/);
  assert.match(script, /preserve_config_upgrade_included/);
  assert.match(script, /repair_install_included/);
  assert.match(script, /external_content_scan/);
  assert.match(script, /private_thread_uri/);
  assert.match(script, /publishedArchiveHash/);
  assert.match(script, /Refusing unsafe temporary package cleanup/);
  assert.doesNotMatch(
    script,
    /['"]scripts\/(?:codex-control|codex-job-manager|job-registry|secretary-investigation)\.mjs['"]/
  );
});

test("existing-device entry preserves private runtime and replaces public source recoverably", async () => {
  const script = await readScript("upgrade-or-repair-existing-computer.ps1");

  assert.match(script, /ValidateSet\('Upgrade', 'Repair'\)/);
  assert.match(script, /restricted to the canonical bridge path/);
  assert.match(script, /pendingFixedRelays/);
  assert.match(script, /pendingReplies/);
  assert.match(script, /pre-install-inventory\.json/);
  assert.match(script, /source-original/);
  assert.match(script, /failed-candidate/);
  assert.match(script, /startup task did not return to Ready/);
  assert.match(script, /npmExecutable ci/);
  assert.match(script, /npmExecutable run check/);
  assert.match(script, /npmExecutable test/);
  assert.match(script, /npmExecutable run preflight/);
  assert.match(script, /install-startup-task\.ps1/);
  assert.match(script, /health-check\.ps1/);
  assert.match(script, /real_feishu_round_trip = 'required'/);
  assert.doesNotMatch(script, /Stop-Process|taskkill/i);
});

test("PowerShell service scripts parse cleanly", () => {
  for (const name of [
    "build-portable-package.ps1",
    "bridge-process-identity.ps1",
    "bootstrap-prerequisites.ps1",
    "health-check.ps1",
    "start-bridge.ps1",
    "stop-bridge.ps1",
    "install-startup-task.ps1",
    "prepare-new-computer.ps1",
    "upgrade-or-repair-existing-computer.ps1",
    "uninstall-startup-task.ps1",
  ]) {
    const scriptPath = fileURLToPath(new URL(name, import.meta.url));
    const escapedPath = scriptPath.replaceAll("'", "''");
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$source = Get-Content -LiteralPath '${escapedPath}' -Raw -Encoding UTF8; ` +
          "[void][scriptblock]::Create($source)",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(
      result.status,
      0,
      `${name} failed to parse: ${result.stderr || result.stdout}`,
    );
  }
});

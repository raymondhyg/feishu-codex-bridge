import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bridgeProcessIdentity } from "./bridge-service.mjs";

const EXPECTED_BRIDGE_VERSION = "0.13.0";
const EXPECTED_STATE_SCHEMA = 6;
const EVENT_KEY = "im.message.receive_v1";
const runtimeDirectory = path.join(
  homedir(),
  ".codex",
  "private",
  "lark-im-codex-bridge",
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    return fallback;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function eventStatus(config) {
  const command = config?.larkCliScript ? process.execPath : "lark-cli";
  const prefix = config?.larkCliScript ? [config.larkCliScript] : [];
  try {
    const result = await run(command, [...prefix, "event", "status", "--json"]);
    if (result.code !== 0) return { consumers: [], error: "event_status_failed" };
    const parsed = JSON.parse(result.stdout || result.stderr);
    const consumers = (parsed.apps || [])
      .flatMap((app) => app.consumers || [])
      .filter((consumer) => consumer.event_key === EVENT_KEY);
    return { consumers };
  } catch (error) {
    return { consumers: [], error: error?.code === "ENOENT" ? "lark_cli_missing" : "event_status_failed" };
  }
}

async function readReadyRecord(logPath, pid) {
  try {
    const lines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).slice(-200);
    let record = null;
    for (const line of lines) {
      try {
        const candidate = JSON.parse(line);
        if (candidate.event === "listener_ready" && Number(candidate.bridgePid) === pid) {
          record = candidate;
        }
      } catch {
        // A partially written final line is not readiness evidence.
      }
    }
    return record;
  } catch {
    return null;
  }
}

export async function collectHealth() {
  const config = await readJson(path.join(runtimeDirectory, "config.json"));
  const state = await readJson(path.join(runtimeDirectory, "state.json"));
  let pid = null;
  try {
    pid = Number((await readFile(path.join(runtimeDirectory, "bridge.pid"), "utf8")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) pid = null;
  } catch {
    pid = null;
  }
  const pidIdentity = pid ? await bridgeProcessIdentity(pid) : "absent";
  const ready = await readReadyRecord(path.join(runtimeDirectory, "bridge.log.jsonl"), pid);
  const status = await eventStatus(config);
  const consumers = status.consumers || [];
  const pendingRelayCount = Object.keys(state?.pendingFixedRelays || {}).length;
  const pendingReplyCount = Object.keys(state?.pendingReplies || {}).length;
  const serviceHealthy = Boolean(
    consumers.length === 1 &&
      pid &&
      pidIdentity === "bridge" &&
      ready &&
      ready.bridgeVersion === EXPECTED_BRIDGE_VERSION &&
      ready.relayMode === "fixed-controller-only" &&
      ready.fixedControllerRelayEnabled === true &&
      ready.fixedControllerRelayTargetReadable === true &&
      ready.fixedControllerDesktopVisibility === "require" &&
      ready.fixedControllerRuntimeSandbox === "danger-full-access" &&
      ready.fixedControllerRuntimeApprovalPolicy === "never" &&
      Number(state?.version) === EXPECTED_STATE_SCHEMA,
  );
  const acceptanceClean = serviceHealthy && pendingRelayCount === 0 && pendingReplyCount === 0;
  return {
    ok: serviceHealthy,
    service_healthy: serviceHealthy,
    acceptance_clean: acceptanceClean,
    bridge_pid: pid,
    bridge_pid_alive: pidIdentity === "bridge",
    bridge_pid_identity: pidIdentity,
    bridge_version: ready?.bridgeVersion ?? null,
    expected_bridge_version: EXPECTED_BRIDGE_VERSION,
    state_schema: state?.version ?? null,
    relay_mode: ready?.relayMode ?? null,
    fixed_controller_target_readable: ready?.fixedControllerRelayTargetReadable ?? null,
    fixed_controller_target_title: state?.fixedControllerRelay?.targetTitle ?? null,
    desktop_visibility: ready?.fixedControllerDesktopVisibility ?? null,
    last_transport: state?.fixedControllerRelay?.lastTransport ?? null,
    last_desktop_live_visible: state?.fixedControllerRelay?.lastDesktopLiveVisible ?? null,
    last_turn_started_at: state?.fixedControllerRelay?.lastTurnStartedAt ?? null,
    runtime_sandbox: ready?.fixedControllerRuntimeSandbox ?? null,
    runtime_approval_policy: ready?.fixedControllerRuntimeApprovalPolicy ?? null,
    pending_fixed_relays: pendingRelayCount,
    pending_replies: pendingReplyCount,
    active_consumers: consumers.length,
    received: consumers.length === 1 ? consumers[0].received ?? null : null,
    dropped: consumers.length === 1 ? consumers[0].dropped ?? null : null,
    state_present: state !== null,
    transport_diagnostic: status.error ?? null,
  };
}

async function main() {
  const requireClean = process.argv.includes("--require-clean");
  const waitArgument = process.argv.find((value) => value.startsWith("--wait-seconds="));
  const waitSeconds = waitArgument ? Math.max(0, Math.min(120, Number(waitArgument.split("=")[1]) || 0)) : 0;
  const deadline = Date.now() + waitSeconds * 1000;
  let result;
  do {
    result = await collectHealth();
    if (result.service_healthy && (!requireClean || result.acceptance_clean)) break;
    if (Date.now() >= deadline) break;
    await delay(2000);
  } while (true);
  console.log(JSON.stringify(result, null, 2));
  if (!result.service_healthy || (requireClean && !result.acceptance_clean)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}

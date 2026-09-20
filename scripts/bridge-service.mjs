import { spawn } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bridgeScript = path.join(scriptDirectory, "bridge.mjs");
const runtimeDirectory = path.join(
  homedir(),
  ".codex",
  "private",
  "lark-im-codex-bridge",
);
const pidPath = path.join(runtimeDirectory, "bridge.pid");
const stopRequestPath = path.join(runtimeDirectory, "stop.request");
const stdoutPath = path.join(runtimeDirectory, "service.stdout.log");
const stderrPath = path.join(runtimeDirectory, "service.stderr.log");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || scriptDirectory,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readPid() {
  try {
    const value = Number((await readFile(pidPath, "utf8")).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function bridgeProcessIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "invalid";
  const runner = options.run || run;
  const result = await runner("/bin/ps", ["-p", String(pid), "-o", "command="]);
  if (result.code !== 0 || !result.stdout.trim()) return "absent";
  const command = result.stdout.trim();
  const expectedBridge = path.resolve(options.bridgeScript || bridgeScript);
  const escapedBridge = expectedBridge.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactBridgeArgument = new RegExp(`(?:^|\\s)["']?${escapedBridge}["']?(?:\\s|$)`);
  return exactBridgeArgument.test(command) && /(^|\/)node(?:\s|$)/.test(command)
    ? "bridge"
    : "other";
}

async function preflight() {
  let lastResult;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = await run(process.execPath, [bridgeScript, "--preflight"]);
    if (lastResult.code === 0) return attempt;
    if (attempt < 3) await delay(2000);
  }
  const lastLine = `${lastResult?.stderr || ""}\n${lastResult?.stdout || ""}`
    .trim()
    .split(/\r?\n/)
    .at(-1);
  throw new Error(`Bridge preflight failed after 3 attempts: ${lastLine || "unknown error"}`);
}

export async function startBridge(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The Node service controller is currently supported on macOS only");
  }
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const existingPid = await readPid();
  if (existingPid) {
    const identity = await bridgeProcessIdentity(existingPid);
    if (identity === "bridge") {
      return { ok: true, status: "already_running", bridge_pid: existingPid };
    }
    if (identity === "other") {
      throw new Error("Existing bridge PID belongs to another process");
    }
    await rm(pidPath, { force: true });
  }

  const preflightAttempts = await preflight();
  if (options.foreground) {
    const child = spawn(process.execPath, [bridgeScript], {
      cwd: scriptDirectory,
      env: process.env,
      stdio: "inherit",
    });
    return new Promise((resolve) => {
      child.once("exit", (code) =>
        resolve({ ok: code === 0, status: "exited", exit_code: code }),
      );
    });
  }

  const stdoutHandle = await open(stdoutPath, "a", 0o600);
  const stderrHandle = await open(stderrPath, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [bridgeScript], {
      cwd: scriptDirectory,
      env: process.env,
      detached: true,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
    });
    child.unref();
  } finally {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  }
  return {
    ok: true,
    status: "launched",
    bridge_pid: child.pid,
    preflight_attempts: preflightAttempts,
  };
}

export async function stopBridge(options = {}) {
  const timeoutMs = Number(options.timeoutMs || 45_000);
  const pid = await readPid();
  if (!pid) return { ok: true, status: "stopped", detail: "no pid file" };
  const identity = await bridgeProcessIdentity(pid);
  if (identity === "other") {
    throw new Error("Existing bridge PID belongs to another process");
  }
  if (identity !== "bridge") {
    await Promise.all([rm(pidPath, { force: true }), rm(stopRequestPath, { force: true })]);
    return { ok: true, status: "stopped", detail: "removed stale pid file" };
  }

  await writeFile(stopRequestPath, `${new Date().toISOString()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(250);
    const currentPid = await readPid();
    if (!currentPid) {
      return { ok: true, status: "stopped", detail: "graceful control request completed" };
    }
    const currentIdentity = await bridgeProcessIdentity(currentPid);
    if (currentIdentity === "other") {
      throw new Error("Bridge PID changed to another process while stopping");
    }
    if (currentIdentity !== "bridge") {
      await rm(pidPath, { force: true });
      return { ok: true, status: "stopped", detail: "bridge exited" };
    }
  }
  return { ok: false, status: "timeout", detail: `bridge did not stop in ${timeoutMs} ms` };
}

async function main() {
  const command = process.argv[2];
  let result;
  if (command === "start") {
    result = await startBridge({ foreground: process.argv.includes("--foreground") });
  } else if (command === "stop") {
    result = await stopBridge();
  } else {
    throw new Error("Usage: node bridge-service.mjs <start|stop> [--foreground]");
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}

import { spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const runtimeDirectory = path.join(homedir(), ".codex", "private", "lark-im-codex-bridge");
const configPath = path.join(runtimeDirectory, "config.json");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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

async function verifiedUserOpenId() {
  const result = await run("lark-cli", ["auth", "status", "--json", "--verify"]);
  let status;
  try {
    status = JSON.parse(result.stdout || result.stderr);
  } catch {
    throw new Error("lark-cli returned invalid identity status");
  }
  const openId = String(status?.identities?.user?.openId || "").trim();
  if (result.code !== 0 || status?.verified !== true || status?.identities?.bot?.status !== "ready" || status?.identities?.user?.status !== "ready" || !/^ou_[A-Za-z0-9_-]+$/.test(openId)) {
    throw new Error("Verified bot and user identities are required before Mac setup");
  }
  return openId;
}

async function resolveExecutable(name) {
  const candidates = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error(`${name} was not found on PATH`);
}

export function buildMacConfig({ threadId, workingDirectory, allowedSenderId, codexCliScript, larkCliScript }) {
  if (!THREAD_ID.test(String(threadId || ""))) throw new Error("One exact Codex thread ID is required");
  const cwd = path.resolve(String(workingDirectory || ""));
  if (!path.isAbsolute(cwd)) throw new Error("An absolute controller working directory is required");
  if (!/^ou_[A-Za-z0-9_-]+$/.test(String(allowedSenderId || ""))) throw new Error("One verified sender open_id is required");
  return {
    allowedSenderIds: [allowedSenderId],
    fixedControllerThreadId: threadId,
    fixedControllerDesktopVisibility: "require",
    runtimeDirectory,
    codexWorkingDirectory: cwd,
    attachmentRoot: path.join(runtimeDirectory, "attachments"),
    maxAttachmentBytes: 52_428_800,
    maxAttachmentTotalBytes: 104_857_600,
    codexControllerTurnTimeoutSeconds: 1800,
    maxReplyChars: 12000,
    ...(codexCliScript ? { codexCliScript } : {}),
    ...(larkCliScript ? { larkCliScript } : {}),
  };
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Mac setup requires macOS");
  const threadId = String(process.argv[2] || "").trim();
  const workingDirectory = String(process.argv[3] || "").trim();
  const allowedSenderId = await verifiedUserOpenId();
  const [codexCliScript, larkCliScript] = await Promise.all([
    resolveExecutable("codex"),
    resolveExecutable("lark-cli"),
  ]);
  const config = buildMacConfig({
    threadId,
    workingDirectory,
    allowedSenderId,
    codexCliScript,
    larkCliScript,
  });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  try {
    await readFile(configPath, "utf8");
    await rename(configPath, `${configPath}.backup-${Date.now()}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, configPath);
  console.log(JSON.stringify({
    ok: true,
    status: "configured",
    sender_count: 1,
    fixed_controller_bound: true,
    controller_cwd_verified_absolute: true,
    private_config_path: configPath,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}

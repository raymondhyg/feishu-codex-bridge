import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const runtimeDirectory = path.join(
  homedir(),
  ".codex",
  "private",
  "lark-im-codex-bridge",
);
const configPath =
  process.env.LARK_CODEX_BRIDGE_CONFIG ||
  path.join(runtimeDirectory, "config.json");
const current = JSON.parse(await readFile(configPath, "utf8"));
const explicitlyRequestedThreadId = String(
  process.env.LARK_CODEX_FIXED_CONTROLLER_THREAD_ID || process.argv[2] || "",
).trim();
const explicitlyRequestedCwd = String(
  process.env.LARK_CODEX_FIXED_CONTROLLER_CWD || process.argv[3] || "",
).trim();
const threadId = String(
  explicitlyRequestedThreadId ||
    current.fixedControllerThreadId ||
    "",
).trim();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
  throw new Error(
    "Provide one exact Codex thread id or retain a valid private binding in config.json.",
  );
}
if (
  !Array.isArray(current.allowedSenderIds) ||
  current.allowedSenderIds.length === 0
) {
  throw new Error("The private config must contain allowedSenderIds.");
}
if (
  explicitlyRequestedThreadId &&
  explicitlyRequestedThreadId !== current.fixedControllerThreadId &&
  !explicitlyRequestedCwd
) {
  throw new Error(
    "Rebinding to a different fixed controller requires its exact working directory.",
  );
}

const controllerCwd = String(
  explicitlyRequestedCwd ||
    current.codexWorkingDirectory ||
    path.join(runtimeDirectory, "workspace"),
).trim();
if (!path.isAbsolute(controllerCwd)) {
  throw new Error("The fixed controller working directory must be absolute.");
}
let controllerCwdStat;
try {
  controllerCwdStat = await stat(controllerCwd);
} catch {
  throw new Error("The fixed controller working directory does not exist.");
}
if (!controllerCwdStat.isDirectory()) {
  throw new Error("The fixed controller working directory is not a directory.");
}

const next = {
  allowedSenderIds: current.allowedSenderIds,
  fixedControllerThreadId: threadId,
  fixedControllerDesktopVisibility:
    current.fixedControllerDesktopVisibility === "off" ? "off" : "require",
  runtimeDirectory: current.runtimeDirectory || runtimeDirectory,
  codexWorkingDirectory: controllerCwd,
  attachmentRoot:
    current.attachmentRoot || path.join(runtimeDirectory, "attachments"),
  maxAttachmentBytes: current.maxAttachmentBytes || 52_428_800,
  maxAttachmentTotalBytes:
    current.maxAttachmentTotalBytes || 104_857_600,
  codexControllerTurnTimeoutSeconds:
    current.codexControllerTurnTimeoutSeconds || 1800,
  maxReplyChars: current.maxReplyChars || 12000,
};
for (const optionalPath of ["larkCliScript", "codexCliScript"]) {
  if (typeof current[optionalPath] === "string" && current[optionalPath]) {
    next[optionalPath] = current[optionalPath];
  }
}

const temporaryPath = `${configPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
await rename(temporaryPath, configPath);

console.log(
  JSON.stringify({
    ok: true,
    relayMode: "fixed-controller-only",
    fixedControllerThreadConfigured: true,
    fixedControllerWorkingDirectoryConfigured: true,
    currentFieldCount: Object.keys(next).length,
    configPath,
  }),
);

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  advanceFixedControllerOwnerBusyRetry,
  clearFixedControllerOwnerBusyRetry,
  commandReply,
  EVENT_KEY,
  failureReceipt,
  fixedControllerStartReconcileExpired,
  idempotencyKey,
  initialState,
  normalizeState,
  pruneState,
  routeEvent,
  sanitizeBridgeDiagnostic,
  truncateReply,
  validateConfig,
} from "./bridge-core.mjs";
import {
  CodexAppServerClient,
  codexThreadStatus,
  codexThreadTitle,
  getCodexCliVersion,
  resolveCodexCli,
} from "./codex-app-server.mjs";
import {
  buildFixedControllerAppServerArgs,
  buildFixedControllerAttachmentInput,
  findFixedControllerTurnByClientMessageId,
  FIXED_CONTROLLER_RUNTIME_APPROVAL_POLICY,
  FIXED_CONTROLLER_RUNTIME_SANDBOX,
  startFixedControllerTurnPreferDesktop,
  verifyFixedControllerTarget,
  waitForFixedControllerTurn,
} from "./fixed-controller-relay.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_VERSION = "0.12.7";
const RELAY_MODE = "fixed-controller-only";
const FIXED_CONTROLLER_QUEUE_KEY = "__fixed_controller__";
const START_RECONCILE_TIMEOUT_MS = 60_000;
const DESKTOP_OWNER_BUSY_MAX_WAIT_MS = 5 * 60 * 1000;
const DESKTOP_OWNER_BUSY_MAX_RETRIES = 300;
const defaultRuntimeDirectory = path.join(
  homedir(),
  ".codex",
  "private",
  "lark-im-codex-bridge",
);
const configPath =
  process.env.LARK_CODEX_BRIDGE_CONFIG ||
  path.join(defaultRuntimeDirectory, "config.json");
let activePidPath;

function timestamp() {
  return new Date().toISOString();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) {
    const error = new Error("bridge shutdown requested");
    error.code = "aborted";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("bridge shutdown requested");
      error.code = "aborted";
      reject(error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquirePidLock(pidPath) {
  await mkdir(path.dirname(pidPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(pidPath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      activePidPath = pidPath;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existingPid = Number((await readFile(pidPath, "utf8")).trim());
      try {
        process.kill(existingPid, 0);
        throw new Error(`Bridge is already running with pid ${existingPid}`);
      } catch (probeError) {
        if (probeError?.code !== "ESRCH") throw probeError;
        await rm(pidPath, { force: true });
      }
    }
  }
  throw new Error("Unable to acquire bridge process lock");
}

async function releasePidLock() {
  if (!activePidPath) return;
  await rm(activePidPath, { force: true });
  activePidPath = undefined;
}

async function loadConfig() {
  const source = await readJson(configPath, null);
  const config = {
    fixedControllerDesktopVisibility: "require",
    maxAttachmentBytes: 52_428_800,
    maxAttachmentTotalBytes: 104_857_600,
    codexControllerTurnTimeoutSeconds: 1800,
    maxReplyChars: 12000,
    ...source,
  };
  if (config.fixedControllerDesktopVisibility === "prefer") {
    config.fixedControllerDesktopVisibility = "require";
  }
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(
      `Invalid relay config at ${configPath}: ${errors.join("; ")}`,
    );
  }
  return config;
}

async function resolveLarkCli(config) {
  if (config.larkCliScript) {
    await access(config.larkCliScript, fsConstants.R_OK);
    return { command: process.execPath, prefix: [config.larkCliScript] };
  }
  if (process.platform !== "win32") {
    return { command: "lark-cli", prefix: [] };
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const shim = path.join(directory, "lark-cli.cmd");
    const runScript = path.join(
      directory,
      "node_modules",
      "@larksuite",
      "cli",
      "scripts",
      "run.js",
    );
    try {
      await Promise.all([
        access(shim, fsConstants.R_OK),
        access(runScript, fsConstants.R_OK),
      ]);
      return { command: process.execPath, prefix: [runScript] };
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error(
    "Unable to resolve lark-cli. Install it or set larkCliScript.",
  );
}

function createLogger(logPath) {
  return async (level, event, fields = {}) => {
    const record = { time: timestamp(), level, event, ...fields };
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
    const summary = `[${record.time}] ${level.toUpperCase()} ${event}`;
    if (level === "error") console.error(summary);
    else console.log(summary);
  };
}

function runProcess(command, args, options = {}) {
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
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonOutput(result, action) {
  let value;
  try {
    value = JSON.parse(result.stdout || result.stderr);
  } catch {
    throw new Error(
      `${action} returned non-JSON output (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
  if (result.code !== 0 || value?.ok === false) {
    const error = value?.error || {};
    const detail = [
      error.type,
      error.subtype,
      error.message,
      error.hint,
      Array.isArray(error.missing_scopes)
        ? `missing scopes: ${error.missing_scopes.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" | ");
    throw new Error(`${action} failed: ${detail || `exit ${result.code}`}`);
  }
  return value;
}

function larkEnvironment() {
  return {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
}

async function runLark(lark, args, config) {
  return runProcess(lark.command, [...lark.prefix, ...args], {
    cwd: config.runtimeDirectory,
    env: larkEnvironment(),
  });
}

function ensureWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Attachment path escaped its configured root");
  }
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(candidate)));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

function attachmentChatKey(chatId) {
  return createHash("sha256").update(chatId).digest("hex").slice(0, 16);
}

async function fetchAttachmentMessage(routed, config, lark) {
  const date = new Date().toISOString().slice(0, 10);
  const messageDirectory = path.join(
    config.attachmentRoot,
    attachmentChatKey(routed.chatId),
    date,
    routed.messageId,
  );
  ensureWithin(config.attachmentRoot, messageDirectory);
  await mkdir(messageDirectory, { recursive: true });

  const result = parseJsonOutput(
    await runProcess(
      lark.command,
      [
        ...lark.prefix,
        "im",
        "+messages-mget",
        "--as",
        "bot",
        "--message-ids",
        routed.messageId,
        "--download-resources",
        "--no-reactions",
        "--json",
      ],
      {
        cwd: messageDirectory,
        env: larkEnvironment(),
      },
    ),
    "lark message attachment fetch",
  );
  const message = result.data?.messages?.[0];
  if (!message) throw new Error("Attachment message was not returned");

  const files = (await listFiles(messageDirectory)).filter(
    (filePath) => path.basename(filePath) !== "manifest.json",
  );
  const resources = [];
  let totalBytes = 0;
  for (const filePath of files) {
    ensureWithin(config.attachmentRoot, filePath);
    const details = await stat(filePath);
    if (details.size > config.maxAttachmentBytes) {
      await rm(messageDirectory, { recursive: true, force: true });
      throw new Error(
        `Attachment exceeds per-file limit (${config.maxAttachmentBytes} bytes)`,
      );
    }
    totalBytes += details.size;
    resources.push({
      path: filePath,
      relativePath: path.relative(config.attachmentRoot, filePath),
      sizeBytes: details.size,
    });
  }
  if (totalBytes > config.maxAttachmentTotalBytes) {
    await rm(messageDirectory, { recursive: true, force: true });
    throw new Error(
      `Attachments exceed total limit (${config.maxAttachmentTotalBytes} bytes)`,
    );
  }

  const resourceTypes = new Map(
    (message.resources || []).map((resource) => [
      path.basename(resource.local_path || ""),
      resource.type,
    ]),
  );
  const manifest = {
    version: 1,
    sourceMessageId: routed.messageId,
    messageType: message.msg_type || routed.messageType,
    retainedAt: timestamp(),
    totalBytes,
    resources: resources.map((resource) => ({
      relativePath: resource.relativePath,
      sizeBytes: resource.sizeBytes,
      type: resourceTypes.get(path.basename(resource.path)) || "file",
    })),
  };
  await writeJsonAtomic(path.join(messageDirectory, "manifest.json"), manifest);

  const imagePaths = resources
    .filter(
      (resource) =>
        resourceTypes.get(path.basename(resource.path)) === "image" ||
        /\.(png|jpe?g|webp|gif)$/i.test(resource.path),
    )
    .map((resource) => resource.path);
  return {
    text: message.content || routed.text || "",
    imagePaths,
    attachmentPaths: resources.map((resource) => resource.path),
  };
}

async function preflight(config, lark) {
  await Promise.all([
    mkdir(config.runtimeDirectory, { recursive: true }),
    mkdir(config.codexWorkingDirectory, { recursive: true }),
    mkdir(config.attachmentRoot, { recursive: true }),
  ]);
  const auth = parseJsonOutput(
    await runLark(lark, ["auth", "status", "--verify", "--json"], config),
    "lark auth status",
  );
  if (auth.identities?.bot?.status !== "ready") {
    throw new Error(
      `Bot identity is not ready: ${auth.identities?.bot?.message || "unknown"}`,
    );
  }
  const schema = parseJsonOutput(
    await runLark(
      lark,
      ["event", "schema", EVENT_KEY, "--json"],
      config,
    ),
    "lark event schema",
  );
  if (schema.key !== EVENT_KEY) {
    throw new Error(`Unexpected event schema: ${schema.key || "missing key"}`);
  }
  return {
    botReady: true,
    eventKey: schema.key,
    requiredScopes: schema.scopes || [],
    relayMode: RELAY_MODE,
    configPath,
  };
}

function queueByKey(queues, key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    });
  queues.set(key, current);
  return current;
}

async function main() {
  const config = await loadConfig();
  const desktopVisibility = config.fixedControllerDesktopVisibility;
  const lark = await resolveLarkCli(config);
  const codexCli = await resolveCodexCli(config);
  const codexCliVersion = await getCodexCliVersion(
    codexCli,
    config.codexWorkingDirectory,
  );
  const preflightResult = await preflight(config, lark);

  if (process.argv.includes("--preflight")) {
    const appServer = new CodexAppServerClient(codexCli, {
      cwd: config.codexWorkingDirectory,
      clientVersion: `${BRIDGE_VERSION}-preflight`,
      appServerArgs: buildFixedControllerAppServerArgs(),
    });
    let targetReadable = false;
    try {
      await appServer.start();
      await verifyFixedControllerTarget(appServer, {
        threadId: config.fixedControllerThreadId,
        expectedCwd: config.codexWorkingDirectory,
      });
      targetReadable = true;
    } finally {
      await appServer.close().catch(() => {});
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...preflightResult,
          bridgeVersion: BRIDGE_VERSION,
          codexCliVersion,
          fixedControllerRelayEnabled: true,
          fixedControllerTargetReadable: targetReadable,
          fixedControllerDesktopVisibility: desktopVisibility,
          runtimeSandbox: FIXED_CONTROLLER_RUNTIME_SANDBOX,
          runtimeApprovalPolicy: FIXED_CONTROLLER_RUNTIME_APPROVAL_POLICY,
        },
        null,
        2,
      ),
    );
    return;
  }

  const statePath = path.join(config.runtimeDirectory, "state.json");
  const logPath = path.join(config.runtimeDirectory, "bridge.log.jsonl");
  const pidPath = path.join(config.runtimeDirectory, "bridge.pid");
  const stopRequestPath = path.join(config.runtimeDirectory, "stop.request");
  await acquirePidLock(pidPath);
  await rm(stopRequestPath, { force: true });
  const log = createLogger(logPath);
  const state = pruneState(
    normalizeState(await readJson(statePath, initialState())),
  );
  await writeJsonAtomic(statePath, state);

  const appServer = new CodexAppServerClient(codexCli, {
    cwd: config.codexWorkingDirectory,
    clientVersion: BRIDGE_VERSION,
    appServerArgs: buildFixedControllerAppServerArgs(),
  });
  await appServer.start();
  const target = await verifyFixedControllerTarget(appServer, {
    threadId: config.fixedControllerThreadId,
    expectedCwd: config.codexWorkingDirectory,
  });
  const targetReadable = true;
  state.fixedControllerRelay = {
    ...state.fixedControllerRelay,
    enabled: true,
    targetReadable,
    targetTitle: codexThreadTitle(target),
    targetStatus: codexThreadStatus(target),
    desktopVisibilityMode: desktopVisibility,
    verifiedAt: Date.now(),
  };

  const queues = new Map();
  const inFlight = new Set();
  const messageTimings = new Map();
  const shutdownController = new AbortController();
  let shuttingDown = false;

  async function persistState() {
    pruneState(state);
    await writeJsonAtomic(statePath, state);
  }
  await persistState();

  async function reply(messageId, text, phase = "final") {
    const contentFlag = phase === "final" ? "--markdown" : "--text";
    const result = await runLark(
      lark,
      [
        "im",
        "+messages-reply",
        "--as",
        "bot",
        "--message-id",
        messageId,
        contentFlag,
        text,
        "--idempotency-key",
        idempotencyKey(`${messageId}:${phase}`),
        "--json",
      ],
      config,
    );
    return parseJsonOutput(result, "lark message reply");
  }

  async function completeReply(messageId, chatId, text) {
    const replyStartedAt = Date.now();
    state.pendingReplies[messageId] = {
      chatId,
      text,
      createdAt: Date.now(),
    };
    await persistState();
    const result = await reply(messageId, text);
    delete state.pendingReplies[messageId];
    state.processedMessageIds[messageId] = Date.now();
    const timing = messageTimings.get(messageId);
    if (timing) {
      timing.replyMs = Date.now() - replyStartedAt;
      timing.totalMs = Date.now() - timing.startedAt;
      state.lastLatencyByChat[chatId] = {
        totalMs: timing.totalMs,
        replyMs: timing.replyMs,
        attachmentMs: timing.attachmentMs,
        codexMs: timing.codexMs,
        completedAt: Date.now(),
      };
    }
    await persistState();
    await log("info", "reply_sent", {
      messageId,
      totalMs: timing?.totalMs,
      replyMs: timing?.replyMs,
      attachmentMs: timing?.attachmentMs,
      codexMs: timing?.codexMs,
    });
    return result;
  }

  async function prepareRelay(routed) {
    if (!routed.attachment) {
      return { input: String(routed.text || ""), processingSent: false };
    }
    const timing = messageTimings.get(routed.messageId);
    const startedAt = Date.now();
    await reply(
      routed.messageId,
      "收到，附件正在转给本地总控，处理好后我直接回你。",
      "processing",
    );
    const attachment = await fetchAttachmentMessage(routed, config, lark);
    if (timing) timing.attachmentMs = Date.now() - startedAt;
    await log("info", "attachment_retained", {
      messageId: routed.messageId,
      resourceCount: attachment.attachmentPaths.length,
    });
    return {
      input: buildFixedControllerAttachmentInput({
        text: String(attachment.text || routed.text || ""),
        attachmentPaths: attachment.attachmentPaths,
        imagePaths: attachment.imagePaths,
      }),
      processingSent: true,
    };
  }

  async function finishRelay(messageId, chatId, record, text) {
    record.phase = "reply_pending";
    record.finalText = truncateReply(text, config.maxReplyChars);
    record.updatedAt = Date.now();
    await persistState();
    await completeReply(messageId, chatId, record.finalText);
    delete state.pendingFixedRelays[messageId];
    await persistState();
  }

  async function handleRelay(routed) {
    state.pendingFixedRelays ||= {};
    let record = state.pendingFixedRelays[routed.messageId];
    const recordWasPersisted = Boolean(record);
    let processingSent = recordWasPersisted;
    if (!record) {
      const prepared = await prepareRelay(routed);
      processingSent = prepared.processingSent;
      record = {
        chatId: routed.chatId,
        sourceMessageId: routed.messageId,
        clientUserMessageId: routed.messageId,
        input: prepared.input,
        phase: "queued",
        startOutcomeUnknown: false,
        desktopActivationAttempted: false,
        desktopActivationVerified: false,
        desktopActivationAttemptCount: 0,
        desktopDeliveryAttemptCount: 0,
        desktopRecoveryRetryAttempted: false,
        desktopLastDeliveryCode: null,
        receiptVerified: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.pendingFixedRelays[routed.messageId] = record;
      await persistState();
    }

    async function pauseForShutdown() {
      record.phase =
        record.turnId || record.startOutcomeUnknown === true
          ? "needs_recovery"
          : "queued";
      record.updatedAt = Date.now();
      record.error = "bridge_shutdown";
      await persistState();
      await log("info", "relay_paused_for_shutdown", {
        messageId: routed.messageId,
      });
    }

    async function waitBeforeRecovery(milliseconds) {
      try {
        await abortableDelay(milliseconds, shutdownController.signal);
        return true;
      } catch (error) {
        if (error?.code === "aborted" && shuttingDown) {
          await pauseForShutdown();
          return false;
        }
        throw error;
      }
    }

    if (record.phase === "reply_pending" && record.finalText) {
      await finishRelay(
        routed.messageId,
        routed.chatId,
        record,
        record.finalText,
      );
      return;
    }

    let turnFinished = false;
    let processingReply = Promise.resolve();
    const processingTimer = processingSent
      ? undefined
      : setTimeout(() => {
          if (turnFinished) return;
          processingReply = reply(
            routed.messageId,
            "收到，已转给本地总控处理，有结果我直接告诉你。",
            "processing",
          ).catch((error) =>
            log("error", "processing_reply_failed", {
              messageId: routed.messageId,
              error: sanitizeBridgeDiagnostic(error?.message || error),
            }),
          );
        }, 3000);

    try {
      const timing = messageTimings.get(routed.messageId);
      const startedAt = Date.now();
      if (
        !record.turnId &&
        recordWasPersisted &&
        record.clientUserMessageId
      ) {
        if (
          record.phase === "needs_recovery" &&
          record.startOutcomeUnknown === undefined
        ) {
          record.startOutcomeUnknown = true;
        }
        const recovered = await findFixedControllerTurnByClientMessageId(
          appServer,
          {
            threadId: config.fixedControllerThreadId,
            expectedCwd: config.codexWorkingDirectory,
            clientUserMessageId: record.clientUserMessageId,
          },
        );
        if (recovered) {
          record.turnId = recovered.turnId;
          record.startOutcomeUnknown = false;
          record.receiptVerified = true;
          if (record.turnTransport === "desktop-ipc") {
            record.desktopLiveVisible = true;
          }
          record.phase = "started";
          record.updatedAt = Date.now();
          await persistState();
          await log("info", "turn_recovered", {
            messageId: routed.messageId,
          });
        }
      }

      if (!record.turnId && record.startOutcomeUnknown === true) {
        if (
          fixedControllerStartReconcileExpired(
            record,
            Date.now(),
            START_RECONCILE_TIMEOUT_MS,
          )
        ) {
          record.phase = "delivery_unknown";
          record.updatedAt = Date.now();
          record.error = "turn_delivery_unknown";
          await persistState();
          await finishRelay(
            routed.messageId,
            routed.chatId,
            record,
            "刚才桥接在投递时中断，我无法确认这条是否已经进入本地总控。为避免重复执行，我没有自动重发；请先查看本地总控，如确认没有执行，再重新发送。",
          );
          await log("error", "delivery_unknown", {
            messageId: routed.messageId,
          });
          return;
        }
        const error = new Error("Turn start outcome is still being correlated");
        error.code = "desktop_turn_start_outcome_unknown";
        throw error;
      }

      if (!record.turnId) {
        record.phase = "waiting_for_idle";
        record.updatedAt = Date.now();
        await persistState();
        const execution = await startFixedControllerTurnPreferDesktop(
          appServer,
          {
            threadId: config.fixedControllerThreadId,
            expectedCwd: config.codexWorkingDirectory,
            input: record.input,
            clientUserMessageId: record.clientUserMessageId,
            idleTimeoutMs: config.codexControllerTurnTimeoutSeconds * 1000,
            desktopVisibilityEnabled: desktopVisibility !== "off",
            allowHeadlessFallback: desktopVisibility === "off",
            desktopActivationAttempted:
              record.desktopActivationAttempted === true,
            desktopActivationVerified:
              record.desktopActivationVerified === true,
            desktopDeliveryAttemptCount: Number(
              record.desktopDeliveryAttemptCount || 0,
            ),
            desktopRecoveryRetryAttempted:
              record.desktopRecoveryRetryAttempted === true,
            desktopLastDeliveryCode:
              typeof record.desktopLastDeliveryCode === "string"
                ? record.desktopLastDeliveryCode
                : undefined,
            signal: shutdownController.signal,
            onDesktopDeliveryAttempt: async () => {
              record.desktopDeliveryAttemptCount =
                Number(record.desktopDeliveryAttemptCount || 0) + 1;
              record.desktopLastDeliveryCode = null;
              record.receiptVerified = false;
              record.updatedAt = Date.now();
              await persistState();
            },
            onDesktopRecoveryRetryRequested: async () => {
              record.desktopRecoveryRetryAttempted = true;
              record.phase = "recovery_retry_requested";
              record.updatedAt = Date.now();
              await persistState();
              await log("info", "desktop_recovery_retry_requested", {
                messageId: routed.messageId,
              });
            },
            onDesktopActivationRequested: async () => {
              record.desktopActivationAttempted = true;
              record.desktopActivationVerified = false;
              record.desktopActivationAttemptCount =
                Number(record.desktopActivationAttemptCount || 0) + 1;
              record.desktopActivationStatus = "requested";
              record.phase = "activation_requested";
              record.updatedAt = Date.now();
              await persistState();
              await log("info", "desktop_activation_requested", {
                messageId: routed.messageId,
              });
            },
            onDesktopActivationVerified: async ({
              resumed,
              verificationAttempts,
            }) => {
              record.desktopActivationVerified = true;
              record.desktopActivationStatus = "verified";
              record.desktopActivationVerificationAttempts =
                Number(verificationAttempts || 0);
              record.phase = "activation_verified";
              record.updatedAt = Date.now();
              await persistState();
              await log("info", "desktop_activation_verified", {
                messageId: routed.messageId,
                verificationAttempts:
                  record.desktopActivationVerificationAttempts,
                resumed: resumed === true,
              });
            },
            onDesktopActivationFailed: async ({ code, resumed }) => {
              record.desktopActivationVerified = false;
              record.desktopActivationStatus = "failed";
              record.desktopActivationError =
                sanitizeBridgeDiagnostic(code).slice(0, 120);
              record.phase = "activation_failed";
              record.updatedAt = Date.now();
              await persistState();
              await log("error", "desktop_activation_failed", {
                messageId: routed.messageId,
                error: record.desktopActivationError,
                resumed: resumed === true,
              });
            },
            onTransportDispatching: async (transport) => {
              record.turnTransport = transport;
              record.desktopLiveVisible =
                transport === "desktop-ipc" ? null : false;
              record.receiptVerified = false;
              record.startOutcomeUnknown = true;
              record.phase = "dispatching";
              record.dispatchingAt = Date.now();
              record.updatedAt = Date.now();
              await persistState();
            },
            onTransportNotDispatched: async (transport, outcome = {}) => {
              if (!record.turnId) {
                const previousRecoveryRetryAttempted =
                  record.desktopRecoveryRetryAttempted;
                record.startOutcomeUnknown = false;
                if (outcome.recoveryRetryReleased === true) {
                  record.desktopRecoveryRetryAttempted = false;
                }
                record.desktopLastDeliveryCode =
                  typeof outcome.code === "string" ? outcome.code : null;
                record.phase = "waiting_for_idle";
                record.updatedAt = Date.now();
                try {
                  await persistState();
                } catch (error) {
                  record.desktopRecoveryRetryAttempted =
                    previousRecoveryRetryAttempted;
                  throw error;
                }
              }
            },
          },
        );
        record.turnId = execution.turnId;
        record.turnTransport = execution.transport;
        record.desktopLiveVisible = execution.desktopLiveVisible === true;
        record.desktopActivationAttempted =
          execution.activationAttempted === true ||
          record.desktopActivationAttempted === true;
        record.desktopActivationVerified =
          execution.activationVerified === true ||
          record.desktopActivationVerified === true;
        record.receiptVerified = execution.receiptVerified === true;
        record.startOutcomeUnknown = false;
        record.desktopLastDeliveryCode = null;
        clearFixedControllerOwnerBusyRetry(record);
        record.phase = "started";
        record.updatedAt = Date.now();
        state.fixedControllerRelay.lastTransport = execution.transport;
        state.fixedControllerRelay.lastDesktopLiveVisible =
          execution.desktopLiveVisible === true;
        state.fixedControllerRelay.lastTurnStartedAt = Date.now();
        await persistState();
        await log("info", "turn_started", {
          messageId: routed.messageId,
          transport: execution.transport,
          desktopLiveVisible: execution.desktopLiveVisible === true,
          activationAttempted:
            record.desktopActivationAttempted === true,
          activationVerified:
            record.desktopActivationVerified === true,
          deliveryAttemptCount:
            record.desktopDeliveryAttemptCount,
          receiptVerified: record.receiptVerified === true,
        });
      }

      const completion = await waitForFixedControllerTurn(appServer, {
        threadId: config.fixedControllerThreadId,
        expectedCwd: config.codexWorkingDirectory,
        turnId: record.turnId,
        timeoutMs: config.codexControllerTurnTimeoutSeconds * 1000,
        deferDetachedDesktopStatuses:
          record.turnTransport === "desktop-ipc" ||
          record.desktopLiveVisible === true,
        signal: shutdownController.signal,
      });
      if (timing) timing.codexMs = Date.now() - startedAt;
      const finalText =
        completion.finalText ||
        (completion.status === "completed"
          ? "本地总控本轮已完成，但没有返回可转述的文字。"
          : `本地总控本轮状态：${completion.status}。`);
      await finishRelay(
        routed.messageId,
        routed.chatId,
        record,
        finalText,
      );
      await log("info", "relay_completed", {
        messageId: routed.messageId,
        status: completion.status,
      });
    } catch (error) {
      if (error?.code === "aborted" && shuttingDown) {
        await pauseForShutdown();
        return;
      }
      if (error?.code === "turn_correlation_ambiguous") {
        record.phase = "delivery_conflict";
        record.updatedAt = Date.now();
        record.error = "turn_correlation_ambiguous";
        await persistState();
        await finishRelay(
          routed.messageId,
          routed.chatId,
          record,
          "这条消息在本地总控里出现了两个同源回合，我无法安全判断哪一个才是本轮结果。本条不会继续转述；请先查看本地总控，不要直接重复发送。",
        );
        await log("error", "delivery_conflict", {
          messageId: routed.messageId,
        });
        return;
      }
      const ownerBusy = error?.code === "desktop_turn_owner_busy";
      const ownerBusyGate = ownerBusy
        ? advanceFixedControllerOwnerBusyRetry(record, {
            now: Date.now(),
            maxWaitMs: Math.min(
              DESKTOP_OWNER_BUSY_MAX_WAIT_MS,
              config.codexControllerTurnTimeoutSeconds * 1000,
            ),
            maxRetries: DESKTOP_OWNER_BUSY_MAX_RETRIES,
          })
        : null;
      if (!ownerBusy) clearFixedControllerOwnerBusyRetry(record);
      const correlationRecoverable = Boolean(
        !record.turnId &&
        record.clientUserMessageId &&
        (record.startOutcomeUnknown === true ||
          [
            "turn_start_failed",
            "desktop_turn_start_outcome_unknown",
          ].includes(error?.code)),
      );
      if (correlationRecoverable) record.startOutcomeUnknown = true;
      record.phase = ownerBusy
        ? ownerBusyGate.expired
          ? "delivery_blocked"
          : "waiting_for_idle"
        : record.turnId || correlationRecoverable
          ? "needs_recovery"
          : "delivery_blocked";
      record.updatedAt = Date.now();
      record.error = ownerBusyGate?.expired
        ? "desktop_turn_owner_busy_timeout"
        : sanitizeBridgeDiagnostic(
            error?.code || error?.message || error,
          ).slice(0, 500);
      await persistState();
      if (ownerBusy) {
        if (ownerBusyGate.expired) {
          const boundedError = new Error(
            "Desktop fixed controller owner remained busy beyond the recovery limit",
          );
          boundedError.code = "desktop_turn_owner_busy_timeout";
          throw boundedError;
        }
        if (!(await waitBeforeRecovery(1000))) return;
        return handleRelay({ ...routed, recovery: true });
      }
      if (record.turnId || correlationRecoverable) {
        if (record.recoveryNotified !== true) {
          await reply(
            routed.messageId,
            record.turnId
              ? "本地总控已经收到这条消息，但我还没有取得这一轮的最终答复。桥接会继续等这一轮，不会拿旧回复代替。"
              : "这条消息的投递结果正在核对。我不会重复派发，也不会拿旧回复代替；核对后会继续回传结果。",
            "processing",
          );
          record.recoveryNotified = true;
          record.updatedAt = Date.now();
          await persistState();
        }
        await log("error", "relay_needs_recovery", {
          messageId: routed.messageId,
          error: record.error,
        });
        if (!(await waitBeforeRecovery(10000))) return;
        return handleRelay({ ...routed, recovery: true });
      }
      throw error;
    } finally {
      turnFinished = true;
      if (processingTimer) clearTimeout(processingTimer);
      await processingReply;
    }
  }

  async function handleRouted(routed) {
    const { messageId, chatId } = routed;
    if (state.processedMessageIds[messageId] || inFlight.has(messageId)) {
      await log("info", "message_deduplicated", { messageId });
      return;
    }
    inFlight.add(messageId);
    messageTimings.set(messageId, { startedAt: Date.now() });
    try {
      const pending = state.pendingReplies[messageId];
      if (pending?.text) {
        await completeReply(messageId, chatId, pending.text);
        if (state.pendingFixedRelays[messageId]) {
          delete state.pendingFixedRelays[messageId];
          await persistState();
        }
        return;
      }
      if (routed.kind === "reply") {
        await completeReply(messageId, chatId, routed.text);
        return;
      }
      if (routed.kind === "command") {
        await completeReply(
          messageId,
          chatId,
          commandReply(routed.command, {
            bridgeVersion: BRIDGE_VERSION,
            targetReadable,
            pendingRelayCount: Object.keys(state.pendingFixedRelays).length,
            lastTransport: state.fixedControllerRelay.lastTransport,
            lastDesktopLiveVisible:
              state.fixedControllerRelay.lastDesktopLiveVisible,
          }),
        );
        return;
      }
      if (routed.kind !== "fixed-controller-relay") {
        throw new Error(`Unexpected relay route: ${routed.kind}`);
      }
      await handleRelay(routed);
    } catch (error) {
      const receipt = failureReceipt(messageId, `relay:${routed.kind}`);
      await log("error", "message_processing_failed", {
        messageId,
        receipt,
        error: sanitizeBridgeDiagnostic(error?.message || error),
      });
      try {
        const failureText = [
          "这次没有成功转给本地总控，不能报告为已处理。",
          `证据编号：${receipt}`,
          "我已经保留故障记录，请在本地 Codex 核对后再试。",
        ].join("\n");
        const failedRecord = state.pendingFixedRelays[messageId];
        if (routed.kind === "fixed-controller-relay" && failedRecord) {
          await finishRelay(
            messageId,
            chatId,
            failedRecord,
            failureText,
          );
        } else {
          await completeReply(messageId, chatId, failureText);
        }
      } catch (replyError) {
        await log("error", "failure_reply_failed", {
          messageId,
          error: sanitizeBridgeDiagnostic(replyError?.message || replyError),
        });
      }
    } finally {
      inFlight.delete(messageId);
      messageTimings.delete(messageId);
    }
  }

  for (const [messageId, record] of Object.entries(
    state.pendingFixedRelays,
  ).sort(
    (left, right) =>
      Number(left[1]?.createdAt || 0) - Number(right[1]?.createdAt || 0),
  )) {
    if (state.processedMessageIds[messageId]) {
      delete state.pendingFixedRelays[messageId];
      continue;
    }
    if (!record?.chatId || !record?.input) continue;
    void queueByKey(queues, FIXED_CONTROLLER_QUEUE_KEY, () =>
      handleRouted({
        kind: "fixed-controller-relay",
        messageId,
        chatId: record.chatId,
        chatType: "p2p",
        text: record.input,
        recovery: true,
      }),
    );
  }
  await persistState();

  const listener = spawn(
    lark.command,
    [...lark.prefix, "event", "consume", EVENT_KEY, "--as", "bot"],
    {
      cwd: config.runtimeDirectory,
      env: larkEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let ready = false;
  listener.stdout.setEncoding("utf8");
  listener.stderr.setEncoding("utf8");

  const output = readline.createInterface({ input: listener.stdout });
  output.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      void log("error", "invalid_event_json");
      return;
    }
    const routed = routeEvent(event, config);
    if (routed.kind === "ignore") {
      void log("info", "event_ignored", { reason: routed.reason });
      return;
    }
    void queueByKey(queues, FIXED_CONTROLLER_QUEUE_KEY, () =>
      handleRouted(routed),
    );
  });

  const diagnostics = readline.createInterface({ input: listener.stderr });
  diagnostics.on("line", (line) => {
    if (line.includes(`[event] ready event_key=${EVENT_KEY}`)) {
      ready = true;
      void log("info", "listener_ready", {
        bridgePid: process.pid,
        bridgeVersion: BRIDGE_VERSION,
        relayMode: RELAY_MODE,
        fixedControllerRelayEnabled: true,
        fixedControllerRelayTargetReadable: targetReadable,
        fixedControllerDesktopVisibility: desktopVisibility,
        fixedControllerRuntimeSandbox: FIXED_CONTROLLER_RUNTIME_SANDBOX,
        fixedControllerRuntimeApprovalPolicy:
          FIXED_CONTROLLER_RUNTIME_APPROVAL_POLICY,
      });
      console.log(line);
      return;
    }
    if (line.trim()) {
      const diagnostic = sanitizeBridgeDiagnostic(line);
      void log("info", "listener_diagnostic", {
        diagnostic: diagnostic.slice(0, 1000),
      });
      console.error(diagnostic);
    }
  });

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    void log("info", "shutdown_requested", { signal });
    shutdownController.abort();
    listener.stdin.end();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const stopRequestTimer = setInterval(async () => {
    try {
      await access(stopRequestPath, fsConstants.F_OK);
      await rm(stopRequestPath, { force: true });
      shutdown("control_file");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await log("error", "stop_request_check_failed", {
          error: sanitizeBridgeDiagnostic(error?.message || error),
        });
      }
    }
  }, 1000);
  stopRequestTimer.unref();

  listener.on("error", async (error) => {
    await log("error", "listener_process_error", {
      error: sanitizeBridgeDiagnostic(error.message),
    });
    process.exitCode = 1;
  });
  listener.on("exit", async (code) => {
    clearInterval(stopRequestTimer);
    await Promise.allSettled([...queues.values()]);
    await persistState();
    await appServer.close();
    await releasePidLock();
    await log(code === 0 ? "info" : "error", "listener_exited", {
      code,
      ready,
    });
    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  void releasePidLock();
  console.error(
    JSON.stringify({
      ok: false,
      error: sanitizeBridgeDiagnostic(error?.message || error),
    }),
  );
  process.exitCode = 1;
});

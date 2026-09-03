import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodexAppServerClient,
  resolveCodexCli,
} from "./codex-app-server.mjs";
import {
  codexThreadStatus,
  listCodexThreads,
  readCodexThreadDetail,
  sendCodexThreadTurn,
} from "./controller-thread-transport.mjs";
import { buildFixedControllerAppServerArgs } from "./fixed-controller-relay.mjs";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEFAULT_READ_TURN_LIMIT = 6;
const MAX_READ_TURN_LIMIT = 12;
const MAX_MESSAGE_CHARS = 4000;
const COMPLETE_LIST_MAX_PAGES = 50;
const POLL_INTERVAL_MS = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_MESSAGES = Object.freeze({
  invalid_request: "Invalid controller thread tool request.",
  request_file_invalid: "The controller request file is unavailable or invalid.",
  title_not_found: "No task matched the exact title.",
  title_ambiguous: "More than one task has that exact title.",
  target_changed: "The selected task changed before it could be read.",
  task_list_incomplete: "The complete task list could not be verified.",
  target_active: "The target task is active; no message was sent.",
  controller_identity_missing: "The fixed controller identity is unavailable.",
  self_send_forbidden: "The fixed controller cannot send a turn to itself.",
  target_turn_mismatch: "The returned completion did not match the target turn.",
  target_turn_failed: "The target turn did not complete successfully.",
  empty_final_text: "The completed target turn returned no final response.",
  started_but_unfinished:
    "The target turn started but did not finish before the timeout; do not resend it.",
  start_outcome_unknown:
    "The send outcome could not be verified; use the correlation code and do not resend automatically.",
  turn_correlation_ambiguous:
    "More than one target turn has the same correlation id; no result was selected.",
  operation_failed: "The controller thread operation failed.",
});

export class ControllerThreadToolError extends Error {
  constructor(code, options = {}) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.operation_failed);
    this.name = "ControllerThreadToolError";
    this.code = SAFE_MESSAGES[code] ? code : "operation_failed";
    if (/^[0-9A-F]{8}$/.test(options.correlationCode || "")) {
      this.correlationCode = options.correlationCode;
    }
  }
}

function fail(code, options) {
  throw new ControllerThreadToolError(code, options);
}

function visibleTitle(thread) {
  const value = String(thread?.name || thread?.preview || "");
  return value.trim();
}

function normalizeExactTitle(value) {
  if (typeof value !== "string") fail("invalid_request");
  const title = value.trim();
  if (!title || title.length > 300 || title.includes("\u0000")) {
    fail("invalid_request");
  }
  return title;
}

function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    fail("invalid_request");
  }
  return value;
}

function boundedText(value, limit = MAX_MESSAGE_CHARS) {
  const text = String(value || "")
    .replace(/\u0000/g, "")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "[redacted-id]",
    )
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function normalizeRequestId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:-]{8,160}$/.test(value)
  ) {
    fail("invalid_request");
  }
  return value;
}

function correlationCode(requestId) {
  return createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
}

function userMessageText(item) {
  if (item?.type !== "userMessage") return "";
  if (typeof item.text === "string") return boundedText(item.text);
  if (typeof item.content === "string") return boundedText(item.content);
  if (!Array.isArray(item.content)) return "";
  return boundedText(
    item.content
      .map((part) => {
        if (typeof part === "string") return part;
        return typeof part?.text === "string" ? part.text : "";
      })
      .filter(Boolean)
      .join("\n"),
  );
}

function assistantMessageText(item) {
  if (item?.type !== "agentMessage") return "";
  return boundedText(item.text);
}

function turnStatus(turn) {
  if (typeof turn?.status === "string") return turn.status;
  return String(turn?.status?.type || "unknown");
}

function latestItemText(turn, extractor) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const text = extractor(items[index]);
    if (text) return text;
  }
  return "";
}

function findTurnByClientMessageId(thread, clientUserMessageId) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const matches = turns.filter((turn) => {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    return (
      typeof turn?.id === "string" &&
      turn.id &&
      items.some(
        (item) =>
          item?.type === "userMessage" &&
          (item.clientId === clientUserMessageId ||
            item.client_id === clientUserMessageId),
      )
    );
  });
  if (matches.length > 1) fail("turn_correlation_ambiguous");
  return matches[0] || null;
}

function terminalTurnStatus(status) {
  return [
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "canceled",
    "aborted",
  ].includes(status);
}

async function delay(milliseconds, sleep) {
  if (typeof sleep === "function") {
    await sleep(milliseconds);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listVisibleThreadsComplete(appServer) {
  try {
    return await listCodexThreads(appServer, {
      pageLimit: 100,
      maxPages: COMPLETE_LIST_MAX_PAGES,
      requireComplete: true,
    });
  } catch (error) {
    if (error?.code === "CODEX_THREAD_LIST_INCOMPLETE") {
      fail("task_list_incomplete");
    }
    throw error;
  }
}

async function pollExactTargetTurn(appServer, options) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const deadline = now() + options.timeoutMs;
  while (true) {
    const thread = await readCodexThreadDetail(appServer, options.threadId);
    if (
      !thread ||
      thread.id !== options.threadId ||
      visibleTitle(thread) !== options.title
    ) {
      fail("target_changed", { correlationCode: options.correlationCode });
    }
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const turn = turns.find((candidate) => candidate?.id === options.turnId);
    const status = turn ? turnStatus(turn) : "not_found";
    if (turn && terminalTurnStatus(status)) {
      return {
        threadId: options.threadId,
        turnId: options.turnId,
        status,
        finalText: latestItemText(turn, assistantMessageText),
      };
    }
    const currentTime = now();
    if (currentTime >= deadline) {
      fail("started_but_unfinished", {
        correlationCode: options.correlationCode,
      });
    }
    await delay(
      Math.min(
        options.pollIntervalMs || POLL_INTERVAL_MS,
        Math.max(1, deadline - currentTime),
      ),
      options.sleep,
    );
  }
}

function recentTurns(thread, limit) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return turns.slice(-limit).map((turn) => ({
    status: turnStatus(turn),
    user: latestItemText(turn, userMessageText),
    assistant: latestItemText(turn, assistantMessageText),
  }));
}

function safeUpdatedAt(thread) {
  const value = thread?.updatedAt ?? thread?.updated_at ?? null;
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function safeThreadSummary(thread) {
  return {
    title: boundedText(visibleTitle(thread), 300),
    status: codexThreadStatus(thread),
    updatedAt: safeUpdatedAt(thread),
  };
}

export function normalizeControllerThreadRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    fail("invalid_request");
  }
  const allowedActions = new Set(["list", "read", "send-and-wait"]);
  if (!allowedActions.has(request.action)) fail("invalid_request");

  if (request.action === "list") {
    return {
      action: "list",
      limit: boundedInteger(request.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    };
  }

  const normalized = {
    action: request.action,
    title: normalizeExactTitle(request.title),
  };
  if (request.action === "read") {
    normalized.turnLimit = boundedInteger(
      request.turnLimit,
      DEFAULT_READ_TURN_LIMIT,
      MAX_READ_TURN_LIMIT,
    );
    return normalized;
  }

  if (typeof request.input !== "string" || !request.input.trim()) {
    fail("invalid_request");
  }
  if (request.input.length > MAX_REQUEST_BYTES) fail("invalid_request");
  normalized.input = request.input;
  normalized.requestId = normalizeRequestId(request.requestId);
  normalized.timeoutMs = boundedInteger(
    request.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  return normalized;
}

export function resolveExactTitleThread(threads, title) {
  const matches = (Array.isArray(threads) ? threads : []).filter(
    (thread) => visibleTitle(thread) === title,
  );
  if (matches.length === 0) fail("title_not_found");
  if (matches.length > 1) fail("title_ambiguous");
  return matches[0];
}

async function configuredControllerThreadId(options = {}) {
  const explicit = String(options.fixedControllerThreadId || "").trim();
  if (UUID_PATTERN.test(explicit)) return explicit;

  const environment = options.env || process.env;
  const fromEnvironment = String(
    environment.LARK_CODEX_FIXED_CONTROLLER_THREAD_ID || "",
  ).trim();
  if (UUID_PATTERN.test(fromEnvironment)) return fromEnvironment;

  const runtimeConfigPath =
    options.configPath ||
    environment.LARK_CODEX_BRIDGE_CONFIG ||
    path.join(
      homedir(),
      ".codex",
      "private",
      "lark-im-codex-bridge",
      "config.json",
    );
  try {
    const config = JSON.parse(await readFile(runtimeConfigPath, "utf8"));
    const fromConfig = String(config?.fixedControllerThreadId || "").trim();
    return UUID_PATTERN.test(fromConfig) ? fromConfig : "";
  } catch {
    return "";
  }
}

export async function executeControllerThreadRequest(
  appServer,
  rawRequest,
  options = {},
) {
  const request = normalizeControllerThreadRequest(rawRequest);
  const threads = await listVisibleThreadsComplete(appServer);

  if (request.action === "list") {
    return {
      ok: true,
      action: "list",
      total: threads.length,
      tasks: threads.slice(0, request.limit).map(safeThreadSummary),
    };
  }

  let target = resolveExactTitleThread(threads, request.title);
  if (request.action === "read") {
    const detail = await readCodexThreadDetail(appServer, target.id);
    if (
      !detail ||
      detail.id !== target.id ||
      visibleTitle(detail) !== request.title
    ) {
      fail("target_changed");
    }
    return {
      ok: true,
      action: "read",
      task: {
        ...safeThreadSummary(detail),
        turnCount: Array.isArray(detail.turns) ? detail.turns.length : 0,
        recentTurns: recentTurns(detail, request.turnLimit),
      },
    };
  }

  const controllerThreadId = await configuredControllerThreadId(options);
  if (!controllerThreadId) fail("controller_identity_missing");
  if (target.id === controllerThreadId) fail("self_send_forbidden");

  const refreshedThreads = await listVisibleThreadsComplete(appServer);
  const refreshedTarget = resolveExactTitleThread(
    refreshedThreads,
    request.title,
  );
  if (refreshedTarget.id !== target.id) fail("target_changed");
  target = refreshedTarget;

  const correlation = correlationCode(request.requestId);
  const detail = await readCodexThreadDetail(appServer, target.id);
  if (
    !detail ||
    detail.id !== target.id ||
    visibleTitle(detail) !== request.title
  ) {
    fail("target_changed", { correlationCode: correlation });
  }
  const existingTurn = findTurnByClientMessageId(detail, request.requestId);
  let started;
  if (existingTurn) {
    started = {
      mode: "deduplicated",
      threadId: target.id,
      turnId: existingTurn.id,
    };
  } else {
    if (detail?.status?.type === "active") {
      fail("target_active", { correlationCode: correlation });
    }

    try {
      started = await sendCodexThreadTurn(appServer, {
        threadId: target.id,
        input: request.input,
        timeoutMs: request.timeoutMs,
        failIfActive: true,
        clientUserMessageId: request.requestId,
        startOnly: true,
      });
    } catch (error) {
      if (error?.code === "CODEX_THREAD_ACTIVE") {
        fail("target_active", { correlationCode: correlation });
      }
      if (error?.code === "CODEX_TURN_START_OUTCOME_UNKNOWN") {
        const recoveryDetail = await readCodexThreadDetail(appServer, target.id);
        if (
          !recoveryDetail ||
          recoveryDetail.id !== target.id ||
          visibleTitle(recoveryDetail) !== request.title
        ) {
          fail("target_changed", { correlationCode: correlation });
        }
        const recoveredTurn = findTurnByClientMessageId(
          recoveryDetail,
          request.requestId,
        );
        if (!recoveredTurn) {
          fail("start_outcome_unknown", { correlationCode: correlation });
        }
        started = {
          mode: "recovered",
          threadId: target.id,
          turnId: recoveredTurn.id,
        };
      } else {
        throw error;
      }
    }
  }

  const completion = await pollExactTargetTurn(appServer, {
    threadId: target.id,
    turnId: started.turnId,
    title: request.title,
    timeoutMs: request.timeoutMs,
    correlationCode: correlation,
    pollIntervalMs: options.pollIntervalMs,
    sleep: options.sleep,
    now: options.now,
  });

  if (
    completion?.threadId !== target.id ||
    completion?.turnId !== started.turnId
  ) {
    fail("target_turn_mismatch", { correlationCode: correlation });
  }
  if (completion?.status !== "completed") {
    fail("target_turn_failed", { correlationCode: correlation });
  }
  const finalText = boundedText(completion.finalText, 20000);
  if (!finalText) fail("empty_final_text", { correlationCode: correlation });

  return {
    ok: true,
    action: "send-and-wait",
    task: {
      title: boundedText(visibleTitle(target), 300),
    },
    mode: started.mode,
    completionStatus: completion.status,
    correlationCode: correlation,
    finalText,
  };
}

function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function readControllerThreadRequestFile(requestPath, options = {}) {
  if (typeof requestPath !== "string" || !requestPath.trim()) {
    fail("request_file_invalid");
  }
  try {
    const allowedRoot = await realpath(
      options.allowedRequestRoot ||
        path.join(options.cwd || process.cwd(), "work", "controller-thread-requests"),
    );
    const resolvedRequestPath = await realpath(path.resolve(requestPath));
    if (!isWithinDirectory(allowedRoot, resolvedRequestPath)) {
      fail("request_file_invalid");
    }
    const fileInfo = await stat(resolvedRequestPath);
    if (!fileInfo.isFile() || fileInfo.size > MAX_REQUEST_BYTES) {
      fail("request_file_invalid");
    }
    const source = (await readFile(resolvedRequestPath, "utf8")).replace(/^\uFEFF/, "");
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof ControllerThreadToolError) throw error;
    fail("request_file_invalid");
  }
}

export async function runControllerThreadTool(requestPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const request = await readControllerThreadRequestFile(requestPath, {
    cwd,
    allowedRequestRoot: options.allowedRequestRoot,
  });
  const ownedAppServer = !options.appServer;
  const appServer =
    options.appServer ||
    new CodexAppServerClient(
      options.codexCli || (await resolveCodexCli(options.codexConfig || {})),
      {
        cwd,
        clientVersion: "controller-thread-tool/1",
        appServerArgs: buildFixedControllerAppServerArgs(),
      },
    );
  try {
    return await executeControllerThreadRequest(appServer, request, options);
  } finally {
    if (ownedAppServer) await appServer.close();
  }
}

export function safeControllerThreadToolError(error) {
  const code =
    error instanceof ControllerThreadToolError
      ? error.code
      : "operation_failed";
  const result = {
    ok: false,
    error: {
      code,
      message: SAFE_MESSAGES[code] || SAFE_MESSAGES.operation_failed,
    },
  };
  if (/^[0-9A-F]{8}$/.test(error?.correlationCode || "")) {
    result.correlationCode = error.correlationCode;
  }
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runControllerThreadTool(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeControllerThreadToolError(error))}\n`);
    process.exitCode = 1;
  }
}

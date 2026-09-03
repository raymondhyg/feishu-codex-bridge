import { createHash } from "node:crypto";
import path from "node:path";

export const EVENT_KEY = "im.message.receive_v1";

const ATTACHMENT_TYPES = new Set([
  "post",
  "image",
  "file",
  "audio",
  "video",
  "media",
]);

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function initialState() {
  return {
    version: 6,
    processedMessageIds: {},
    pendingReplies: {},
    pendingFixedRelays: {},
    fixedControllerRelay: {},
    lastLatencyByChat: {},
  };
}

export function normalizeState(value) {
  if (!value || typeof value !== "object") return initialState();
  const isCurrentSchema = Number(value.version) === 6;
  return {
    version: 6,
    processedMessageIds: objectOrEmpty(value.processedMessageIds),
    pendingReplies: objectOrEmpty(value.pendingReplies),
    pendingFixedRelays: objectOrEmpty(value.pendingFixedRelays),
    fixedControllerRelay: isCurrentSchema
      ? objectOrEmpty(value.fixedControllerRelay)
      : {},
    lastLatencyByChat: objectOrEmpty(value.lastLatencyByChat),
  };
}

export function pruneState(state, now = Date.now()) {
  const processedCutoff = now - 7 * 24 * 60 * 60 * 1000;
  state.processedMessageIds = Object.fromEntries(
    Object.entries(state.processedMessageIds || {})
      .filter(([, timestamp]) => Number(timestamp) >= processedCutoff)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 2000),
  );
  const relayCutoff = now - 30 * 24 * 60 * 60 * 1000;
  state.pendingFixedRelays = Object.fromEntries(
    Object.entries(state.pendingFixedRelays || {})
      .filter(([, relay]) => {
        const updatedAt = Number(relay?.updatedAt ?? relay?.createdAt);
        return Number.isFinite(updatedAt) && updatedAt >= relayCutoff;
      })
      .sort(
        (a, b) =>
          Number(b[1]?.updatedAt ?? b[1]?.createdAt) -
          Number(a[1]?.updatedAt ?? a[1]?.createdAt),
      )
      .slice(0, 100),
  );
  state.pendingReplies = Object.fromEntries(
    Object.entries(state.pendingReplies || {})
      .sort(
        (a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0),
      )
      .slice(0, 100),
  );
  state.lastLatencyByChat = Object.fromEntries(
    Object.entries(state.lastLatencyByChat || {})
      .sort(
        (a, b) =>
          Number(b[1]?.completedAt || 0) - Number(a[1]?.completedAt || 0),
      )
      .slice(0, 100),
  );
  return state;
}

function relayEvent(event, extra = {}) {
  return {
    kind: "fixed-controller-relay",
    messageId: event.message_id,
    chatId: event.chat_id,
    chatType: "p2p",
    senderId: event.sender_id,
    messageType: event.message_type,
    text: typeof event.content === "string" ? event.content : "",
    ...extra,
  };
}

export function routeEvent(event, config) {
  if (!event || typeof event !== "object") {
    return { kind: "ignore", reason: "invalid_event" };
  }
  if (event.type !== EVENT_KEY) {
    return { kind: "ignore", reason: "wrong_event_type" };
  }
  if (event.sender_type === "bot") {
    return { kind: "ignore", reason: "bot_sender" };
  }
  if (!config.allowedSenderIds.includes(event.sender_id)) {
    return { kind: "ignore", reason: "sender_not_allowed" };
  }
  if (
    typeof event.message_id !== "string" ||
    !event.message_id.startsWith("om_") ||
    typeof event.chat_id !== "string" ||
    !event.chat_id.startsWith("oc_")
  ) {
    return { kind: "ignore", reason: "missing_ids" };
  }
  if (event.chat_type !== "p2p") {
    return { kind: "ignore", reason: "p2p_only" };
  }

  const messageType = event.message_type;
  if (ATTACHMENT_TYPES.has(messageType)) {
    return relayEvent(event, { attachment: true });
  }
  if (messageType !== "text") {
    return {
      kind: "reply",
      messageId: event.message_id,
      chatId: event.chat_id,
      chatType: "p2p",
      text: `暂不支持这种消息类型：${messageType || "unknown"}。`,
    };
  }

  const text = String(event.content || "").trim();
  if (!text) {
    return {
      kind: "reply",
      messageId: event.message_id,
      chatId: event.chat_id,
      chatType: "p2p",
      text: "这条消息没有可转达的文字内容。",
    };
  }
  const command = text.toLowerCase();
  if (command === "/help" || command === "/status") {
    return {
      kind: "command",
      command: command.slice(1),
      messageId: event.message_id,
      chatId: event.chat_id,
      chatType: "p2p",
    };
  }
  return relayEvent(event);
}

export function commandReply(command, options = {}) {
  if (command === "help") {
    return [
    "Feishu/Lark Codex Bridge（本地总控转述）",
      "",
    "你发来的私聊消息会原样转给固定的本地总控；理解、调查、执行和回复都由本地总控完成，bridge 只负责双向转达。",
      "",
      "/status  查看转述链路状态",
      "/help  查看这段说明",
    ].join("\n");
  }
  if (command === "status") {
    return [
      "状态：运行中",
      `桥接版本：${options.bridgeVersion || "未识别"}`,
      "模式：固定本地总控双向转述",
      `本地总控：${options.targetReadable ? "已绑定且可读" : "当前不可读"}`,
      `等待恢复或回复：${Number(options.pendingRelayCount || 0)} 条`,
      `最近通道：${options.lastTransport || "尚无记录"}`,
      `桌面可见：${options.lastDesktopLiveVisible === true ? "是" : options.lastDesktopLiveVisible === false ? "否" : "尚无记录"}`,
    ].join("\n");
  }
  return "不支持的维护命令。发送 /help 查看可用命令。";
}

function positiveInteger(value, name, errors, options = {}) {
  if (value === undefined) return;
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["config must be an object"];
  }
  if (
    !Array.isArray(config.allowedSenderIds) ||
    config.allowedSenderIds.length === 0 ||
    config.allowedSenderIds.some(
      (value) => typeof value !== "string" || !value.startsWith("ou_"),
    )
  ) {
    errors.push("allowedSenderIds must contain at least one Feishu open_id");
  }
  if (
    typeof config.fixedControllerThreadId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      config.fixedControllerThreadId,
    )
  ) {
    errors.push("fixedControllerThreadId must be one exact Codex thread id");
  }
  if (
    config.fixedControllerDesktopVisibility !== undefined &&
    !["prefer", "require", "off"].includes(
      config.fixedControllerDesktopVisibility,
    )
  ) {
    errors.push(
      "fixedControllerDesktopVisibility must be prefer, require, or off",
    );
  }
  for (const field of [
    "runtimeDirectory",
    "codexWorkingDirectory",
    "attachmentRoot",
  ]) {
    if (typeof config[field] !== "string" || !path.isAbsolute(config[field])) {
      errors.push(`${field} must be an absolute path`);
    }
  }
  for (const field of ["larkCliScript", "codexCliScript"]) {
    if (
      config[field] !== undefined &&
      (typeof config[field] !== "string" || !path.isAbsolute(config[field]))
    ) {
      errors.push(`${field} must be an absolute path when provided`);
    }
  }
  positiveInteger(config.maxAttachmentBytes, "maxAttachmentBytes", errors, {
    maximum: 1024 * 1024 * 1024,
  });
  positiveInteger(
    config.maxAttachmentTotalBytes,
    "maxAttachmentTotalBytes",
    errors,
    { maximum: 2 * 1024 * 1024 * 1024 },
  );
  if (
    Number.isInteger(config.maxAttachmentBytes) &&
    Number.isInteger(config.maxAttachmentTotalBytes) &&
    config.maxAttachmentTotalBytes < config.maxAttachmentBytes
  ) {
    errors.push("maxAttachmentTotalBytes must be >= maxAttachmentBytes");
  }
  positiveInteger(
    config.codexControllerTurnTimeoutSeconds,
    "codexControllerTurnTimeoutSeconds",
    errors,
    { minimum: 30, maximum: 7200 },
  );
  positiveInteger(config.maxReplyChars, "maxReplyChars", errors, {
    minimum: 1000,
    maximum: 30000,
  });
  if (
    Array.isArray(config.allowedGroupChatIds) &&
    config.allowedGroupChatIds.length > 0
  ) {
    errors.push("group chat is not part of the fixed-controller relay");
  }
  return errors;
}

export function truncateReply(text, limit = 12000) {
  const normalized =
    typeof text === "string" && text.trim()
      ? text.trim()
      : "本地总控没有返回可显示的文字。";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 30)}\n\n[回复过长，已在飞书端截断]`;
}

export function idempotencyKey(value) {
  return `codex-${createHash("sha256").update(String(value)).digest("hex").slice(0, 32)}`;
}

export function failureReceipt(messageId, phase = "message-processing") {
  return createHash("sha256")
    .update(`${String(messageId || "")}:${String(phase || "")}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
}

export function sanitizeBridgeDiagnostic(value) {
  return String(value || "")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<redacted-uuid>",
    )
    .replace(/\b(?:ou_|oc_|om_|cli_|app_)[A-Za-z0-9_-]+\b/g, "<redacted-id>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted>")
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|app[_-]?secret|cookie|authorization)(["'\s:=]+)[^,\s}]+/gi,
      "$1$2<redacted>",
    );
}

export function fixedControllerStartReconcileExpired(
  record,
  now = Date.now(),
  timeoutMs = 60_000,
) {
  const startedAt = Number(
    record?.dispatchingAt || record?.createdAt || record?.updatedAt || 0,
  );
  return (
    startedAt > 0 &&
    Number.isFinite(now) &&
    Number.isFinite(timeoutMs) &&
    timeoutMs >= 0 &&
    now - startedAt >= timeoutMs
  );
}

export function advanceFixedControllerOwnerBusyRetry(
  record,
  options = {},
) {
  if (!record || typeof record !== "object") {
    throw new TypeError("record must be an object");
  }
  const now = Number.isFinite(Number(options.now))
    ? Number(options.now)
    : Date.now();
  const maxWaitMs = Number.isFinite(Number(options.maxWaitMs))
    ? Math.max(0, Number(options.maxWaitMs))
    : 5 * 60 * 1000;
  const maxRetries = Number.isFinite(Number(options.maxRetries))
    ? Math.max(1, Math.floor(Number(options.maxRetries)))
    : 300;
  const priorStartedAt = Number(record.desktopOwnerBusyStartedAt);
  const startedAt =
    Number.isFinite(priorStartedAt) && priorStartedAt > 0
      ? priorStartedAt
      : now;
  const priorRetryCount = Number(record.desktopOwnerBusyRetryCount);
  const retryCount =
    (Number.isFinite(priorRetryCount) && priorRetryCount > 0
      ? Math.floor(priorRetryCount)
      : 0) + 1;
  const elapsedMs = Math.max(0, now - startedAt);
  const expired = retryCount >= maxRetries || elapsedMs >= maxWaitMs;

  record.desktopOwnerBusyStartedAt = startedAt;
  record.desktopOwnerBusyRetryCount = retryCount;
  return {
    startedAt,
    retryCount,
    elapsedMs,
    maxWaitMs,
    maxRetries,
    expired,
  };
}

export function clearFixedControllerOwnerBusyRetry(record) {
  if (!record || typeof record !== "object") return record;
  delete record.desktopOwnerBusyStartedAt;
  delete record.desktopOwnerBusyRetryCount;
  return record;
}

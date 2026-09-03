import test from "node:test";
import assert from "node:assert/strict";

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

const config = {
  allowedSenderIds: ["ou_allowed"],
  allowedGroupChatIds: [],
  fixedControllerThreadId: "11111111-1111-4111-8111-111111111111",
  fixedControllerDesktopVisibility: "prefer",
  runtimeDirectory: "C:\\relay\\runtime",
  codexWorkingDirectory: "C:\\relay\\workspace",
  attachmentRoot: "C:\\relay\\attachments",
  maxAttachmentBytes: 100,
  maxAttachmentTotalBytes: 200,
  codexControllerTurnTimeoutSeconds: 60,
  maxReplyChars: 12000,
};

function event(overrides = {}) {
  return {
    type: EVENT_KEY,
    sender_type: "user",
    sender_id: "ou_allowed",
    message_id: "om_message",
    chat_id: "oc_chat",
    chat_type: "p2p",
    message_type: "text",
    content: "请查看今天的工作",
    ...overrides,
  };
}

test("state contains only relay-owned fields", () => {
  assert.deepEqual(Object.keys(initialState()), [
    "version",
    "processedMessageIds",
    "pendingReplies",
    "pendingFixedRelays",
    "fixedControllerRelay",
    "lastLatencyByChat",
  ]);
  assert.equal(initialState().version, 6);
});

test("state migration drops hidden conversation and job-era fields", () => {
  const migrated = normalizeState({
    version: 4,
    threadsByChat: { old: true },
    pendingOperations: { old: true },
    controllerContextByChat: { old: true },
    processedMessageIds: { om_keep: 10 },
    pendingFixedRelays: { om_keep: { createdAt: 10 } },
    fixedControllerRelay: { lastTransport: "stale-build" },
  });
  assert.equal("threadsByChat" in migrated, false);
  assert.equal("pendingOperations" in migrated, false);
  assert.equal("controllerContextByChat" in migrated, false);
  assert.equal(migrated.processedMessageIds.om_keep, 10);
  assert.equal(migrated.pendingFixedRelays.om_keep.createdAt, 10);
  assert.deepEqual(migrated.fixedControllerRelay, {});
});

test("current state keeps current relay evidence across an ordinary restart", () => {
  const current = normalizeState({
    version: 6,
    fixedControllerRelay: { lastTransport: "desktop-ipc" },
    pendingFixedRelays: {
      om_recovery: {
        phase: "activation_verified",
        desktopActivationAttempted: true,
        desktopActivationVerified: true,
        desktopActivationAttemptCount: 1,
        desktopDeliveryAttemptCount: 1,
        desktopRecoveryRetryAttempted: false,
        desktopLastDeliveryCode: "desktop_ipc_no_owner",
        desktopOwnerBusyStartedAt: 100,
        desktopOwnerBusyRetryCount: 2,
        receiptVerified: false,
      },
    },
  });
  assert.equal(current.fixedControllerRelay.lastTransport, "desktop-ipc");
  assert.deepEqual(current.pendingFixedRelays.om_recovery, {
    phase: "activation_verified",
    desktopActivationAttempted: true,
    desktopActivationVerified: true,
    desktopActivationAttemptCount: 1,
    desktopDeliveryAttemptCount: 1,
    desktopRecoveryRetryAttempted: false,
    desktopLastDeliveryCode: "desktop_ipc_no_owner",
    desktopOwnerBusyStartedAt: 100,
    desktopOwnerBusyRetryCount: 2,
    receiptVerified: false,
  });
});

test("owner-busy recovery budget survives restart and stops by count", () => {
  const record = {
    desktopOwnerBusyStartedAt: 1000,
    desktopOwnerBusyRetryCount: 2,
  };
  const result = advanceFixedControllerOwnerBusyRetry(record, {
    now: 1500,
    maxWaitMs: 5000,
    maxRetries: 3,
  });
  assert.equal(result.retryCount, 3);
  assert.equal(result.elapsedMs, 500);
  assert.equal(result.expired, true);
  assert.equal(record.desktopOwnerBusyStartedAt, 1000);
  assert.equal(record.desktopOwnerBusyRetryCount, 3);
});

test("owner-busy recovery budget stops by elapsed time and can be cleared", () => {
  const record = {
    desktopOwnerBusyStartedAt: 1000,
    desktopOwnerBusyRetryCount: 1,
  };
  const result = advanceFixedControllerOwnerBusyRetry(record, {
    now: 6000,
    maxWaitMs: 5000,
    maxRetries: 100,
  });
  assert.equal(result.expired, true);
  clearFixedControllerOwnerBusyRetry(record);
  assert.equal("desktopOwnerBusyStartedAt" in record, false);
  assert.equal("desktopOwnerBusyRetryCount" in record, false);
});

test("state pruning expires old dedupe and relay records", () => {
  const now = 40 * 24 * 60 * 60 * 1000;
  const state = initialState();
  state.processedMessageIds = { old: 1, current: now };
  state.pendingFixedRelays = {
    old: { updatedAt: 1 },
    current: { updatedAt: now },
  };
  pruneState(state, now);
  assert.deepEqual(Object.keys(state.processedMessageIds), ["current"]);
  assert.deepEqual(Object.keys(state.pendingFixedRelays), ["current"]);
});

test("ordinary authorized P2P text goes unchanged to the fixed controller", () => {
  const routed = routeEvent(event({ content: "  模糊地帮我看一下  " }), config);
  assert.equal(routed.kind, "fixed-controller-relay");
  assert.equal(routed.text, "  模糊地帮我看一下  ");
});

test("legacy-looking commands are ordinary controller input", () => {
  for (const text of [
    "/codex archive 飞书 CLI 使用",
    "/tasks",
    "/task-create 测试",
    "/model",
    "/new",
    "CJ-D77F7E9D",
    "确认",
  ]) {
    const routed = routeEvent(event({ content: text }), config);
    assert.equal(routed.kind, "fixed-controller-relay", text);
    assert.equal(routed.text, text);
  }
});

test("only help and status are interpreted locally", () => {
  assert.deepEqual(routeEvent(event({ content: "/help" }), config).command, "help");
  assert.deepEqual(
    routeEvent(event({ content: " /STATUS " }), config).command,
    "status",
  );
});

test("attachments go directly to the fixed controller path", () => {
  for (const messageType of ["post", "image", "file", "audio", "video", "media"]) {
    const routed = routeEvent(event({ message_type: messageType }), config);
    assert.equal(routed.kind, "fixed-controller-relay");
    assert.equal(routed.attachment, true);
  }
});

test("unsupported message type gets a transport reply", () => {
  const routed = routeEvent(event({ message_type: "sticker" }), config);
  assert.equal(routed.kind, "reply");
  assert.match(routed.text, /暂不支持/);
});

test("empty text gets a transport reply", () => {
  const routed = routeEvent(event({ content: "   " }), config);
  assert.equal(routed.kind, "reply");
  assert.match(routed.text, /没有可转达/);
});

test("untrusted and non-P2P messages are ignored", () => {
  assert.equal(
    routeEvent(event({ sender_id: "ou_other" }), config).reason,
    "sender_not_allowed",
  );
  assert.equal(
    routeEvent(event({ sender_type: "bot" }), config).reason,
    "bot_sender",
  );
  assert.equal(
    routeEvent(event({ chat_type: "group" }), config).reason,
    "p2p_only",
  );
});

test("wrong event and malformed identifiers are ignored", () => {
  assert.equal(routeEvent(null, config).reason, "invalid_event");
  assert.equal(routeEvent(event({ type: "other" }), config).reason, "wrong_event_type");
  assert.equal(routeEvent(event({ message_id: "bad" }), config).reason, "missing_ids");
});

test("valid fixed-only configuration passes", () => {
  assert.deepEqual(validateConfig(config), []);
});

test("fixed controller binding is mandatory", () => {
  const { fixedControllerThreadId, ...missing } = config;
  assert.match(validateConfig(missing).join(";"), /fixedControllerThreadId/);
});

test("group chat configuration is rejected", () => {
  assert.match(
    validateConfig({ ...config, allowedGroupChatIds: ["oc_group"] }).join(";"),
    /group chat/,
  );
});

test("desktop visibility and absolute paths are validated", () => {
  assert.match(
    validateConfig({ ...config, fixedControllerDesktopVisibility: "sometimes" }).join(";"),
    /prefer, require, or off/,
  );
  assert.match(
    validateConfig({ ...config, runtimeDirectory: "relative" }).join(";"),
    /absolute path/,
  );
});

test("help describes relay only", () => {
  const text = commandReply("help");
  assert.match(text, /只负责双向转达/);
  assert.doesNotMatch(text, /秘书调查|\/codex|CJ-/);
});

test("status reports current relay evidence only", () => {
  const text = commandReply("status", {
    bridgeVersion: "0.12.4",
    targetReadable: true,
    pendingRelayCount: 0,
    lastTransport: "desktop-ipc",
    lastDesktopLiveVisible: true,
  });
  assert.match(text, /0\.12\.4/);
  assert.match(text, /desktop-ipc/);
  assert.match(text, /桌面可见：是/);
});

test("idempotency and failure receipts are stable and opaque", () => {
  assert.equal(idempotencyKey("same"), idempotencyKey("same"));
  assert.notEqual(idempotencyKey("same"), idempotencyKey("other"));
  assert.match(failureReceipt("om_secret", "relay"), /^[0-9A-F]{8}$/);
});

test("diagnostics redact private identifiers and credentials", () => {
  const text = sanitizeBridgeDiagnostic(
    "ou_abc oc_def om_ghi Bearer token123 access_token=secret 11111111-1111-4111-8111-111111111111",
  );
  assert.doesNotMatch(text, /ou_abc|oc_def|om_ghi|token123|secret|11111111/);
});

test("reply truncation is bounded", () => {
  assert.equal(truncateReply(" ok ", 100), "ok");
  const truncated = truncateReply("x".repeat(100), 50);
  assert.ok(truncated.length <= 50);
  assert.match(truncated, /回复过长/);
});

test("delivery reconciliation uses the persisted dispatch time", () => {
  const record = { createdAt: 100, dispatchingAt: 200, updatedAt: 300 };
  assert.equal(fixedControllerStartReconcileExpired(record, 259, 60), false);
  assert.equal(fixedControllerStartReconcileExpired(record, 260, 60), true);
});

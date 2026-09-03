import path from "node:path";

import {
  activateCodexDesktopThread,
  CodexDesktopIpcError,
  startCodexDesktopThreadTurn,
  verifyCodexDesktopThreadActivation,
} from "./codex-desktop-ipc.mjs";

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export const FIXED_CONTROLLER_RUNTIME_SANDBOX = "danger-full-access";
export const FIXED_CONTROLLER_RUNTIME_APPROVAL_POLICY = "never";

export function buildFixedControllerAppServerArgs() {
  return [
    "-s",
    FIXED_CONTROLLER_RUNTIME_SANDBOX,
    "-a",
    FIXED_CONTROLLER_RUNTIME_APPROVAL_POLICY,
  ];
}

export class FixedControllerRelayError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "FixedControllerRelayError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

function requireAppServer(appServer) {
  if (!appServer || typeof appServer.request !== "function") {
    throw new TypeError("appServer.request is required");
  }
}

function requireIdentifier(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}

function normalizeComparablePath(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return "";
  const windowsPath = /^[a-z]:[\\/]/i.test(candidate) || candidate.includes("\\");
  const normalized = windowsPath
    ? path.win32.normalize(candidate)
    : path.normalize(candidate);
  return normalized.replace(/[\\/]+$/, "").toLowerCase();
}

function threadStatus(thread) {
  if (typeof thread?.status === "string") return thread.status;
  return thread?.status?.type || "unknown";
}

function turnStatus(turn) {
  if (typeof turn?.status === "string") return turn.status;
  return turn?.status?.type || "unknown";
}

function isTerminalTurnStatus(status) {
  return [
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "canceled",
    "aborted",
  ].includes(status);
}

function finalAgentMessage(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== "agentMessage" || item.phase !== "final_answer") continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (text.trim()) return text;
  }
  if (turnStatus(turn) !== "completed") return "";
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== "agentMessage") continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (text.trim()) return text;
  }
  return "";
}

function normalizeInput(input) {
  if (typeof input === "string") {
    if (!input.trim()) throw new TypeError("input text must not be empty");
    return [{ type: "text", text: input }];
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("input must be a non-empty string or App Server input array");
  }
  return [...input];
}

export function buildFixedControllerAttachmentInput(options = {}) {
  const text = typeof options.text === "string" ? options.text : "";
  const attachmentPaths = [
    ...new Set(
      (options.attachmentPaths || [])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    ),
  ];
  const imagePaths = [
    ...new Set(
      (options.imagePaths || [])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    ),
  ];
  const sections = [];
  if (text) sections.push(text);
  if (attachmentPaths.length > 0) {
    sections.push(
      [
    "【飞书附件转述】以下文件已保存在本机，请结合用户的原始消息处理：",
        ...attachmentPaths.map((filePath) => `- ${filePath}`),
      ].join("\n"),
    );
  }
  if (sections.length === 0) {
    sections.push("用户发送了一条没有可提取文字的附件消息。");
  }
  return [
    { type: "text", text: sections.join("\n\n") },
    ...imagePaths.map((imagePath) => ({
      type: "localImage",
      path: imagePath,
    })),
  ];
}

function requestOptions(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : undefined;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new FixedControllerRelayError(
      "aborted",
      "fixed controller relay was aborted",
    );
  }
}

async function waitInterval(milliseconds, options = {}) {
  throwIfAborted(options.signal);
  if (typeof options.sleep === "function") {
    await options.sleep(milliseconds);
    throwIfAborted(options.signal);
    return;
  }
  await new Promise((resolve, reject) => {
    let onAbort;
    const finish = () => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    if (!options.signal) return;
    onAbort = () => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      reject(
        new FixedControllerRelayError(
          "aborted",
          "fixed controller relay was aborted",
        ),
      );
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateFixedControllerThread(thread, options = {}) {
  const threadId = requireIdentifier(options.threadId, "threadId");
  if (!thread) {
    throw new FixedControllerRelayError(
      options.missingCode || "target_unreachable",
      options.missingMessage || "fixed controller target returned no thread",
    );
  }
  if (thread.id !== threadId) {
    throw new FixedControllerRelayError(
      "target_identity_mismatch",
      "fixed controller target identity did not match",
    );
  }
  if (
    thread.archived === true ||
    thread.isArchived === true ||
    threadStatus(thread) === "archived"
  ) {
    throw new FixedControllerRelayError(
      "target_archived",
      "fixed controller target is archived",
    );
  }
  if (options.expectedCwd) {
    const expectedCwd = normalizeComparablePath(options.expectedCwd);
    const actualCwd = normalizeComparablePath(thread.cwd);
    if (!actualCwd || actualCwd !== expectedCwd) {
      throw new FixedControllerRelayError(
        "target_cwd_mismatch",
        "fixed controller target workspace does not match the configured workspace",
      );
    }
  }
  return thread;
}

export async function verifyFixedControllerTarget(appServer, options = {}) {
  requireAppServer(appServer);
  const threadId = requireIdentifier(options.threadId, "threadId");
  let result;
  try {
    result = await appServer.request(
      "thread/read",
      { threadId, includeTurns: options.includeTurns === true },
      requestOptions(options.timeoutMs),
    );
  } catch (error) {
    throw new FixedControllerRelayError(
      "target_unreachable",
      `fixed controller target is unreachable: ${error?.message || error}`,
      { cause: error },
    );
  }

  return validateFixedControllerThread(result?.thread || null, {
    threadId,
    expectedCwd: options.expectedCwd,
  });
}

async function resumeFixedControllerTarget(appServer, options = {}) {
  const threadId = requireIdentifier(options.threadId, "threadId");
  let result;
  try {
    result = await appServer.request(
      "thread/resume",
      {
        threadId,
        approvalPolicy: FIXED_CONTROLLER_RUNTIME_APPROVAL_POLICY,
        sandbox: FIXED_CONTROLLER_RUNTIME_SANDBOX,
      },
      requestOptions(options.timeoutMs),
    );
  } catch (error) {
    throw new FixedControllerRelayError(
      "target_resume_failed",
      `fixed controller target could not be resumed: ${error?.message || error}`,
      { cause: error },
    );
  }
  return validateFixedControllerThread(result?.thread || null, {
    threadId,
    expectedCwd: options.expectedCwd,
    missingCode: "target_resume_failed",
    missingMessage: "thread/resume returned no fixed controller target",
  });
}

export async function waitForFixedControllerIdle(appServer, options = {}) {
  const threadId = requireIdentifier(options.threadId, "threadId");
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : DEFAULT_IDLE_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.max(1, options.pollIntervalMs)
    : DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let resumeAttempted = false;

  while (true) {
    throwIfAborted(options.signal);
    const thread = await verifyFixedControllerTarget(appServer, {
      threadId,
      expectedCwd: options.expectedCwd,
      timeoutMs: options.requestTimeoutMs,
    });
    let status = threadStatus(thread);
    if (status === "notLoaded" && options.acceptNotLoaded === true) {
      return thread;
    }
    if (status === "notLoaded" && !resumeAttempted) {
      resumeAttempted = true;
      const resumed = await resumeFixedControllerTarget(appServer, {
        threadId,
        expectedCwd: options.expectedCwd,
        timeoutMs: options.requestTimeoutMs,
      });
      status = threadStatus(resumed);
      if (status === "idle") return resumed;
    }
    if (status === "idle") return thread;
    if (status !== "active") {
      throw new FixedControllerRelayError(
        "target_not_runnable",
        `fixed controller target is not runnable: ${status}`,
        { details: { status } },
      );
    }
    if (Date.now() >= deadline) {
      throw new FixedControllerRelayError(
        "target_busy_timeout",
        `fixed controller target stayed active for ${timeoutMs} ms`,
      );
    }
    await waitInterval(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), {
      signal: options.signal,
      sleep: options.sleep,
    });
  }
}

export async function startFixedControllerVisibleTurn(
  appServer,
  options = {},
) {
  requireAppServer(appServer);
  const threadId = requireIdentifier(options.threadId, "threadId");
  const input = normalizeInput(options.input);
  const target = await waitForFixedControllerIdle(appServer, {
    threadId,
    expectedCwd: options.expectedCwd,
    timeoutMs: options.idleTimeoutMs ?? options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    sleep: options.sleep,
    acceptNotLoaded: true,
  });

  let dispatchAttempted = false;
  let deliveryAttemptCount = Number.isFinite(
    Number(options.desktopDeliveryAttemptCount),
  )
    ? Math.max(0, Math.floor(Number(options.desktopDeliveryAttemptCount)))
    : 0;
  let activationAttempted = options.desktopActivationAttempted === true;
  let activationVerified = options.desktopActivationVerified === true;
  let recoveryRetryAttempted =
    options.desktopRecoveryRetryAttempted === true;
  let currentAttemptRecoveryRetry = false;
  let failedAttemptRecoveryRetry = false;
  let lastDeliveryCode =
    typeof options.desktopLastDeliveryCode === "string"
      ? options.desktopLastDeliveryCode
      : "";
  const starter = options.startDesktopTurn || startCodexDesktopThreadTurn;
  const activator =
    options.activateDesktopThread || activateCodexDesktopThread;
  const activationVerifier =
    options.verifyDesktopThreadActivation ||
    verifyCodexDesktopThreadActivation;
  const clientUserMessageId =
    typeof options.clientUserMessageId === "string" &&
    options.clientUserMessageId.trim()
      ? options.clientUserMessageId.trim()
      : undefined;
  const desktopEnvelope = {
    threadId,
    input,
    approvalPolicy: FIXED_CONTROLLER_RUNTIME_APPROVAL_POLICY,
    sandboxPolicy: { type: "dangerFullAccess" },
    clientUserMessageId,
    timeoutMs: options.desktopRequestTimeoutMs,
    ipcOptions: options.desktopIpcOptions,
    beforeDeliveryWrite: async () => {
      await consumeRecoveryRetryAllowanceBeforeDispatch();
      await options.onTransportDispatching?.("desktop-ipc");
      dispatchAttempted = true;
    },
  };

  const diagnostics = (error, extra = {}) => ({
    delivery:
      error instanceof CodexDesktopIpcError
        ? error.delivery
        : dispatchAttempted
          ? "unknown"
          : "not_dispatched",
    desktopCode:
      error instanceof CodexDesktopIpcError
        ? error.code
        : String(error?.code || "desktop_turn_start_failed"),
    activationAttempted,
    activationVerified,
    recoveryRetryAttempted,
    deliveryAttemptCount,
    lastDeliveryCode:
      error instanceof CodexDesktopIpcError
        ? error.code
        : lastDeliveryCode || undefined,
    receiptVerified: false,
    ...extra,
  });

  async function mapDesktopError(error, extra = {}) {
    if (error instanceof CodexDesktopIpcError) {
      lastDeliveryCode = error.code;
      const unknown = error.delivery === "unknown";
      const recoveryRetryReleased =
        failedAttemptRecoveryRetry &&
        recoveryRetryAttempted &&
        error.delivery === "not_dispatched" &&
        ["desktop_ipc_owner_busy", "desktop_ipc_owner_changed"].includes(
          error.code,
        );
      if (!unknown) {
        try {
          await options.onTransportNotDispatched?.("desktop-ipc", {
            code: error.code,
            delivery: error.delivery,
            recoveryRetryReleased,
          });
          if (recoveryRetryReleased) recoveryRetryAttempted = false;
        } catch (observerError) {
          return new FixedControllerRelayError(
            "desktop_recovery_state_persist_failed",
            "Desktop recovery state could not record a non-dispatch result",
            {
              cause: observerError,
              details: diagnostics(error, {
                observerStage: "transport_not_dispatched",
                observerCode: String(
                  observerError?.code || "observer_failed",
                ),
              }),
            },
          );
        }
      }
      if (
        error.code === "desktop_ipc_owner_busy" ||
        error.code === "desktop_ipc_owner_changed"
      ) {
        return new FixedControllerRelayError(
          "desktop_turn_owner_busy",
          "Desktop fixed controller owner changed or is currently busy",
          {
            cause: error,
            details: diagnostics(error, extra),
          },
        );
      }
      if (
        error.code === "desktop_recovery_state_persist_failed" ||
        error.code === "desktop_turn_recovery_limit_reached"
      ) {
        return new FixedControllerRelayError(
          error.code,
          error.message,
          {
            cause: error,
            details: diagnostics(error, error.details || {}),
          },
        );
      }
      return new FixedControllerRelayError(
        unknown
          ? "desktop_turn_start_outcome_unknown"
          : "desktop_turn_start_unavailable",
        unknown
          ? "Desktop visible turn start has an unknown outcome"
          : "Desktop visible turn start was not dispatched",
        {
          cause: error,
          details: diagnostics(error, extra),
        },
      );
    }
    if (dispatchAttempted) {
      return new FixedControllerRelayError(
        "desktop_turn_start_outcome_unknown",
        "Desktop visible turn start has an unknown outcome",
        {
          cause: error,
          details: diagnostics(error, {
            delivery: "unknown",
            ...extra,
          }),
        },
      );
    }
    return error;
  }

  function stateObserverError(stage, error, sourceError = error) {
    return new FixedControllerRelayError(
      "desktop_recovery_state_persist_failed",
      `Desktop recovery state observer failed at ${stage}`,
      {
        cause: error,
        details: diagnostics(sourceError, {
          observerStage: stage,
          observerCode: String(error?.code || "observer_failed"),
        }),
      },
    );
  }

  async function consumeRecoveryRetryAllowanceBeforeDispatch() {
    if (!currentAttemptRecoveryRetry) return;
    if (recoveryRetryAttempted) {
      throw new CodexDesktopIpcError(
        "desktop_turn_recovery_limit_reached",
        "Desktop recovery dispatch allowance was already consumed",
        { delivery: "not_dispatched" },
      );
    }
    recoveryRetryAttempted = true;
    try {
      await options.onDesktopRecoveryRetryRequested?.({
        attempt: 1,
        deliveryAttemptCount,
      });
    } catch (error) {
      throw new CodexDesktopIpcError(
        "desktop_recovery_state_persist_failed",
        "Desktop recovery dispatch allowance could not be persisted",
        {
          cause: error,
          delivery: "not_dispatched",
          details: {
            observerStage: "recovery_retry_requested",
            observerCode: String(error?.code || "observer_failed"),
          },
        },
      );
    }
  }

  async function startDesktopAttempt({ recoveryRetry = false } = {}) {
    if (recoveryRetry) {
      if (recoveryRetryAttempted) {
        throw new FixedControllerRelayError(
          "desktop_turn_recovery_limit_reached",
          "Desktop recovery retry allowance was already consumed",
          {
            details: diagnostics(
              new CodexDesktopIpcError(
                "desktop_ipc_no_owner",
                "Desktop recovery retry allowance was already consumed",
                { delivery: "not_dispatched" },
              ),
            ),
          },
        );
      }
    }
    deliveryAttemptCount += 1;
    lastDeliveryCode = "";
    currentAttemptRecoveryRetry = recoveryRetry;
    try {
      await options.onDesktopDeliveryAttempt?.({
        attempt: deliveryAttemptCount,
        recoveryRetry,
      });
    } catch (error) {
      currentAttemptRecoveryRetry = false;
      throw stateObserverError("delivery_attempt", error);
    }
    try {
      const result = await starter(desktopEnvelope);
      if (recoveryRetry && !recoveryRetryAttempted) {
        throw new FixedControllerRelayError(
          "desktop_turn_start_outcome_unknown",
          "Desktop recovery start returned without a persisted dispatch marker",
          {
            details: diagnostics(
              new CodexDesktopIpcError(
                "desktop_recovery_dispatch_marker_missing",
                "Desktop recovery dispatch marker was not observed",
                { delivery: "unknown" },
              ),
            ),
          },
        );
      }
      return result;
    } catch (error) {
      failedAttemptRecoveryRetry = recoveryRetry;
      throw error;
    } finally {
      currentAttemptRecoveryRetry = false;
    }
  }

  async function requireVerifiedActivation(
    operation,
    { sourceError, resumed = false } = {},
  ) {
    let activation;
    try {
      activation = await operation();
      if (
        activation?.activationVerified !== true ||
        (activation.threadId && activation.threadId !== threadId)
      ) {
        throw new CodexDesktopIpcError(
          "desktop_thread_activation_failed",
          "Codex Desktop exact-thread activation was not verified",
          {
            delivery: "not_dispatched",
            details: {
              activationRequested:
                activation?.activationRequested === true,
              activationVerified: false,
            },
          },
        );
      }
    } catch (activationError) {
      if (activationError?.code === "aborted") throw activationError;
      let failureObserverCode;
      try {
        await options.onDesktopActivationFailed?.({
          attempt: 1,
          resumed,
          code:
            activationError?.code || "desktop_thread_activation_failed",
        });
      } catch (observerError) {
        failureObserverCode = String(
          observerError?.code || "observer_failed",
        );
      }
      throw new FixedControllerRelayError(
        "desktop_turn_start_unavailable",
        "Desktop fixed controller activation could not be verified",
        {
          cause: activationError,
          details: diagnostics(sourceError || activationError, {
            activationCode:
              activationError?.code ||
              "desktop_thread_activation_failed",
            activationVerificationResumed: resumed,
            ...(failureObserverCode
              ? { failureObserverCode }
              : {}),
          }),
        },
      );
    }

    activationVerified = true;
    try {
      await options.onDesktopActivationVerified?.({
        attempt: 1,
        resumed,
        verificationAttempts: activation.verificationAttempts,
      });
    } catch (error) {
      throw stateObserverError(
        "activation_verified",
        error,
        sourceError || error,
      );
    }
    return activation;
  }

  let result;
  let firstError;
  const resumingConfirmedNoOwner =
    !activationAttempted &&
    deliveryAttemptCount > 0 &&
    ["desktop_ipc_no_owner", "desktop_ipc_no_turn_handler"].includes(
      lastDeliveryCode,
    );
  const resumingOwnerWait =
    !activationAttempted &&
    deliveryAttemptCount > 0 &&
    ["desktop_ipc_owner_busy", "desktop_ipc_owner_changed"].includes(
      lastDeliveryCode,
    );

  if (
    activationAttempted &&
    !activationVerified &&
    !recoveryRetryAttempted
  ) {
    await requireVerifiedActivation(
      () =>
        activationVerifier({
          threadId,
          hostId: "local",
          activationTimeoutMs: options.desktopActivationTimeoutMs,
          ownerSnapshotTimeoutMs:
            options.desktopActivationOwnerSnapshotTimeoutMs,
          pollIntervalMs: options.desktopActivationPollIntervalMs,
          ipcOptions: options.desktopIpcOptions,
          signal: options.signal,
        }),
      {
        sourceError: new CodexDesktopIpcError(
          lastDeliveryCode || "desktop_ipc_no_owner",
          "Desktop activation verification resumed after restart",
          { delivery: "not_dispatched" },
        ),
        resumed: true,
      },
    );
  }

  if (activationAttempted) {
    try {
      result = await startDesktopAttempt({ recoveryRetry: true });
    } catch (error) {
      throw await mapDesktopError(error);
    }
  } else if (resumingConfirmedNoOwner) {
    firstError = new CodexDesktopIpcError(
      lastDeliveryCode,
      "Desktop exact-thread non-dispatch result was confirmed before restart",
      { delivery: "not_dispatched" },
    );
  } else if (deliveryAttemptCount === 0 || resumingOwnerWait) {
    try {
      result = await startDesktopAttempt();
    } catch (error) {
      firstError = error;
    }
  } else {
    throw new FixedControllerRelayError(
      "desktop_turn_recovery_state_unknown",
      "Desktop delivery was interrupted before a safe recovery outcome was persisted",
      {
        details: diagnostics(
          new CodexDesktopIpcError(
            "desktop_delivery_state_unknown",
            "Desktop delivery state is incomplete",
            { delivery: "unknown" },
          ),
        ),
      },
    );
  }

  if (firstError) {
    const canActivate =
      firstError instanceof CodexDesktopIpcError &&
      ["desktop_ipc_no_owner", "desktop_ipc_no_turn_handler"].includes(
        firstError.code,
      ) &&
      firstError.delivery === "not_dispatched" &&
      !dispatchAttempted &&
      !activationAttempted;
    if (!canActivate) throw await mapDesktopError(firstError);

    if (!resumingConfirmedNoOwner) {
      try {
        await options.onTransportNotDispatched?.("desktop-ipc", {
          code: firstError.code,
          delivery: firstError.delivery,
        });
      } catch (error) {
        throw stateObserverError(
          "transport_not_dispatched",
          error,
          firstError,
        );
      }
    }
    activationAttempted = true;
    try {
      await options.onDesktopActivationRequested?.({
        attempt: 1,
        deliveryAttemptCount,
      });
    } catch (error) {
      throw stateObserverError(
        "activation_requested",
        error,
        firstError,
      );
    }

    await requireVerifiedActivation(
      () =>
        activator({
          threadId,
          hostId: "local",
          activationTimeoutMs: options.desktopActivationTimeoutMs,
          ownerSnapshotTimeoutMs:
            options.desktopActivationOwnerSnapshotTimeoutMs,
          pollIntervalMs: options.desktopActivationPollIntervalMs,
          ipcOptions: options.desktopIpcOptions,
          signal: options.signal,
        }),
      { sourceError: firstError },
    );

    try {
      result = await startDesktopAttempt({ recoveryRetry: true });
    } catch (retryError) {
      throw await mapDesktopError(retryError);
    }
  }

  const turnId = requireIdentifier(result?.turnId, "turnId");
  return {
    threadId,
    turnId,
    turn: result.turn || null,
    target,
    transport: "desktop-ipc",
    desktopLiveVisible: true,
    activationAttempted,
    activationVerified,
    deliveryAttemptCount,
    receiptVerified: true,
  };
}

export async function startFixedControllerTurnPreferDesktop(
  appServer,
  options = {},
) {
  if (options.desktopVisibilityEnabled !== false) {
    try {
      return await startFixedControllerVisibleTurn(appServer, options);
    } catch (error) {
      if (
        error?.code !== "desktop_turn_start_unavailable" ||
        options.allowHeadlessFallback !== true
      ) {
        throw error;
      }
    }
  }

  if (options.allowHeadlessFallback !== true) {
    throw new FixedControllerRelayError(
      "desktop_turn_start_unavailable",
      "Desktop-visible delivery is required and headless fallback is disabled",
    );
  }

  const execution = await startFixedControllerTurn(appServer, options);
  return {
    ...execution,
    transport: "dedicated-app-server",
    desktopLiveVisible: false,
  };
}

export async function startFixedControllerTurn(appServer, options = {}) {
  requireAppServer(appServer);
  const threadId = requireIdentifier(options.threadId, "threadId");
  const input = normalizeInput(options.input);
  const target = await waitForFixedControllerIdle(appServer, {
    threadId,
    expectedCwd: options.expectedCwd,
    timeoutMs: options.idleTimeoutMs ?? options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    sleep: options.sleep,
  });

  let result;
  try {
    const params = {
      threadId,
      input,
      approvalPolicy: FIXED_CONTROLLER_RUNTIME_APPROVAL_POLICY,
      sandboxPolicy: { type: "dangerFullAccess" },
    };
    if (
      typeof options.clientUserMessageId === "string" &&
      options.clientUserMessageId.trim()
    ) {
      params.clientUserMessageId = options.clientUserMessageId.trim();
    }
    await options.onTransportDispatching?.("dedicated-app-server");
    result = await appServer.request(
      "turn/start",
      params,
      requestOptions(options.requestTimeoutMs),
    );
  } catch (error) {
    throw new FixedControllerRelayError(
      "turn_start_failed",
      `fixed controller turn could not start: ${error?.message || error}`,
      { cause: error },
    );
  }
  const turn = result?.turn || null;
  const turnId = typeof turn?.id === "string" ? turn.id.trim() : "";
  if (!turnId) {
    throw new FixedControllerRelayError(
      "turn_start_failed",
      "turn/start returned no turn id",
    );
  }
  return { threadId, turnId, turn, target };
}

export async function findFixedControllerTurnByClientMessageId(
  appServer,
  options = {},
) {
  const threadId = requireIdentifier(options.threadId, "threadId");
  const clientUserMessageId = requireIdentifier(
    options.clientUserMessageId,
    "clientUserMessageId",
  );
  const thread = await verifyFixedControllerTarget(appServer, {
    threadId,
    expectedCwd: options.expectedCwd,
    timeoutMs: options.requestTimeoutMs,
    includeTurns: true,
  });
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const matches = new Map();
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const matched = items.some(
      (item) =>
        item?.type === "userMessage" &&
        (item.clientId === clientUserMessageId ||
          item.client_id === clientUserMessageId),
    );
    if (matched && typeof turn?.id === "string" && turn.id.trim()) {
      matches.set(turn.id.trim(), turn);
    }
  }
  if (matches.size === 0) return null;
  if (matches.size > 1) {
    throw new FixedControllerRelayError(
      "turn_correlation_ambiguous",
      "multiple fixed-controller turns matched one client message id",
      { details: { matchCount: matches.size } },
    );
  }
  const turn = matches.values().next().value;
  return { threadId, turnId: turn.id.trim(), turn, thread };
}

export async function waitForFixedControllerTurn(appServer, options = {}) {
  const threadId = requireIdentifier(options.threadId, "threadId");
  const turnId = requireIdentifier(options.turnId, "turnId");
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : DEFAULT_TURN_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.max(1, options.pollIntervalMs)
    : DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    throwIfAborted(options.signal);
    const thread = await verifyFixedControllerTarget(appServer, {
      threadId,
      expectedCwd: options.expectedCwd,
      timeoutMs: options.requestTimeoutMs,
      includeTurns: true,
    });
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const turn = turns.find((candidate) => candidate?.id === turnId) || null;
    const status = turn ? turnStatus(turn) : "not_found";
    const finalText = turn ? finalAgentMessage(turn) : "";
    const detachedDesktopSnapshot =
      options.deferDetachedDesktopStatuses === true &&
      isTerminalTurnStatus(status) &&
      status !== "completed" &&
      !finalText;
    if (turn && isTerminalTurnStatus(status) && !detachedDesktopSnapshot) {
      return {
        threadId,
        turnId,
        status,
        finalText,
        error: turn.error || null,
        turn,
        thread,
      };
    }
    if (Date.now() >= deadline) {
      if (turn && detachedDesktopSnapshot) {
        return {
          threadId,
          turnId,
          status,
          finalText,
          turn,
          thread,
        };
      }
      throw new FixedControllerRelayError(
        "turn_timeout",
        `fixed controller turn ${turnId} did not reach a terminal state within ${timeoutMs} ms`,
        { details: { lastStatus: status } },
      );
    }
    await waitInterval(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), {
      signal: options.signal,
      sleep: options.sleep,
    });
  }
}

export async function runFixedControllerRelay(appServer, options = {}) {
  const execution = await startFixedControllerTurn(appServer, options);
  const completion = await waitForFixedControllerTurn(appServer, {
    threadId: execution.threadId,
    turnId: execution.turnId,
    expectedCwd: options.expectedCwd,
    timeoutMs: options.turnTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    sleep: options.sleep,
  });
  return {
    target: execution.target,
    execution: {
      threadId: execution.threadId,
      turnId: execution.turnId,
      turn: execution.turn,
    },
    completion,
  };
}

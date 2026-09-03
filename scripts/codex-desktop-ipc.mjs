import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

export const CODEX_DESKTOP_IPC_PIPE = String.raw`\\.\pipe\codex-ipc`;
export const CODEX_DESKTOP_IPC_MAX_FRAME_BYTES = 256 * 1024 * 1024;

const METHOD_VERSIONS = new Map([
  ["initialize", 0],
  ["thread-follower-load-complete-history", 1],
  ["thread-follower-start-turn", 2],
]);

const CODEX_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRYABLE_ACTIVATION_CODES = new Set([
  "desktop_unavailable",
  "desktop_ipc_connection_closed",
  "desktop_ipc_initialize_failed",
  "desktop_ipc_no_owner",
  "desktop_ipc_request_timeout",
]);

export class CodexDesktopIpcError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodexDesktopIpcError";
    this.code = code;
    this.delivery = options.delivery || "not_dispatched";
    if (options.details !== undefined) this.details = options.details;
  }
}

function requireCodexThreadId(value) {
  const threadId = typeof value === "string" ? value.trim() : "";
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
    throw new CodexDesktopIpcError(
      "desktop_thread_activation_invalid_target",
      "Codex Desktop activation requires one exact thread id",
      { delivery: "not_dispatched" },
    );
  }
  return threadId;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Codex Desktop activation was aborted");
  error.code = "aborted";
  throw error;
}

export function buildCodexDesktopThreadDeepLink(threadId) {
  return `codex://threads/${requireCodexThreadId(threadId)}`;
}

export async function openCodexDesktopThreadDeepLink(options = {}) {
  const threadId = requireCodexThreadId(options.threadId);
  throwIfAborted(options.signal);
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    throw new CodexDesktopIpcError(
      "desktop_thread_activation_unsupported",
      "Codex Desktop thread activation is only supported on Windows",
      { delivery: "not_dispatched" },
    );
  }
  const deepLink =
    typeof options.deepLink === "string" && options.deepLink
      ? options.deepLink
      : buildCodexDesktopThreadDeepLink(threadId);
  if (deepLink !== buildCodexDesktopThreadDeepLink(threadId)) {
    throw new CodexDesktopIpcError(
      "desktop_thread_activation_invalid_target",
      "Codex Desktop activation deep link does not match the exact thread id",
      { delivery: "not_dispatched" },
    );
  }

  const spawnProcess = options.spawnProcess || spawn;
  const launchTimeoutMs = Number.isFinite(options.launchTimeoutMs)
    ? Math.max(1, Number(options.launchTimeoutMs))
    : 5000;
  const windowsDirectory =
    String(
      options.windowsDirectory ||
        process.env.WINDIR ||
        process.env.SystemRoot ||
        String.raw`C:\Windows`,
    ).trim() || String.raw`C:\Windows`;
  const explorerPath = path.join(windowsDirectory, "explorer.exe");
  let child;
  try {
    child = spawnProcess(explorerPath, [deepLink], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref?.();
  } catch (error) {
    throw new CodexDesktopIpcError(
      "desktop_thread_activation_failed",
      `Codex Desktop activation request failed: ${normalizeErrorCode(error)}`,
      { cause: error, delivery: "not_dispatched" },
    );
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off?.("spawn", onSpawn);
      child.off?.("error", onError);
      options.signal?.removeEventListener?.("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onSpawn = () => {
      settle(resolve);
    };
    const onError = (error) => {
      settle(
        reject,
        new CodexDesktopIpcError(
          "desktop_thread_activation_failed",
          `Codex Desktop activation request failed: ${normalizeErrorCode(error)}`,
          { cause: error, delivery: "not_dispatched" },
        ),
      );
    };
    const onAbort = () => {
      const error = new Error("Codex Desktop activation was aborted");
      error.code = "aborted";
      settle(reject, error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settle(
        reject,
        new CodexDesktopIpcError(
          "desktop_thread_activation_launch_timeout",
          "Codex Desktop activation request did not reach the Windows protocol handler in time",
          { delivery: "not_dispatched" },
        ),
      );
    }, launchTimeoutMs);
    if (options.signal?.aborted) onAbort();
  });
  return {
    activationRequested: true,
    activationVerified: false,
  };
}

async function verifyCodexDesktopThreadOwner(options = {}) {
  const client = new CodexDesktopIpcClient(options.ipcOptions);
  try {
    return await client.followThreadSnapshot({
      conversationId: options.threadId,
      hostId: options.hostId || "local",
      timeoutMs: options.timeoutMs,
    });
  } finally {
    client.close();
  }
}

export async function verifyCodexDesktopThreadActivation(options = {}) {
  const threadId = requireCodexThreadId(options.threadId);
  throwIfAborted(options.signal);
  const activationTimeoutMs = Number.isFinite(options.activationTimeoutMs)
    ? Math.max(1, options.activationTimeoutMs)
    : 10000;
  const ownerSnapshotTimeoutMs = Number.isFinite(
    options.ownerSnapshotTimeoutMs,
  )
    ? Math.max(1, options.ownerSnapshotTimeoutMs)
    : 1000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.max(0, options.pollIntervalMs)
    : 100;
  const now = options.now || Date.now;
  const sleep = options.sleep || wait;
  const verifyThreadOwner =
    options.verifyThreadOwner ||
    ((request) =>
      verifyCodexDesktopThreadOwner({
        ...request,
        ipcOptions: options.ipcOptions,
      }));

  const deadline = now() + activationTimeoutMs;
  let verificationAttempts = 0;
  let lastError = null;
  while (true) {
    throwIfAborted(options.signal);
    const currentTime = now();
    if (currentTime >= deadline) break;
    verificationAttempts += 1;
    try {
      const snapshot = await verifyThreadOwner({
        threadId,
        hostId: options.hostId || "local",
        timeoutMs: Math.min(
          ownerSnapshotTimeoutMs,
          Math.max(1, deadline - currentTime),
        ),
      });
      if (!String(snapshot?.ownerClientId || "").trim()) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "Codex Desktop activation returned no exact-thread owner",
          { delivery: "not_dispatched" },
        );
      }
      return {
        threadId,
        activationRequested: true,
        activationVerified: true,
        verificationAttempts,
        revision: snapshot.revision,
      };
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof CodexDesktopIpcError) ||
        !RETRYABLE_ACTIVATION_CODES.has(error.code)
      ) {
        throw new CodexDesktopIpcError(
          "desktop_thread_activation_failed",
          `Codex Desktop activation verification failed: ${normalizeErrorCode(error)}`,
          {
            cause: error,
            delivery: "not_dispatched",
            details: {
              activationRequested: true,
              activationVerified: false,
              verificationAttempts,
            },
          },
        );
      }
    }
    const afterAttempt = now();
    if (afterAttempt >= deadline) break;
    await sleep(Math.min(pollIntervalMs, deadline - afterAttempt));
  }

  throw new CodexDesktopIpcError(
    "desktop_thread_activation_timeout",
    "Codex Desktop exact-thread activation could not be verified",
    {
      cause: lastError || undefined,
      delivery: "not_dispatched",
      details: {
        activationRequested: true,
        activationVerified: false,
        verificationAttempts,
        lastCode: lastError?.code || "desktop_ipc_no_owner",
      },
    },
  );
}

export async function activateCodexDesktopThread(options = {}) {
  const threadId = requireCodexThreadId(options.threadId);
  throwIfAborted(options.signal);
  const deepLink = buildCodexDesktopThreadDeepLink(threadId);
  const openThread =
    options.openThread ||
    ((request) =>
      openCodexDesktopThreadDeepLink({
        ...request,
        platform: options.platform,
        spawnProcess: options.spawnProcess,
        windowsDirectory: options.windowsDirectory,
        launchTimeoutMs: options.activationLaunchTimeoutMs,
        signal: options.signal,
      }));

  try {
    await openThread({ threadId, deepLink, signal: options.signal });
  } catch (error) {
    if (error?.code === "aborted") throw error;
    if (error instanceof CodexDesktopIpcError) throw error;
    throw new CodexDesktopIpcError(
      "desktop_thread_activation_failed",
      `Codex Desktop activation request failed: ${normalizeErrorCode(error)}`,
      {
        cause: error,
        delivery: "not_dispatched",
        details: {
          activationRequested: false,
          activationVerified: false,
        },
      },
    );
  }

  return verifyCodexDesktopThreadActivation({
    ...options,
    threadId,
  });
}

export function encodeCodexDesktopIpcFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (
    body.length === 0 ||
    body.length > CODEX_DESKTOP_IPC_MAX_FRAME_BYTES
  ) {
    throw new CodexDesktopIpcError(
      "desktop_ipc_invalid_frame",
      `Codex Desktop IPC frame length is invalid: ${body.length}`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function buildCodexDesktopDiscoveryResponse(message) {
  if (
    message?.type !== "client-discovery-request" ||
    typeof message?.requestId !== "string" ||
    !message.requestId
  ) {
    return null;
  }
  return {
    type: "client-discovery-response",
    requestId: message.requestId,
    response: { canHandle: false },
  };
}

export class CodexDesktopIpcFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (
        length === 0 ||
        length > CODEX_DESKTOP_IPC_MAX_FRAME_BYTES
      ) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_invalid_frame",
          `Codex Desktop IPC frame length is invalid: ${length}`,
        );
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch (error) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_invalid_json",
          "Codex Desktop IPC returned invalid JSON",
          { cause: error },
        );
      }
    }
    return messages;
  }
}

function normalizeErrorCode(error) {
  const value = String(error?.code || error?.message || error || "unknown");
  return value.slice(0, 120);
}

function methodVersion(method) {
  const version = METHOD_VERSIONS.get(method);
  if (version === undefined) {
    throw new CodexDesktopIpcError(
      "desktop_ipc_unsupported_method",
      `Unsupported Codex Desktop IPC method: ${method}`,
    );
  }
  return version;
}

export class CodexDesktopIpcClient {
  constructor(options = {}) {
    this.pipePath = options.pipePath || CODEX_DESKTOP_IPC_PIPE;
    this.clientType = options.clientType || "lark_codex_bridge";
    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs)
      ? Math.max(1, options.connectTimeoutMs)
      : 5000;
    this.initializeTimeoutMs = Number.isFinite(options.initializeTimeoutMs)
      ? Math.max(1, options.initializeTimeoutMs)
      : 5000;
    this.createConnection =
      options.createConnection || ((pipePath) => net.createConnection(pipePath));
    this.socket = null;
    this.decoder = new CodexDesktopIpcFrameDecoder();
    this.pending = new Map();
    this.broadcastWaiters = new Set();
    this.clientId = "initializing-client";
    this.connected = false;
    this.closed = false;
  }

  async connect() {
    if (this.connected) return;
    if (this.closed) {
      throw new CodexDesktopIpcError(
        "desktop_ipc_closed",
        "Codex Desktop IPC client is closed",
      );
    }

    let socket;
    try {
      socket = this.createConnection(this.pipePath);
    } catch (error) {
      throw new CodexDesktopIpcError(
        "desktop_unavailable",
        `Codex Desktop IPC is unavailable: ${normalizeErrorCode(error)}`,
        { cause: error },
      );
    }
    this.socket = socket;
    this.#attachSocket(socket);

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        handler(value);
      };
      const onConnect = () => finish(resolve);
      const onError = (error) =>
        finish(
          reject,
          new CodexDesktopIpcError(
            "desktop_unavailable",
            `Codex Desktop IPC is unavailable: ${normalizeErrorCode(error)}`,
            { cause: error },
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            reject,
            new CodexDesktopIpcError(
              "desktop_unavailable",
              "Codex Desktop IPC connection timed out",
            ),
          ),
        this.connectTimeoutMs,
      );
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

    const response = await this.#request(
      "initialize",
      { clientType: this.clientType },
      {
        timeoutMs: this.initializeTimeoutMs,
        deliverySensitive: false,
      },
    );
    const clientId =
      response?.resultType === "success" &&
      typeof response?.result?.clientId === "string"
        ? response.result.clientId.trim()
        : "";
    if (!clientId) {
      throw new CodexDesktopIpcError(
        "desktop_ipc_initialize_failed",
        `Codex Desktop IPC initialization failed: ${String(
          response?.error || "invalid response",
        ).slice(0, 120)}`,
      );
    }
    this.clientId = clientId;
    this.connected = true;
  }

  async request(method, params, options = {}) {
    await this.connect();
    if (typeof options.beforeDeliveryWrite === "function") {
      try {
        await options.beforeDeliveryWrite();
      } catch (error) {
        if (error instanceof CodexDesktopIpcError) throw error;
        throw new CodexDesktopIpcError(
          "desktop_ipc_dispatch_marker_failed",
          `Codex Desktop dispatch marker failed: ${normalizeErrorCode(error)}`,
          { cause: error, delivery: "not_dispatched" },
        );
      }
    }
    const response = await this.#request(method, params, {
      timeoutMs: options.timeoutMs,
      deliverySensitive: options.deliverySensitive === true,
      targetClientId: options.targetClientId,
      version: options.version,
    });
    if (response?.resultType === "success") return response;
    const remoteError = String(response?.error || "unknown").slice(0, 120);
    const definitelyNotDispatched = remoteError === "no-client-found";
    const ownerChanged =
      definitelyNotDispatched &&
      typeof options.targetClientId === "string" &&
      options.targetClientId.trim();
    const delivery = definitelyNotDispatched
      ? "not_dispatched"
      : options.deliverySensitive === true
        ? "unknown"
        : "not_dispatched";
    throw new CodexDesktopIpcError(
      ownerChanged
        ? "desktop_ipc_owner_changed"
        : definitelyNotDispatched
        ? "desktop_ipc_no_turn_handler"
        : delivery === "unknown"
        ? "desktop_ipc_outcome_unknown"
        : "desktop_ipc_no_owner",
      `Codex Desktop IPC request failed: ${remoteError}`,
      { delivery, details: { remoteError } },
    );
  }

  async followThreadSnapshot(options = {}) {
    await this.connect();
    const conversationId = String(options.conversationId || "").trim();
    const hostId = String(options.hostId || "local").trim();
    if (!conversationId || !hostId) {
      throw new CodexDesktopIpcError(
        "desktop_ipc_invalid_follow_target",
        "Codex Desktop follow target is invalid",
      );
    }
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : 5000;
    const snapshotPromise = this.#waitForBroadcast(
      (message) =>
        message?.method === "thread-stream-state-changed" &&
        message?.version === 11 &&
        message?.params?.conversationId === conversationId &&
        message?.params?.hostId === hostId &&
        message?.params?.change?.type === "snapshot",
      timeoutMs,
    );
    const message = {
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: this.clientId,
      version: 1,
      params: { conversationId, hostId, following: true },
    };
    try {
      this.socket.write(encodeCodexDesktopIpcFrame(message));
    } catch (error) {
      const followError = new CodexDesktopIpcError(
        "desktop_unavailable",
        `Codex Desktop follow request failed: ${normalizeErrorCode(error)}`,
        { cause: error },
      );
      this.#rejectBroadcastWaiters(followError);
      await snapshotPromise.catch(() => {});
      throw followError;
    }
    let snapshot;
    try {
      snapshot = await snapshotPromise;
    } catch (error) {
      if (error instanceof CodexDesktopIpcError) throw error;
      throw new CodexDesktopIpcError(
        "desktop_ipc_no_owner",
        "Codex Desktop task owner did not return a state snapshot",
        { cause: error, delivery: "not_dispatched" },
      );
    }
    const ownerClientId = String(snapshot?.sourceClientId || "").trim();
    if (!ownerClientId) {
      throw new CodexDesktopIpcError(
        "desktop_ipc_no_owner",
        "Codex Desktop task owner snapshot has no owner id",
        { delivery: "not_dispatched" },
      );
    }
    return {
      ownerClientId,
      conversationState: snapshot.params.change.conversationState || {},
      revision: snapshot.params.change.revision,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    const error = new CodexDesktopIpcError(
      "desktop_ipc_closed",
      "Codex Desktop IPC client closed",
      { delivery: "unknown" },
    );
    this.#rejectPending(error);
    this.#rejectBroadcastWaiters(error);
    this.socket?.end?.();
    this.socket = null;
  }

  #attachSocket(socket) {
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = this.decoder.push(chunk);
      } catch (error) {
        this.#rejectPending(error);
        socket.destroy?.();
        return;
      }
      for (const message of messages) {
        const discoveryResponse = buildCodexDesktopDiscoveryResponse(message);
        if (discoveryResponse) {
          try {
            socket.write(encodeCodexDesktopIpcFrame(discoveryResponse));
          } catch (error) {
            this.#rejectPending(
              new CodexDesktopIpcError(
                "desktop_ipc_connection_closed",
                `Codex Desktop IPC discovery response failed: ${normalizeErrorCode(error)}`,
                { cause: error, delivery: "unknown" },
              ),
            );
            socket.destroy?.();
          }
          continue;
        }
        if (message?.type === "broadcast") {
          for (const waiter of [...this.broadcastWaiters]) {
            let matched = false;
            try {
              matched = waiter.predicate(message) === true;
            } catch {
              matched = false;
            }
            if (!matched) continue;
            this.broadcastWaiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
          continue;
        }
        if (message?.type !== "response") continue;
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    });
    socket.on("error", (error) => {
      this.#rejectPending(
        new CodexDesktopIpcError(
          "desktop_ipc_connection_closed",
          `Codex Desktop IPC connection failed: ${normalizeErrorCode(error)}`,
          { cause: error, delivery: "unknown" },
        ),
      );
      this.#rejectBroadcastWaiters(
        new CodexDesktopIpcError(
          "desktop_ipc_connection_closed",
          `Codex Desktop IPC connection failed: ${normalizeErrorCode(error)}`,
          { cause: error, delivery: "not_dispatched" },
        ),
      );
    });
    socket.on("close", () => {
      this.connected = false;
      this.#rejectPending(
        new CodexDesktopIpcError(
          "desktop_ipc_connection_closed",
          "Codex Desktop IPC connection closed",
          { delivery: "unknown" },
        ),
      );
      this.#rejectBroadcastWaiters(
        new CodexDesktopIpcError(
          "desktop_ipc_connection_closed",
          "Codex Desktop IPC connection closed",
          { delivery: "not_dispatched" },
        ),
      );
    });
  }

  #request(method, params, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : 20000;
    const socket = this.socket;
    if (!socket?.writable) {
      throw new CodexDesktopIpcError(
        "desktop_unavailable",
        "Codex Desktop IPC socket is not writable",
      );
    }
    const requestId = randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version: Number.isInteger(options.version)
        ? options.version
        : methodVersion(method),
      method,
      params,
      timeoutMs,
      ...(typeof options.targetClientId === "string" &&
      options.targetClientId.trim()
        ? { targetClientId: options.targetClientId.trim() }
        : {}),
    };
    const frame = encodeCodexDesktopIpcFrame(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new CodexDesktopIpcError(
            options.deliverySensitive
              ? "desktop_ipc_outcome_unknown"
              : "desktop_ipc_request_timeout",
            `Codex Desktop IPC request timed out: ${method}`,
            {
              delivery: options.deliverySensitive ? "unknown" : "not_dispatched",
            },
          ),
        );
      }, timeoutMs);
      this.pending.set(requestId, {
        deliverySensitive: options.deliverySensitive,
        reject,
        resolve,
        timer,
      });
      try {
        socket.write(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          new CodexDesktopIpcError(
            options.deliverySensitive
              ? "desktop_ipc_outcome_unknown"
              : "desktop_unavailable",
            `Codex Desktop IPC write failed: ${normalizeErrorCode(error)}`,
            {
              cause: error,
              delivery: options.deliverySensitive ? "unknown" : "not_dispatched",
            },
          ),
        );
      }
    });
  }

  #rejectPending(error) {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(
        new CodexDesktopIpcError(
          pending.deliverySensitive
            ? "desktop_ipc_outcome_unknown"
            : error.code || "desktop_ipc_connection_closed",
          error.message,
          {
            cause: error,
            delivery: pending.deliverySensitive ? "unknown" : "not_dispatched",
          },
        ),
      );
    }
  }

  #waitForBroadcast(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.broadcastWaiters.delete(waiter);
        reject(new Error("Codex Desktop broadcast timed out"));
      }, timeoutMs);
      this.broadcastWaiters.add(waiter);
    });
  }

  #rejectBroadcastWaiters(error) {
    for (const waiter of [...this.broadcastWaiters]) {
      this.broadcastWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export async function requestCodexDesktopIpc(method, params, options = {}) {
  const client = new CodexDesktopIpcClient(options);
  try {
    return await client.request(method, params, options);
  } finally {
    client.close();
  }
}

export async function startCodexDesktopThreadTurn(options = {}) {
  const client = new CodexDesktopIpcClient(options.ipcOptions);
  try {
    const owner = await client.followThreadSnapshot({
      conversationId: options.threadId,
      hostId: options.hostId || "local",
      timeoutMs: options.ownerSnapshotTimeoutMs || 5000,
    });
    if (!isCodexDesktopConversationIdle(owner.conversationState)) {
      throw new CodexDesktopIpcError(
        "desktop_ipc_owner_busy",
        "Codex Desktop task owner is not idle",
        { delivery: "not_dispatched" },
      );
    }
    let confirmedOwner;
    try {
      confirmedOwner = await client.followThreadSnapshot({
        conversationId: options.threadId,
        hostId: options.hostId || "local",
        timeoutMs: options.ownerSnapshotTimeoutMs || 5000,
      });
    } catch (error) {
      if (
        error instanceof CodexDesktopIpcError &&
        error.delivery === "not_dispatched"
      ) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_owner_changed",
          "Codex Desktop task owner disappeared before dispatch",
          { cause: error, delivery: "not_dispatched" },
        );
      }
      throw error;
    }
    if (confirmedOwner.ownerClientId !== owner.ownerClientId) {
      throw new CodexDesktopIpcError(
        "desktop_ipc_owner_changed",
        "Codex Desktop task owner changed before dispatch",
        { delivery: "not_dispatched" },
      );
    }
    if (!isCodexDesktopConversationIdle(confirmedOwner.conversationState)) {
      throw new CodexDesktopIpcError(
        "desktop_ipc_owner_busy",
        "Codex Desktop task owner became busy before dispatch",
        { delivery: "not_dispatched" },
      );
    }
    const requestOptions = {
      timeoutMs: options.timeoutMs || 20000,
      deliverySensitive: true,
      targetClientId: confirmedOwner.ownerClientId,
      beforeDeliveryWrite: options.beforeDeliveryWrite,
    };
    let response;
    try {
      response = await client.request(
        "thread-follower-start-turn",
        {
          conversationId: options.threadId,
          turnStart: {
            request: {
              threadId: options.threadId,
              input: options.input,
              ...(options.clientUserMessageId
                ? { clientUserMessageId: options.clientUserMessageId }
                : {}),
            },
            context: { inheritThreadSettings: true },
          },
        },
        { ...requestOptions, version: 2 },
      );
    } catch (error) {
      const v2NotHandled =
        error instanceof CodexDesktopIpcError &&
        error.delivery === "not_dispatched" &&
        error.details?.remoteError === "no-client-found";
      if (!v2NotHandled) throw error;
      try {
        response = await client.request(
          "thread-follower-start-turn",
          {
            conversationId: options.threadId,
            turnStartParams: {
              input: options.input,
              approvalPolicy: options.approvalPolicy,
              sandboxPolicy: options.sandboxPolicy,
              ...(options.clientUserMessageId
                ? { clientUserMessageId: options.clientUserMessageId }
                : {}),
            },
          },
          { ...requestOptions, version: 1, beforeDeliveryWrite: undefined },
        );
      } catch (legacyError) {
        if (
          legacyError instanceof CodexDesktopIpcError &&
          legacyError.delivery === "not_dispatched" &&
          legacyError.details?.remoteError === "no-client-found"
        ) {
          throw new CodexDesktopIpcError(
            "desktop_ipc_no_turn_handler",
            "Codex Desktop owner exposes no compatible turn-start handler",
            {
              cause: legacyError,
              delivery: "not_dispatched",
              details: { remoteError: "no-client-found", attemptedVersions: [2, 1] },
            },
          );
        }
        throw legacyError;
      }
    }
    const turn = response?.result?.result?.turn || null;
    const turnId = typeof turn?.id === "string" ? turn.id.trim() : "";
    if (!turnId) {
      throw new CodexDesktopIpcError(
        "desktop_ipc_outcome_unknown",
        "Codex Desktop IPC returned no turn id",
        { delivery: "unknown" },
      );
    }
    return { response, turn, turnId };
  } finally {
    client.close();
  }
}

export function isCodexDesktopConversationIdle(state) {
  const runtimeStatus =
    typeof state?.threadRuntimeStatus === "string"
      ? state.threadRuntimeStatus
      : state?.threadRuntimeStatus?.type;
  if (runtimeStatus !== "idle") return false;
  if (["resuming", "needs_resume"].includes(state?.resumeState)) return false;
  const ordinaryTurns = Array.isArray(state?.turns) ? state.turns : [];
  if (
    ordinaryTurns.some(
      (turn) =>
        (typeof turn?.status === "string" ? turn.status : turn?.status?.type) ===
        "inProgress",
    )
  ) {
    return false;
  }
  const entities = state?.turnHistory?.history?.entitiesByKey;
  const canonicalTurns =
    entities && typeof entities === "object" ? Object.values(entities) : [];
  return !canonicalTurns.some(
    (turn) =>
      (typeof turn?.status === "string" ? turn.status : turn?.status?.type) ===
      "inProgress",
  );
}

export async function reloadCodexDesktopThreadHistory(options = {}) {
  return requestCodexDesktopIpc(
    "thread-follower-load-complete-history",
    { conversationId: options.threadId },
    {
      ...options.ipcOptions,
      timeoutMs: options.timeoutMs || 30000,
      deliverySensitive: false,
    },
  );
}

import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import {
  activateCodexDesktopThread,
  buildCodexDesktopThreadDeepLink,
  buildCodexDesktopDiscoveryResponse,
  CodexDesktopIpcError,
  CodexDesktopIpcFrameDecoder,
  encodeCodexDesktopIpcFrame,
  isCodexDesktopConversationIdle,
  openCodexDesktopThreadDeepLink,
  startCodexDesktopThreadTurn,
} from "./codex-desktop-ipc.mjs";

class FakeSocket extends EventEmitter {
  constructor(handler, options = {}) {
    super();
    this.handler = handler;
    this.decoder = new CodexDesktopIpcFrameDecoder();
    this.writable = true;
    this.requests = [];
    this.discoveryResponses = [];
    this.followCount = 0;
    this.emitSnapshots = options.emitSnapshots !== false;
    this.snapshotOwnerIds = options.snapshotOwnerIds || ["desktop-owner"];
    this.snapshotState = options.snapshotState || {
      resumeState: "resumed",
      threadRuntimeStatus: { type: "idle" },
      turns: [],
      turnHistory: { history: { entitiesByKey: {} } },
    };
    queueMicrotask(() => this.emit("connect"));
  }

  write(frame) {
    for (const request of this.decoder.push(frame)) {
      if (request.type === "client-discovery-response") {
        this.discoveryResponses.push(request);
        continue;
      }
      if (
        request.type === "broadcast" &&
        request.method === "thread-stream-following-changed" &&
        request.params?.following === true
      ) {
        if (!this.emitSnapshots) continue;
        const ownerClientId =
          this.snapshotOwnerIds[
            Math.min(this.followCount, this.snapshotOwnerIds.length - 1)
          ];
        this.followCount += 1;
        const snapshot = encodeCodexDesktopIpcFrame({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: ownerClientId,
          targetClientIds: ["bridge-client"],
          version: 11,
          params: {
            conversationId: request.params.conversationId,
            hostId: request.params.hostId,
            change: {
              type: "snapshot",
              revision: 1,
              conversationState: this.snapshotState,
            },
          },
        });
        queueMicrotask(() => this.emit("data", snapshot));
        continue;
      }
      this.requests.push(request);
      Promise.resolve(this.handler(request)).then((response) => {
        if (!response || !this.writable) return;
        const encoded = encodeCodexDesktopIpcFrame(response);
        const splitAt = Math.min(7, encoded.length);
        this.emit("data", encoded.subarray(0, splitAt));
        this.emit("data", encoded.subarray(splitAt));
      });
    }
    return true;
  }

  end() {
    this.writable = false;
  }

  destroy(error) {
    this.writable = false;
    if (error) this.emit("error", error);
    this.emit("close");
  }
}

test("builds only the exact fixed-controller deep link", () => {
  const threadId = "00000000-0000-4000-8000-000000000011";
  assert.equal(
    buildCodexDesktopThreadDeepLink(threadId),
    `codex://threads/${threadId}`,
  );
  assert.throws(
    () => buildCodexDesktopThreadDeepLink("human-readable-title"),
    (error) => {
      assert.equal(error.code, "desktop_thread_activation_invalid_target");
      return true;
    },
  );
});

test("requests the registered Windows protocol without a shell or title lookup", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {
    calls.push({ unref: true });
  };
  const threadId = "00000000-0000-4000-8000-000000000011";

  const requested = openCodexDesktopThreadDeepLink({
    threadId,
    platform: "win32",
    windowsDirectory: "C:\\Windows",
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });

  const result = await requested;
  assert.deepEqual(calls[0], {
    command: "C:\\Windows\\explorer.exe",
    args: [`codex://threads/${threadId}`],
    options: {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  });
  assert.deepEqual(calls[1], { unref: true });
  assert.equal(result.activationRequested, true);
  assert.equal(result.activationVerified, false);
});

test("aborts while the Windows protocol launcher has not acknowledged spawn", async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  let unrefCalls = 0;
  child.unref = () => {
    unrefCalls += 1;
  };
  const requested = openCodexDesktopThreadDeepLink({
    threadId: "00000000-0000-4000-8000-000000000011",
    platform: "win32",
    windowsDirectory: "C:\\Windows",
    signal: controller.signal,
    launchTimeoutMs: 1000,
    spawnProcess: () => child,
  });
  controller.abort();
  await assert.rejects(requested, (error) => {
    assert.equal(error.code, "aborted");
    return true;
  });
  assert.equal(unrefCalls, 1);
});

test("bounds waiting for the Windows protocol launcher", async () => {
  const child = new EventEmitter();
  let unrefCalls = 0;
  child.unref = () => {
    unrefCalls += 1;
  };
  await assert.rejects(
    openCodexDesktopThreadDeepLink({
      threadId: "00000000-0000-4000-8000-000000000011",
      platform: "win32",
      windowsDirectory: "C:\\Windows",
      launchTimeoutMs: 5,
      spawnProcess: () => child,
    }),
    (error) => {
      assert.equal(error.code, "desktop_thread_activation_launch_timeout");
      assert.equal(error.delivery, "not_dispatched");
      return true;
    },
  );
  assert.equal(unrefCalls, 1);
});

test("separates exact-thread activation request from owner verification", async () => {
  const threadId = "00000000-0000-4000-8000-000000000011";
  const events = [];
  let verificationAttempt = 0;

  const result = await activateCodexDesktopThread({
    threadId,
    activationTimeoutMs: 100,
    ownerSnapshotTimeoutMs: 5,
    pollIntervalMs: 1,
    openThread: async (request) => {
      events.push(["open", request.threadId, request.deepLink]);
      return { activationRequested: true, activationVerified: false };
    },
    verifyThreadOwner: async (request) => {
      verificationAttempt += 1;
      events.push(["verify", request.threadId]);
      if (verificationAttempt === 1) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "not active yet",
          { delivery: "not_dispatched" },
        );
      }
      return {
        ownerClientId: "desktop-owner",
        conversationState: {
          threadRuntimeStatus: { type: "idle" },
          turns: [],
        },
        revision: 7,
      };
    },
    sleep: async () => {},
  });

  assert.deepEqual(events, [
    ["open", threadId, `codex://threads/${threadId}`],
    ["verify", threadId],
    ["verify", threadId],
  ]);
  assert.equal(result.activationRequested, true);
  assert.equal(result.activationVerified, true);
  assert.equal(result.verificationAttempts, 2);
  assert.equal(result.revision, 7);
});

test("times out activation without treating the deep-link request as verified", async () => {
  let now = 0;
  let verificationAttempts = 0;
  await assert.rejects(
    activateCodexDesktopThread({
      threadId: "00000000-0000-4000-8000-000000000011",
      activationTimeoutMs: 10,
      ownerSnapshotTimeoutMs: 1,
      pollIntervalMs: 1,
      now: () => {
        now += 5;
        return now;
      },
      openThread: async () => ({
        activationRequested: true,
        activationVerified: false,
      }),
      verifyThreadOwner: async () => {
        verificationAttempts += 1;
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "still inactive",
          { delivery: "not_dispatched" },
        );
      },
      sleep: async () => {},
    }),
    (error) => {
      assert.equal(error.code, "desktop_thread_activation_timeout");
      assert.equal(error.delivery, "not_dispatched");
      assert.equal(error.details.activationRequested, true);
      assert.equal(error.details.activationVerified, false);
      return true;
    },
  );
  assert.equal(verificationAttempts, 1);
});

test("does not open a deep link after bridge shutdown is requested", async () => {
  const controller = new AbortController();
  controller.abort();
  let openCalls = 0;

  await assert.rejects(
    activateCodexDesktopThread({
      threadId: "00000000-0000-4000-8000-000000000011",
      signal: controller.signal,
      openThread: async () => {
        openCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "aborted");
      return true;
    },
  );
  assert.equal(openCalls, 0);
});

function response(request, result) {
  return {
    type: "response",
    requestId: request.requestId,
    resultType: "success",
    method: request.method,
    handledByClientId: "desktop-owner",
    result,
  };
}

test("decodes fragmented UTF-8 frames without changing text", () => {
  const message = { text: "用户\n引号：\"原文\" 😜" };
  const frame = encodeCodexDesktopIpcFrame(message);
  const decoder = new CodexDesktopIpcFrameDecoder();
  const output = [];
  for (let index = 0; index < frame.length; index += 3) {
    output.push(...decoder.push(frame.subarray(index, index + 3)));
  }
  assert.deepEqual(output, [message]);
});

test("declines unrelated Desktop client discovery with the exact wire shape", () => {
  assert.deepEqual(
    buildCodexDesktopDiscoveryResponse({
      type: "client-discovery-request",
      requestId: "discovery-1",
      request: { method: "ide-context" },
    }),
    {
      type: "client-discovery-response",
      requestId: "discovery-1",
      response: { canHandle: false },
    },
  );
});

test("starts one Desktop-owned visible turn with exact input and fixed permissions", async () => {
  let socket;
  const deliveryEvents = [];
  const createConnection = () => {
    socket = new FakeSocket((request) => {
      if (request.method === "initialize") {
        return response(request, { clientId: "bridge-client" });
      }
      assert.equal(request.method, "thread-follower-start-turn");
      deliveryEvents.push("write");
      return response(request, {
        result: { turn: { id: "turn-visible", status: "inProgress" } },
      });
    });
    return socket;
  };
  const input = [{ type: "text", text: "用户原话\n  首尾正文不改  " }];

  const result = await startCodexDesktopThreadTurn({
    threadId: "00000000-0000-4000-8000-000000000011",
    input,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    clientUserMessageId: "om_exact_message",
    ipcOptions: { createConnection },
    beforeDeliveryWrite: async () => {
      assert.equal(socket.followCount, 2);
      deliveryEvents.push("marker");
    },
  });

  assert.equal(result.turnId, "turn-visible");
  assert.equal(socket.requests.length, 2);
  assert.equal(socket.requests[0].method, "initialize");
  assert.equal(socket.requests[0].version, 0);
  assert.equal(socket.requests[1].targetClientId, "desktop-owner");
  assert.equal(socket.requests[1].version, 2);
  assert.deepEqual(deliveryEvents, ["marker", "write"]);
  assert.deepEqual(socket.requests[1].params, {
    conversationId: "00000000-0000-4000-8000-000000000011",
    turnStart: {
      request: {
        threadId: "00000000-0000-4000-8000-000000000011",
        input,
        clientUserMessageId: "om_exact_message",
      },
      context: { inheritThreadSettings: true },
    },
  });
});

test("falls back to the v1 owner handler only after v2 was not dispatched", async () => {
  let socket;
  const createConnection = () => {
    socket = new FakeSocket((request) => {
      if (request.method === "initialize") {
        return response(request, { clientId: "bridge-client" });
      }
      if (request.version === 2) {
        return {
          type: "response",
          requestId: request.requestId,
          resultType: "error",
          error: "no-client-found",
        };
      }
      return response(request, {
        result: { turn: { id: "turn-v1", status: "inProgress" } },
      });
    });
    return socket;
  };
  let markerCalls = 0;

  const result = await startCodexDesktopThreadTurn({
    threadId: "00000000-0000-4000-8000-000000000011",
    input: [{ type: "text", text: "兼容旧版" }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    clientUserMessageId: "om_v1_fallback",
    ipcOptions: { createConnection },
    beforeDeliveryWrite: async () => {
      markerCalls += 1;
    },
  });

  assert.equal(result.turnId, "turn-v1");
  assert.equal(markerCalls, 1);
  assert.deepEqual(
    socket.requests.slice(1).map((request) => request.version),
    [2, 1],
  );
  assert.equal(socket.requests[2].targetClientId, "desktop-owner");
  assert.deepEqual(socket.requests[2].params.turnStartParams, {
    input: [{ type: "text", text: "兼容旧版" }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    clientUserMessageId: "om_v1_fallback",
  });
});

test("reproduces the inactive-controller failure before any delivery marker", async () => {
  let markerCalls = 0;
  const createConnection = () =>
    new FakeSocket(
      (request) => {
        if (request.method === "initialize") {
          return response(request, { clientId: "bridge-client" });
        }
        throw new Error("inactive controller must not receive turn/start");
      },
      { emitSnapshots: false },
    );

  await assert.rejects(
    startCodexDesktopThreadTurn({
      threadId: "00000000-0000-4000-8000-000000000011",
      input: [{ type: "text", text: "未激活时不会投递" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ownerSnapshotTimeoutMs: 5,
      ipcOptions: { createConnection },
      beforeDeliveryWrite: async () => {
        markerCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_ipc_no_owner");
      assert.equal(error.delivery, "not_dispatched");
      return true;
    },
  );
  assert.equal(markerCalls, 0);
});

test("does not mark delivery when the Desktop owner becomes busy", async () => {
  let markerCalls = 0;
  const createConnection = () =>
    new FakeSocket(
      (request) => {
        if (request.method === "initialize") {
          return response(request, { clientId: "bridge-client" });
        }
        throw new Error("busy owner must not receive turn/start");
      },
      {
        snapshotState: {
          resumeState: "resumed",
          threadRuntimeStatus: { type: "active", activeFlags: [] },
          turns: [],
          turnHistory: { history: { entitiesByKey: {} } },
        },
      },
    );

  await assert.rejects(
    startCodexDesktopThreadTurn({
      threadId: "00000000-0000-4000-8000-000000000011",
      input: [{ type: "text", text: "等待本地回合" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ipcOptions: { createConnection },
      beforeDeliveryWrite: async () => {
        markerCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_ipc_owner_busy");
      return true;
    },
  );
  assert.equal(markerCalls, 0);
});

test("does not dispatch when the Desktop owner changes during confirmation", async () => {
  let markerCalls = 0;
  const createConnection = () =>
    new FakeSocket(
      (request) => {
        if (request.method === "initialize") {
          return response(request, { clientId: "bridge-client" });
        }
        throw new Error("changed owner must not receive turn/start");
      },
      { snapshotOwnerIds: ["desktop-owner-a", "desktop-owner-b"] },
    );

  await assert.rejects(
    startCodexDesktopThreadTurn({
      threadId: "00000000-0000-4000-8000-000000000011",
      input: [{ type: "text", text: "等待 owner 稳定" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ipcOptions: { createConnection },
      beforeDeliveryWrite: async () => {
        markerCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_ipc_owner_changed");
      return true;
    },
  );
  assert.equal(markerCalls, 0);
});

test("does not dispatch when the confirmed Desktop owner disappears", async () => {
  let markerCalls = 0;
  const createConnection = () =>
    new FakeSocket(
      (request) => {
        if (request.method === "initialize") {
          return response(request, { clientId: "bridge-client" });
        }
        throw new Error("missing owner must not receive turn/start");
      },
      { snapshotOwnerIds: ["desktop-owner", ""] },
    );

  await assert.rejects(
    startCodexDesktopThreadTurn({
      threadId: "00000000-0000-4000-8000-000000000011",
      input: [{ type: "text", text: "等待 owner 恢复" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ipcOptions: { createConnection },
      beforeDeliveryWrite: async () => {
        markerCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_ipc_owner_changed");
      return true;
    },
  );
  assert.equal(markerCalls, 0);
});

test("requires an idle Desktop owner snapshot before starting", async () => {
  const createConnection = () =>
    new FakeSocket(
      (request) => {
        if (request.method === "initialize") {
          return response(request, { clientId: "bridge-client" });
        }
        throw new Error("busy owner must not receive turn/start");
      },
      {
        snapshotState: {
          resumeState: "resumed",
          threadRuntimeStatus: { type: "active", activeFlags: [] },
          turns: [],
          turnHistory: { history: { entitiesByKey: {} } },
        },
      },
    );

  await assert.rejects(
    startCodexDesktopThreadTurn({
      threadId: "00000000-0000-4000-8000-000000000011",
      input: [{ type: "text", text: "等待本地回合" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ipcOptions: { createConnection },
    }),
    (error) => {
      assert.equal(error.code, "desktop_ipc_owner_busy");
      assert.equal(error.delivery, "not_dispatched");
      return true;
    },
  );
});

test("treats canonical or ordinary in-progress turns as busy", () => {
  assert.equal(
    isCodexDesktopConversationIdle({
      resumeState: "resumed",
      threadRuntimeStatus: { type: "idle" },
      turns: [],
      turnHistory: { history: { entitiesByKey: {} } },
    }),
    true,
  );
  assert.equal(
    isCodexDesktopConversationIdle({
      resumeState: "resumed",
      threadRuntimeStatus: { type: "idle" },
      turns: [{ status: "inProgress" }],
      turnHistory: { history: { entitiesByKey: {} } },
    }),
    false,
  );
  assert.equal(
    isCodexDesktopConversationIdle({
      resumeState: "resumed",
      threadRuntimeStatus: { type: "idle" },
      turns: [],
      turnHistory: {
        history: { entitiesByKey: { active: { status: "inProgress" } } },
      },
    }),
    false,
  );
});

test("classifies a stable snapshot with no compatible turn handler", async () => {
  const createConnection = () =>
    new FakeSocket((request) => {
      if (request.method === "initialize") {
        return response(request, { clientId: "bridge-client" });
      }
      return {
        type: "response",
        requestId: request.requestId,
        resultType: "error",
        error: "no-client-found",
      };
    });

  await assert.rejects(
    startCodexDesktopThreadTurn({
      threadId: "00000000-0000-4000-8000-000000000011",
      input: [{ type: "text", text: "不会被投递" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ipcOptions: { createConnection },
    }),
    (error) => {
      assert.ok(error instanceof CodexDesktopIpcError);
      assert.equal(error.code, "desktop_ipc_no_turn_handler");
      assert.equal(error.delivery, "not_dispatched");
      return true;
    },
  );
});

test("classifies a post-discovery start failure as outcome unknown", async () => {
  const createConnection = () =>
    new FakeSocket((request) => {
      if (request.method === "initialize") {
        return response(request, { clientId: "bridge-client" });
      }
      return {
        type: "response",
        requestId: request.requestId,
        resultType: "error",
        error: "request-timeout",
      };
    });

  await assert.rejects(
    startCodexDesktopThreadTurn({
      threadId: "00000000-0000-4000-8000-000000000011",
      input: [{ type: "text", text: "只允许一次" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      ipcOptions: { createConnection },
    }),
    (error) => {
      assert.ok(error instanceof CodexDesktopIpcError);
      assert.equal(error.code, "desktop_ipc_outcome_unknown");
      assert.equal(error.delivery, "unknown");
      return true;
    },
  );
});

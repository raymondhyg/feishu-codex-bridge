import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFixedControllerAppServerArgs,
  buildFixedControllerAttachmentInput,
  FixedControllerRelayError,
  findFixedControllerTurnByClientMessageId,
  runFixedControllerRelay,
  startFixedControllerTurn,
  startFixedControllerTurnPreferDesktop,
  startFixedControllerVisibleTurn,
  verifyFixedControllerTarget,
  waitForFixedControllerTurn,
} from "./fixed-controller-relay.mjs";
import { CodexDesktopIpcError } from "./codex-desktop-ipc.mjs";

const THREAD_ID = "00000000-0000-4000-8000-000000000011";
const CWD = "C:\\Bridge\\workspace";

function thread(status, turns = []) {
  return {
    id: THREAD_ID,
    name: "固定本地总控",
    cwd: CWD,
    status: { type: status },
    turns,
  };
}

class FakeAppServer {
  constructor(options = {}) {
    this.calls = [];
    this.reads = [...(options.reads || [])];
    this.turnStart = options.turnStart || { turn: { id: "turn-current" } };
    this.resume = options.resume || { thread: thread("idle") };
    this.readError = options.readError;
  }

  async request(method, params, requestOptions) {
    this.calls.push({ method, params, requestOptions });
    if (method === "turn/steer") {
      throw new Error("turn/steer must never be called");
    }
    if (method === "thread/read") {
      if (this.readError) throw this.readError;
      const next = this.reads.length > 1 ? this.reads.shift() : this.reads[0];
      return { thread: next };
    }
    if (method === "thread/resume") return this.resume;
    if (method === "turn/start") return this.turnStart;
    throw new Error(`unexpected method: ${method}`);
  }
}

test("starts the dedicated fixed-controller App Server with unattended full access", () => {
  assert.deepEqual(buildFixedControllerAppServerArgs(), [
    "-s",
    "danger-full-access",
    "-a",
    "never",
  ]);
});

test("verifies the exact fixed target and starts an idle turn with the fixed unattended profile", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  const execution = await startFixedControllerTurn(appServer, {
    threadId: THREAD_ID,
    expectedCwd: CWD.toLowerCase(),
    input: "用户的原始消息",
  });

  assert.equal(execution.threadId, THREAD_ID);
  assert.equal(execution.turnId, "turn-current");
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read", "turn/start"],
  );
  assert.deepEqual(appServer.calls[1].params, {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "用户的原始消息" }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  assert.deepEqual(Object.keys(appServer.calls[1].params).sort(), [
    "approvalPolicy",
    "input",
    "sandboxPolicy",
    "threadId",
  ]);
  assert.equal(
    appServer.calls.some((call) => call.method === "turn/steer"),
    false,
  );
});

test("rejects the exact thread when its working directory does not match", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });

  await assert.rejects(
    verifyFixedControllerTarget(appServer, {
      threadId: THREAD_ID,
      expectedCwd: "C:\\Another\\controller",
    }),
    (error) => {
      assert.ok(error instanceof FixedControllerRelayError);
      assert.equal(error.code, "target_cwd_mismatch");
      return true;
    },
  );
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read"],
  );
});

test("starts the fixed turn through the Desktop owner without a second App Server turn", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  const exactInput = "用户原话\n  不改首尾正文  ";
  let desktopRequest;
  const transportEvents = [];

  const execution = await startFixedControllerVisibleTurn(appServer, {
    threadId: THREAD_ID,
    expectedCwd: CWD,
    input: exactInput,
    clientUserMessageId: "om_visible_message",
    onTransportDispatching: async (transport) => {
      transportEvents.push(`dispatch:${transport}`);
    },
    startDesktopTurn: async (request) => {
      desktopRequest = request;
      await request.beforeDeliveryWrite();
      return {
        turnId: "turn-visible",
        turn: { id: "turn-visible", status: "inProgress" },
      };
    },
    activateDesktopThread: async () => {
      throw new Error("normal delivery must not activate the controller");
    },
  });

  assert.equal(execution.turnId, "turn-visible");
  assert.equal(execution.transport, "desktop-ipc");
  assert.equal(execution.desktopLiveVisible, true);
  assert.equal(execution.activationAttempted, false);
  assert.equal(execution.activationVerified, false);
  assert.equal(execution.deliveryAttemptCount, 1);
  assert.equal(execution.receiptVerified, true);
  assert.deepEqual(transportEvents, ["dispatch:desktop-ipc"]);
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read"],
  );
  assert.deepEqual(desktopRequest, {
    threadId: THREAD_ID,
    input: [{ type: "text", text: exactInput }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    clientUserMessageId: "om_visible_message",
    timeoutMs: undefined,
    ipcOptions: undefined,
    beforeDeliveryWrite: desktopRequest.beforeDeliveryWrite,
  });
});

test("falls back once only when Desktop confirms the turn was not dispatched", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle"), thread("idle")] });
  const transportEvents = [];
  const execution = await startFixedControllerTurnPreferDesktop(appServer, {
    threadId: THREAD_ID,
    input: "保持远程可用",
    allowHeadlessFallback: true,
    onTransportDispatching: async (transport) => {
      transportEvents.push(`dispatch:${transport}`);
    },
    onTransportNotDispatched: async (transport) => {
      transportEvents.push(`not-dispatched:${transport}`);
    },
    startDesktopTurn: async () => {
      throw new CodexDesktopIpcError(
        "desktop_ipc_no_owner",
        "no owner",
        { delivery: "not_dispatched" },
      );
    },
    activateDesktopThread: async () => {
      throw new CodexDesktopIpcError(
        "desktop_thread_activation_timeout",
        "activation did not verify",
        { delivery: "not_dispatched" },
      );
    },
  });

  assert.equal(execution.transport, "dedicated-app-server");
  assert.equal(execution.desktopLiveVisible, false);
  assert.deepEqual(transportEvents, [
    "not-dispatched:desktop-ipc",
    "dispatch:dedicated-app-server",
  ]);
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read", "thread/read", "turn/start"],
  );
  assert.equal(
    appServer.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
});

test("activates the exact fixed controller and retries the same envelope once", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  const input = [
    { type: "text", text: "必须在桌面总控可见\n附件路径保持不变" },
    { type: "localImage", path: "F:\\relay\\原图.png" },
  ];
  const starts = [];
  const events = [];
  let activationCalls = 0;

  const execution = await startFixedControllerTurnPreferDesktop(appServer, {
    threadId: THREAD_ID,
    expectedCwd: CWD,
    input,
    clientUserMessageId: "om_exact_retry",
    onDesktopDeliveryAttempt: async ({ attempt }) => {
      events.push(`attempt:${attempt}`);
    },
    onDesktopActivationRequested: async () => {
      events.push("activation:requested");
    },
    onDesktopActivationVerified: async () => {
      events.push("activation:verified");
    },
    onDesktopRecoveryRetryRequested: async () => {
      events.push("recovery:retry-requested");
    },
    onTransportNotDispatched: async () => {
      events.push("delivery:not-dispatched");
    },
    onTransportDispatching: async () => {
      events.push("delivery:dispatching");
    },
    activateDesktopThread: async (request) => {
      activationCalls += 1;
      events.push("activate:exact-id");
      assert.equal(request.threadId, THREAD_ID);
      return {
        activationRequested: true,
        activationVerified: true,
        verificationAttempts: 2,
      };
    },
    startDesktopTurn: async (request) => {
      starts.push(request);
      if (starts.length === 1) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "no owner",
          { delivery: "not_dispatched" },
        );
      }
      await request.beforeDeliveryWrite();
      return {
        turnId: "turn-after-activation",
        turn: { id: "turn-after-activation", status: "inProgress" },
      };
    },
  });

  assert.equal(execution.turnId, "turn-after-activation");
  assert.equal(execution.activationAttempted, true);
  assert.equal(execution.activationVerified, true);
  assert.equal(execution.deliveryAttemptCount, 2);
  assert.equal(execution.receiptVerified, true);
  assert.equal(activationCalls, 1);
  assert.equal(starts.length, 2);
  assert.strictEqual(starts[0].input, starts[1].input);
  assert.deepEqual(starts[0].input, input);
  assert.equal(starts[0].clientUserMessageId, "om_exact_retry");
  assert.equal(starts[1].clientUserMessageId, "om_exact_retry");
  assert.deepEqual(
    {
      threadId: starts[0].threadId,
      input: starts[0].input,
      approvalPolicy: starts[0].approvalPolicy,
      sandboxPolicy: starts[0].sandboxPolicy,
      clientUserMessageId: starts[0].clientUserMessageId,
    },
    {
      threadId: starts[1].threadId,
      input: starts[1].input,
      approvalPolicy: starts[1].approvalPolicy,
      sandboxPolicy: starts[1].sandboxPolicy,
      clientUserMessageId: starts[1].clientUserMessageId,
    },
  );
  assert.deepEqual(events, [
    "attempt:1",
    "delivery:not-dispatched",
    "activation:requested",
    "activate:exact-id",
    "activation:verified",
    "attempt:2",
    "recovery:retry-requested",
    "delivery:dispatching",
  ]);
  assert.equal(
    appServer.calls.some((call) => call.method === "turn/start"),
    false,
  );
});

test("re-activates once when Desktop exposes a snapshot but no turn handler", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  const starts = [];
  let activationCalls = 0;

  const execution = await startFixedControllerTurnPreferDesktop(appServer, {
    threadId: THREAD_ID,
    expectedCwd: CWD,
    input: "保持原文",
    clientUserMessageId: "om_no_turn_handler",
    activateDesktopThread: async () => {
      activationCalls += 1;
      return {
        activationRequested: true,
        activationVerified: true,
        verificationAttempts: 1,
      };
    },
    startDesktopTurn: async (request) => {
      starts.push(request);
      if (starts.length === 1) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_turn_handler",
          "snapshot owner is not a routable turn handler",
          { delivery: "not_dispatched" },
        );
      }
      await request.beforeDeliveryWrite();
      return {
        turnId: "turn-after-handler-recovery",
        turn: { id: "turn-after-handler-recovery", status: "inProgress" },
      };
    },
  });

  assert.equal(execution.turnId, "turn-after-handler-recovery");
  assert.equal(execution.activationAttempted, true);
  assert.equal(execution.activationVerified, true);
  assert.equal(execution.deliveryAttemptCount, 2);
  assert.equal(activationCalls, 1);
  assert.equal(starts.length, 2);
  assert.strictEqual(starts[0].input, starts[1].input);
  assert.equal(starts[0].clientUserMessageId, "om_no_turn_handler");
  assert.equal(starts[1].clientUserMessageId, "om_no_turn_handler");
});

test("does not retry when exact-thread activation cannot be verified", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let startCalls = 0;
  let activationCalls = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "激活不成功就停止",
      startDesktopTurn: async () => {
        startCalls += 1;
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "no owner",
          { delivery: "not_dispatched" },
        );
      },
      activateDesktopThread: async () => {
        activationCalls += 1;
        throw new CodexDesktopIpcError(
          "desktop_thread_activation_timeout",
          "not verified",
          { delivery: "not_dispatched" },
        );
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_start_unavailable");
      assert.equal(error.details.activationAttempted, true);
      assert.equal(error.details.activationVerified, false);
      assert.equal(error.details.deliveryAttemptCount, 1);
      return true;
    },
  );
  assert.equal(startCalls, 1);
  assert.equal(activationCalls, 1);
});

test("does not activate when the confirmed non-dispatch state cannot persist", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let activationCalls = 0;
  const observerError = new Error("state unavailable");
  observerError.code = "state_write_failed";

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "状态写不下就不激活",
      onTransportNotDispatched: async () => {
        throw observerError;
      },
      startDesktopTurn: async () => {
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "no owner",
          { delivery: "not_dispatched" },
        );
      },
      activateDesktopThread: async () => {
        activationCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_recovery_state_persist_failed");
      assert.equal(error.details.observerStage, "transport_not_dispatched");
      assert.equal(error.details.observerCode, "state_write_failed");
      assert.equal(error.details.activationAttempted, false);
      return true;
    },
  );
  assert.equal(activationCalls, 0);
});

test("keeps verified activation distinct when its state observer fails", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let activationFailureCalls = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "激活验证与状态落盘分开",
      startDesktopTurn: async () => {
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "no owner",
          { delivery: "not_dispatched" },
        );
      },
      activateDesktopThread: async () => ({
        activationRequested: true,
        activationVerified: true,
        verificationAttempts: 1,
      }),
      onDesktopActivationVerified: async () => {
        const error = new Error("verified state write failed");
        error.code = "state_write_failed";
        throw error;
      },
      onDesktopActivationFailed: async () => {
        activationFailureCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_recovery_state_persist_failed");
      assert.equal(error.details.observerStage, "activation_verified");
      assert.equal(error.details.activationAttempted, true);
      assert.equal(error.details.activationVerified, true);
      return true;
    },
  );
  assert.equal(activationFailureCalls, 0);
});

test("does not let an activation-failure observer mask the activation error", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "主错误必须保留",
      startDesktopTurn: async () => {
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "no owner",
          { delivery: "not_dispatched" },
        );
      },
      activateDesktopThread: async () => {
        throw new CodexDesktopIpcError(
          "desktop_thread_activation_timeout",
          "activation timeout",
          { delivery: "not_dispatched" },
        );
      },
      onDesktopActivationFailed: async () => {
        const error = new Error("failure observer unavailable");
        error.code = "failure_observer_failed";
        throw error;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_start_unavailable");
      assert.equal(
        error.details.activationCode,
        "desktop_thread_activation_timeout",
      );
      assert.equal(
        error.details.failureObserverCode,
        "failure_observer_failed",
      );
      return true;
    },
  );
});

test("bounds recovery to one activation and two Desktop delivery attempts", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let startCalls = 0;
  let activationCalls = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "最多重试一次",
      startDesktopTurn: async () => {
        startCalls += 1;
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "no owner",
          { delivery: "not_dispatched" },
        );
      },
      activateDesktopThread: async () => {
        activationCalls += 1;
        return {
          activationRequested: true,
          activationVerified: true,
        };
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_start_unavailable");
      assert.equal(error.details.activationAttempted, true);
      assert.equal(error.details.activationVerified, true);
      assert.equal(error.details.deliveryAttemptCount, 2);
      assert.equal(error.details.receiptVerified, false);
      return true;
    },
  );
  assert.equal(startCalls, 2);
  assert.equal(activationCalls, 1);
});

test("preserves a persisted activation budget across restart recovery", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let activationCalls = 0;
  let startCalls = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "恢复时不重复激活",
      desktopActivationAttempted: true,
      desktopActivationVerified: true,
      desktopDeliveryAttemptCount: 1,
      onDesktopRecoveryRetryRequested: async () => {},
      startDesktopTurn: async () => {
        startCalls += 1;
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "no owner",
          { delivery: "not_dispatched" },
        );
      },
      activateDesktopThread: async () => {
        activationCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_start_unavailable");
      assert.equal(error.details.activationAttempted, true);
      assert.equal(error.details.deliveryAttemptCount, 2);
      return true;
    },
  );
  assert.equal(startCalls, 1);
  assert.equal(activationCalls, 0);
});

test("re-verifies a persisted incomplete activation before the recovery retry", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  const events = [];
  let activationCalls = 0;
  let startCalls = 0;

  const execution = await startFixedControllerTurnPreferDesktop(appServer, {
    threadId: THREAD_ID,
    input: "先恢复激活证据再重试",
    desktopActivationAttempted: true,
    desktopActivationVerified: false,
    desktopDeliveryAttemptCount: 1,
    verifyDesktopThreadActivation: async (request) => {
      events.push("activation:reverify");
      assert.equal(request.threadId, THREAD_ID);
      return {
        threadId: THREAD_ID,
        activationRequested: true,
        activationVerified: true,
        verificationAttempts: 2,
      };
    },
    onDesktopActivationVerified: async ({ resumed }) => {
      events.push(`activation:verified:${resumed}`);
    },
    onDesktopRecoveryRetryRequested: async () => {
      events.push("recovery:retry-requested");
    },
    startDesktopTurn: async (request) => {
      startCalls += 1;
      await request.beforeDeliveryWrite();
      events.push("delivery:retry");
      return { turnId: "turn-after-resumed-verification" };
    },
    activateDesktopThread: async () => {
      activationCalls += 1;
    },
  });

  assert.equal(execution.turnId, "turn-after-resumed-verification");
  assert.equal(execution.activationVerified, true);
  assert.equal(execution.deliveryAttemptCount, 2);
  assert.equal(activationCalls, 0);
  assert.equal(startCalls, 1);
  assert.deepEqual(events, [
    "activation:reverify",
    "activation:verified:true",
    "recovery:retry-requested",
    "delivery:retry",
  ]);
});

test("does not consume the recovery dispatch allowance while the owner is still busy", async () => {
  for (const ownerCode of [
    "desktop_ipc_owner_busy",
    "desktop_ipc_owner_changed",
  ]) {
    const input = [
      { type: "text", text: `等待 ${ownerCode} 后原样投递` },
      { type: "localImage", path: "F:\\relay\\busy-resume.png" },
    ];
    let recoveryMarkers = 0;
    let dispatches = 0;
    let firstEnvelope;

    let firstError;
    try {
      await startFixedControllerTurnPreferDesktop(
        new FakeAppServer({ reads: [thread("idle")] }),
        {
          threadId: THREAD_ID,
          input,
          clientUserMessageId: "om_busy_then_dispatch",
          desktopActivationAttempted: true,
          desktopActivationVerified: true,
          desktopDeliveryAttemptCount: 1,
          onDesktopRecoveryRetryRequested: async () => {
            recoveryMarkers += 1;
          },
          startDesktopTurn: async (request) => {
            firstEnvelope = request;
            throw new CodexDesktopIpcError(
              ownerCode,
              "owner is not ready yet",
              { delivery: "not_dispatched" },
            );
          },
        },
      );
    } catch (error) {
      firstError = error;
    }

    assert.equal(firstError?.code, "desktop_turn_owner_busy");
    assert.equal(firstError?.details.recoveryRetryAttempted, false);
    assert.equal(firstError?.details.deliveryAttemptCount, 2);
    assert.equal(recoveryMarkers, 0);

    let secondEnvelope;
    const execution = await startFixedControllerTurnPreferDesktop(
      new FakeAppServer({ reads: [thread("idle")] }),
      {
        threadId: THREAD_ID,
        input,
        clientUserMessageId: "om_busy_then_dispatch",
        desktopActivationAttempted: true,
        desktopActivationVerified: true,
        desktopDeliveryAttemptCount:
          firstError.details.deliveryAttemptCount,
        desktopRecoveryRetryAttempted: false,
        desktopLastDeliveryCode: ownerCode,
        onDesktopRecoveryRetryRequested: async () => {
          recoveryMarkers += 1;
        },
        startDesktopTurn: async (request) => {
          secondEnvelope = request;
          await request.beforeDeliveryWrite();
          dispatches += 1;
          return { turnId: `turn-after-${ownerCode}` };
        },
      },
    );

    assert.equal(execution.receiptVerified, true);
    assert.equal(execution.deliveryAttemptCount, 3);
    assert.equal(recoveryMarkers, 1);
    assert.equal(dispatches, 1);
    assert.deepEqual(firstEnvelope.input, secondEnvelope.input);
    assert.deepEqual(secondEnvelope.input, input);
    assert.equal(
      secondEnvelope.clientUserMessageId,
      "om_busy_then_dispatch",
    );
  }
});

test("releases a persisted recovery reservation after an explicit owner-changed non-dispatch", async () => {
  const input = [
    { type: "text", text: "激活后 owner 切换仍需原样投递" },
    { type: "localImage", path: "F:\\relay\\owner-race.png" },
  ];
  const record = {
    desktopActivationAttempted: false,
    desktopActivationVerified: false,
    desktopDeliveryAttemptCount: 0,
    desktopRecoveryRetryAttempted: false,
    desktopLastDeliveryCode: null,
  };
  const envelopes = [];
  let desktopCalls = 0;
  let successfulStarts = 0;

  const persistedOptions = () => ({
    threadId: THREAD_ID,
    input,
    clientUserMessageId: "om_activation_owner_race",
    desktopActivationAttempted: record.desktopActivationAttempted,
    desktopActivationVerified: record.desktopActivationVerified,
    desktopDeliveryAttemptCount: record.desktopDeliveryAttemptCount,
    desktopRecoveryRetryAttempted: record.desktopRecoveryRetryAttempted,
    desktopLastDeliveryCode: record.desktopLastDeliveryCode || undefined,
    onDesktopDeliveryAttempt: async () => {
      record.desktopDeliveryAttemptCount += 1;
      record.desktopLastDeliveryCode = null;
    },
    onDesktopActivationRequested: async () => {
      record.desktopActivationAttempted = true;
      record.desktopActivationVerified = false;
    },
    onDesktopActivationVerified: async () => {
      record.desktopActivationVerified = true;
    },
    onDesktopRecoveryRetryRequested: async () => {
      record.desktopRecoveryRetryAttempted = true;
    },
    onTransportNotDispatched: async (_transport, outcome) => {
      record.desktopLastDeliveryCode = outcome.code;
      if (outcome.recoveryRetryReleased === true) {
        record.desktopRecoveryRetryAttempted = false;
      }
    },
    activateDesktopThread: async () => ({
      activationRequested: true,
      activationVerified: true,
      verificationAttempts: 1,
    }),
    startDesktopTurn: async (request) => {
      desktopCalls += 1;
      envelopes.push(request);
      if (desktopCalls === 1) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_no_owner",
          "no owner",
          { delivery: "not_dispatched" },
        );
      }
      await request.beforeDeliveryWrite();
      if (desktopCalls === 2) {
        throw new CodexDesktopIpcError(
          "desktop_ipc_owner_changed",
          "owner changed after recovery reservation",
          { delivery: "not_dispatched" },
        );
      }
      successfulStarts += 1;
      return { turnId: "turn-after-owner-stabilized" };
    },
  });

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(
      new FakeAppServer({ reads: [thread("idle")] }),
      persistedOptions(),
    ),
    (error) => {
      assert.equal(error.code, "desktop_turn_owner_busy");
      return true;
    },
  );
  assert.equal(record.desktopLastDeliveryCode, "desktop_ipc_owner_changed");
  assert.equal(record.desktopRecoveryRetryAttempted, false);

  const execution = await startFixedControllerTurnPreferDesktop(
    new FakeAppServer({ reads: [thread("idle")] }),
    persistedOptions(),
  );

  assert.equal(execution.turnId, "turn-after-owner-stabilized");
  assert.equal(execution.receiptVerified, true);
  assert.equal(successfulStarts, 1);
  assert.equal(desktopCalls, 3);
  assert.deepEqual(envelopes[1].input, envelopes[2].input);
  assert.deepEqual(envelopes[2].input, input);
  assert.equal(
    envelopes[2].clientUserMessageId,
    "om_activation_owner_race",
  );
});

test("keeps the recovery reservation when releasing it cannot persist", async () => {
  let starts = 0;
  let recoveryReserved = false;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(
      new FakeAppServer({ reads: [thread("idle")] }),
      {
        threadId: THREAD_ID,
        input: "释放恢复预占失败时必须封闭",
        onDesktopRecoveryRetryRequested: async () => {
          recoveryReserved = true;
        },
        onTransportNotDispatched: async (_transport, outcome) => {
          if (outcome.recoveryRetryReleased === true) {
            const error = new Error("state unavailable");
            error.code = "state_write_failed";
            throw error;
          }
        },
        activateDesktopThread: async () => ({
          activationRequested: true,
          activationVerified: true,
          verificationAttempts: 1,
        }),
        startDesktopTurn: async (request) => {
          starts += 1;
          if (starts === 1) {
            throw new CodexDesktopIpcError(
              "desktop_ipc_no_owner",
              "no owner",
              { delivery: "not_dispatched" },
            );
          }
          await request.beforeDeliveryWrite();
          throw new CodexDesktopIpcError(
            "desktop_ipc_owner_changed",
            "owner changed after recovery reservation",
            { delivery: "not_dispatched" },
          );
        },
      },
    ),
    (error) => {
      assert.equal(error.code, "desktop_recovery_state_persist_failed");
      assert.equal(error.details.recoveryRetryAttempted, true);
      assert.equal(error.details.observerStage, "transport_not_dispatched");
      return true;
    },
  );

  assert.equal(recoveryReserved, true);
  assert.equal(starts, 2);
});

test("does not dispatch when the recovery allowance cannot persist", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let starts = 0;
  let dispatching = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "恢复标记必须先落盘",
      onDesktopRecoveryRetryRequested: async () => {
        const error = new Error("state unavailable");
        error.code = "state_write_failed";
        throw error;
      },
      onTransportDispatching: async () => {
        dispatching += 1;
      },
      startDesktopTurn: async (request) => {
        starts += 1;
        if (starts === 1) {
          throw new CodexDesktopIpcError(
            "desktop_ipc_no_owner",
            "no owner",
            { delivery: "not_dispatched" },
          );
        }
        await request.beforeDeliveryWrite();
      },
      activateDesktopThread: async () => ({
        activationRequested: true,
        activationVerified: true,
        verificationAttempts: 1,
      }),
    }),
    (error) => {
      assert.equal(error.code, "desktop_recovery_state_persist_failed");
      assert.equal(error.details.observerStage, "recovery_retry_requested");
      assert.equal(error.details.observerCode, "state_write_failed");
      assert.equal(error.details.recoveryRetryAttempted, true);
      return true;
    },
  );
  assert.equal(starts, 2);
  assert.equal(dispatching, 0);
});

test("does not retry when persisted activation cannot be re-verified", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let startCalls = 0;
  let retryRequests = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "恢复验证失败就停止",
      desktopActivationAttempted: true,
      desktopActivationVerified: false,
      desktopDeliveryAttemptCount: 1,
      verifyDesktopThreadActivation: async () => {
        throw new CodexDesktopIpcError(
          "desktop_thread_activation_timeout",
          "owner not verified",
          { delivery: "not_dispatched" },
        );
      },
      onDesktopRecoveryRetryRequested: async () => {
        retryRequests += 1;
      },
      startDesktopTurn: async () => {
        startCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_start_unavailable");
      assert.equal(error.details.activationVerificationResumed, true);
      assert.equal(error.details.activationVerified, false);
      assert.equal(error.details.deliveryAttemptCount, 1);
      return true;
    },
  );
  assert.equal(startCalls, 0);
  assert.equal(retryRequests, 0);
});

test("does not consume a second recovery retry after restart", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let startCalls = 0;
  let activationCalls = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "恢复重试已消费",
      desktopActivationAttempted: true,
      desktopActivationVerified: true,
      desktopDeliveryAttemptCount: 2,
      desktopRecoveryRetryAttempted: true,
      startDesktopTurn: async () => {
        startCalls += 1;
      },
      activateDesktopThread: async () => {
        activationCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_recovery_limit_reached");
      assert.equal(error.details.recoveryRetryAttempted, true);
      assert.equal(error.details.deliveryAttemptCount, 2);
      return true;
    },
  );
  assert.equal(startCalls, 0);
  assert.equal(activationCalls, 0);
});

test("resumes a confirmed no-owner result without repeating the initial attempt", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let startCalls = 0;
  let activationCalls = 0;
  const input = [
    { type: "text", text: "从已确认的未投递状态恢复" },
    { type: "localImage", path: "F:\\relay\\跨重启原图.png" },
  ];
  let resumedEnvelope;

  const execution = await startFixedControllerTurnPreferDesktop(appServer, {
    threadId: THREAD_ID,
    input,
    clientUserMessageId: "om_cross_restart_attachment",
    desktopDeliveryAttemptCount: 1,
    desktopLastDeliveryCode: "desktop_ipc_no_owner",
    onDesktopRecoveryRetryRequested: async () => {},
    activateDesktopThread: async () => {
      activationCalls += 1;
      return {
        activationRequested: true,
        activationVerified: true,
        verificationAttempts: 1,
      };
    },
    startDesktopTurn: async (request) => {
      startCalls += 1;
      resumedEnvelope = request;
      await request.beforeDeliveryWrite();
      return { turnId: "turn-resumed-after-no-owner" };
    },
  });

  assert.equal(execution.turnId, "turn-resumed-after-no-owner");
  assert.equal(execution.deliveryAttemptCount, 2);
  assert.equal(startCalls, 1);
  assert.equal(activationCalls, 1);
  assert.deepEqual(resumedEnvelope.input, input);
  assert.equal(
    resumedEnvelope.clientUserMessageId,
    "om_cross_restart_attachment",
  );
});

test("does not retry an interrupted delivery without a persisted safe outcome", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  let startCalls = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "缺少安全恢复证据",
      desktopDeliveryAttemptCount: 1,
      startDesktopTurn: async () => {
        startCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_recovery_state_unknown");
      assert.equal(error.details.delivery, "unknown");
      return true;
    },
  );
  assert.equal(startCalls, 0);
});

test("never falls back when the Desktop start outcome is unknown", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  const transportEvents = [];
  let activationCalls = 0;

  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "只允许一次",
      onTransportDispatching: async (transport) => {
        transportEvents.push(`dispatch:${transport}`);
      },
      onTransportNotDispatched: async (transport) => {
        transportEvents.push(`not-dispatched:${transport}`);
      },
      startDesktopTurn: async (request) => {
        await request.beforeDeliveryWrite();
        throw new CodexDesktopIpcError(
          "desktop_ipc_outcome_unknown",
          "request timed out",
          { delivery: "unknown" },
        );
      },
      activateDesktopThread: async () => {
        activationCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_start_outcome_unknown");
      return true;
    },
  );
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read"],
  );
  assert.deepEqual(transportEvents, ["dispatch:desktop-ipc"]);
  assert.equal(activationCalls, 0);
});

test("never falls back when the Desktop owner is busy", async () => {
  const appServer = new FakeAppServer({ reads: [thread("notLoaded")] });
  let activationCalls = 0;
  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "排队等待",
      startDesktopTurn: async () => {
        throw new CodexDesktopIpcError(
          "desktop_ipc_owner_busy",
          "owner busy",
          { delivery: "not_dispatched" },
        );
      },
      activateDesktopThread: async () => {
        activationCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_owner_busy");
      return true;
    },
  );
  assert.equal(
    appServer.calls.filter((call) => call.method === "turn/start").length,
    0,
  );
  assert.equal(activationCalls, 0);
});

test("never falls back when the Desktop owner changes before dispatch", async () => {
  const appServer = new FakeAppServer({ reads: [thread("notLoaded")] });
  const transportEvents = [];
  let activationCalls = 0;
  await assert.rejects(
    startFixedControllerTurnPreferDesktop(appServer, {
      threadId: THREAD_ID,
      input: "等待新的桌面 owner",
      onTransportDispatching: async (transport) => {
        transportEvents.push(`dispatch:${transport}`);
      },
      startDesktopTurn: async () => {
        throw new CodexDesktopIpcError(
          "desktop_ipc_owner_changed",
          "owner changed",
          { delivery: "not_dispatched" },
        );
      },
      activateDesktopThread: async () => {
        activationCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "desktop_turn_owner_busy");
      return true;
    },
  );
  assert.deepEqual(transportEvents, []);
  assert.equal(
    appServer.calls.filter((call) => call.method === "turn/start").length,
    0,
  );
  assert.equal(activationCalls, 0);
});

test("resumes a notLoaded fixed target by exact id with the fixed unattended profile", async () => {
  const appServer = new FakeAppServer({
    reads: [thread("notLoaded")],
    resume: { thread: thread("idle") },
  });

  await startFixedControllerTurn(appServer, {
    threadId: THREAD_ID,
    input: "首条远程消息",
    clientUserMessageId: "om_example_message",
  });

  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read", "thread/resume", "turn/start"],
  );
  assert.deepEqual(appServer.calls[1].params, {
    threadId: THREAD_ID,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(appServer.calls[2].params, {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "首条远程消息" }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    clientUserMessageId: "om_example_message",
  });
});

test("builds an attachment relay with file paths and local image input", () => {
  const input = buildFixedControllerAttachmentInput({
    text: "请看看这个附件",
    attachmentPaths: ["C:\\Bridge\\attachments\\brief.pdf", "C:\\Bridge\\attachments\\photo.png"],
    imagePaths: ["C:\\Bridge\\attachments\\photo.png"],
  });

  assert.match(input[0].text, /请看看这个附件/);
  assert.match(input[0].text, /brief\.pdf/);
  assert.match(input[0].text, /photo\.png/);
  assert.deepEqual(input[1], {
    type: "localImage",
    path: "C:\\Bridge\\attachments\\photo.png",
  });
});

test("waits while the fixed target is active, then starts exactly one new turn", async () => {
  const appServer = new FakeAppServer({
    reads: [thread("active"), thread("active"), thread("idle")],
  });
  let sleeps = 0;
  await startFixedControllerTurn(appServer, {
    threadId: THREAD_ID,
    expectedCwd: CWD,
    input: "排队消息",
    pollIntervalMs: 1,
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(sleeps, 2);
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read", "thread/read", "thread/read", "turn/start"],
  );
  assert.equal(
    appServer.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
  assert.equal(
    appServer.calls.some((call) => call.method === "turn/steer"),
    false,
  );
});

test("passes an App Server input array with only the fixed unattended execution profile", async () => {
  const appServer = new FakeAppServer({ reads: [thread("idle")] });
  const input = [
    { type: "text", text: "正文" },
    { type: "localImage", path: "F:\\relay\\image.png" },
  ];
  await startFixedControllerTurn(appServer, {
    threadId: THREAD_ID,
    input,
  });

  assert.deepEqual(appServer.calls[1].params, {
    threadId: THREAD_ID,
    input,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  for (const forbidden of ["cwd", "model", "sandbox"]) {
    assert.equal(forbidden in appServer.calls[1].params, false);
  }
});

test("waits for the exact turn id and never returns an older completed result", async () => {
  const oldTurn = {
    id: "turn-old",
    status: "completed",
    items: [{ type: "agentMessage", text: "旧结果" }],
  };
  const currentRunning = {
    id: "turn-current",
    status: "inProgress",
    items: [],
  };
  const currentCompleted = {
    id: "turn-current",
    status: "completed",
    items: [{ type: "agentMessage", text: "当前这轮的结果" }],
  };
  const appServer = new FakeAppServer({
    reads: [
      thread("active", [oldTurn, currentRunning]),
      thread("idle", [oldTurn, currentCompleted]),
    ],
  });

  const result = await waitForFixedControllerTurn(appServer, {
    threadId: THREAD_ID,
    turnId: "turn-current",
    expectedCwd: CWD,
    pollIntervalMs: 1,
    sleep: async () => {},
  });

  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "当前这轮的结果");
  assert.notEqual(result.finalText, "旧结果");
});

test("aborts an in-flight turn wait promptly so the persisted turn can recover later", async () => {
  const controller = new AbortController();
  const runningTurn = {
    id: "turn-current",
    status: "inProgress",
    items: [],
  };
  const appServer = new FakeAppServer({
    reads: [thread("active", [runningTurn])],
  });

  await assert.rejects(
    waitForFixedControllerTurn(appServer, {
      threadId: THREAD_ID,
      turnId: "turn-current",
      expectedCwd: CWD,
      signal: controller.signal,
      pollIntervalMs: 1,
      sleep: async () => controller.abort(),
    }),
    (error) => {
      assert.equal(error.code, "aborted");
      return true;
    },
  );
  assert.equal(
    appServer.calls.filter((call) => call.method === "thread/read").length,
    1,
  );
});

test("keeps polling a detached Desktop snapshot until the visible turn completes", async () => {
  const appServer = new FakeAppServer({
    reads: [
      thread("notLoaded", [
        {
          id: "turn-visible",
          status: "interrupted",
          items: [
            {
              type: "agentMessage",
              phase: "commentary",
              text: "still working",
            },
          ],
        },
      ]),
      thread("notLoaded", [
        {
          id: "turn-visible",
          status: "failed",
          items: [
            {
              type: "agentMessage",
              phase: "commentary",
              text: "detached failure snapshot",
            },
          ],
        },
      ]),
      thread("idle", [
        {
          id: "turn-visible",
          status: "completed",
          items: [
            {
              type: "agentMessage",
              phase: "final_answer",
              text: "visible final",
            },
          ],
        },
      ]),
    ],
  });

  const result = await waitForFixedControllerTurn(appServer, {
    threadId: THREAD_ID,
    turnId: "turn-visible",
    timeoutMs: 100,
    pollIntervalMs: 1,
    deferDetachedDesktopStatuses: true,
    sleep: async () => {},
  });

  assert.equal(
    appServer.calls.filter((call) => call.method === "thread/read").length,
    3,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "visible final");
});

test("keeps immediate interrupted handling for a headless turn", async () => {
  const appServer = new FakeAppServer({
    reads: [
      thread("idle", [
        {
          id: "turn-headless",
          status: "interrupted",
          items: [
            {
              type: "agentMessage",
              phase: "commentary",
              text: "not a final reply",
            },
          ],
        },
      ]),
    ],
  });

  const result = await waitForFixedControllerTurn(appServer, {
    threadId: THREAD_ID,
    turnId: "turn-headless",
    timeoutMs: 100,
  });

  assert.equal(result.status, "interrupted");
  assert.equal(result.finalText, "");
});

test("preserves the final agent message text while using trim only for emptiness", async () => {
  const completed = {
    id: "turn-current",
    status: "completed",
    items: [{ type: "agentMessage", text: "\n  精确回复  \n" }],
  };
  const appServer = new FakeAppServer({
    reads: [thread("idle", [completed])],
  });

  const result = await waitForFixedControllerTurn(appServer, {
    threadId: THREAD_ID,
    turnId: "turn-current",
  });

  assert.equal(result.finalText, "\n  精确回复  \n");
});

test("recovers the exact turn from its client message id", async () => {
  const correlated = {
    id: "turn-correlated",
    status: "completed",
    items: [
      { type: "userMessage", clientId: "om_exact_message", content: [] },
      { type: "agentMessage", text: "已处理" },
    ],
  };
  const appServer = new FakeAppServer({
    reads: [thread("notLoaded", [correlated])],
  });

  const recovered = await findFixedControllerTurnByClientMessageId(appServer, {
    threadId: THREAD_ID,
    clientUserMessageId: "om_exact_message",
  });

  assert.equal(recovered.turnId, "turn-correlated");
  assert.deepEqual(appServer.calls[0].params, {
    threadId: THREAD_ID,
    includeTurns: true,
  });
});

test("fails closed when one client message id matches multiple turns", async () => {
  const duplicate = (id) => ({
    id,
    status: "completed",
    items: [
      { type: "userMessage", clientId: "om_duplicate_message", content: [] },
    ],
  });
  const appServer = new FakeAppServer({
    reads: [
      thread("idle", [duplicate("turn-duplicate-a"), duplicate("turn-duplicate-b")]),
    ],
  });

  await assert.rejects(
    findFixedControllerTurnByClientMessageId(appServer, {
      threadId: THREAD_ID,
      clientUserMessageId: "om_duplicate_message",
    }),
    (error) => {
      assert.equal(error.code, "turn_correlation_ambiguous");
      assert.equal(error.details.matchCount, 2);
      return true;
    },
  );
});

test("counts repeated client markers inside one turn as one correlation", async () => {
  const correlated = {
    id: "turn-one",
    status: "completed",
    items: [
      { type: "userMessage", clientId: "om_repeated_marker", content: [] },
      { type: "userMessage", clientId: "om_repeated_marker", content: [] },
    ],
  };
  const appServer = new FakeAppServer({ reads: [thread("idle", [correlated])] });

  const recovered = await findFixedControllerTurnByClientMessageId(appServer, {
    threadId: THREAD_ID,
    clientUserMessageId: "om_repeated_marker",
  });

  assert.equal(recovered.turnId, "turn-one");
});

test("runs start and exact-turn completion as one fixed relay operation", async () => {
  const completed = {
    id: "turn-current",
    status: "completed",
    items: [{ type: "agentMessage", text: "本地总控回复" }],
  };
  const appServer = new FakeAppServer({
    reads: [thread("idle"), thread("idle", [completed])],
  });

  const result = await runFixedControllerRelay(appServer, {
    threadId: THREAD_ID,
    expectedCwd: CWD,
    input: "请处理",
    sleep: async () => {},
  });

  assert.equal(result.execution.turnId, "turn-current");
  assert.equal(result.completion.finalText, "本地总控回复");
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read", "turn/start", "thread/read"],
  );
});

test("fails closed when the fixed target cannot be reached", async () => {
  const appServer = new FakeAppServer({ readError: new Error("offline") });

  await assert.rejects(
    verifyFixedControllerTarget(appServer, {
      threadId: THREAD_ID,
      expectedCwd: CWD,
    }),
    (error) => {
      assert.ok(error instanceof FixedControllerRelayError);
      assert.equal(error.code, "target_unreachable");
      assert.match(error.message, /offline/);
      return true;
    },
  );
  assert.deepEqual(
    appServer.calls.map((call) => call.method),
    ["thread/read"],
  );
});

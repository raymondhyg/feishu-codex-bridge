import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ControllerThreadToolError,
  executeControllerThreadRequest,
  normalizeControllerThreadRequest,
  readControllerThreadRequestFile,
  safeControllerThreadToolError,
} from "./controller-thread-tool.mjs";

const controllerId = "019f1111-1111-4111-8111-111111111111";
const targetId = "019f2222-2222-4222-8222-222222222222";
const targetTitle = "【专项主线】飞书 CLI 使用 V2";
const requestId = "feishu-message-0001";
const correlation = createHash("sha256")
  .update(requestId)
  .digest("hex")
  .slice(0, 8)
  .toUpperCase();

function fakeAppServer(handler) {
  return {
    calls: [],
    waits: [],
    async request(method, params) {
      this.calls.push({ method, params });
      return handler(method, params, this);
    },
    async waitForTurn(threadId, turnId, timeoutMs) {
      this.waits.push({ threadId, turnId, timeoutMs });
      return handler("waitForTurn", { threadId, turnId, timeoutMs }, this);
    },
  };
}

function listResult(threads) {
  return { data: threads, nextCursor: null };
}

test("normalizes only the three supported JSON actions", () => {
  assert.deepEqual(normalizeControllerThreadRequest({ action: "list" }), {
    action: "list",
    limit: 50,
  });
  assert.deepEqual(
    normalizeControllerThreadRequest({
      action: "read",
      title: `  ${targetTitle}  `,
    }),
    { action: "read", title: targetTitle, turnLimit: 6 },
  );
  assert.throws(
    () => normalizeControllerThreadRequest({ action: "send", title: targetTitle }),
    ControllerThreadToolError,
  );
  assert.equal(
    normalizeControllerThreadRequest({
      action: "send-and-wait",
      title: targetTitle,
      input: "原样转发",
      requestId,
    }).requestId,
    requestId,
  );
});

test("lists safe task metadata without internal ids or cwd", async () => {
  const appServer = fakeAppServer((method) => {
    assert.equal(method, "thread/list");
    return listResult([
      {
        id: targetId,
        name: targetTitle,
        cwd: "C:\\private\\workspace",
        status: { type: "idle" },
        updatedAt: 123,
      },
    ]);
  });
  const result = await executeControllerThreadRequest(appServer, {
    action: "list",
  });

  assert.deepEqual(result, {
    ok: true,
    action: "list",
    total: 1,
    tasks: [{ title: targetTitle, status: "空闲", updatedAt: 123 }],
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /019f2222|private\\\\workspace|"id"/);
});

test("exhausts visible task pagination before reporting uniqueness", async () => {
  const appServer = fakeAppServer((method, params) => {
    assert.equal(method, "thread/list");
    if (!params.cursor) {
      return {
        data: [
          { id: targetId, name: targetTitle, status: { type: "idle" } },
        ],
        nextCursor: "page-two",
      };
    }
    assert.equal(params.cursor, "page-two");
    return {
      data: [
        {
          id: "019f3333-3333-4333-8333-333333333333",
          name: "第二页任务",
          status: { type: "idle" },
        },
      ],
      nextCursor: null,
    };
  });

  const result = await executeControllerThreadRequest(appServer, {
    action: "list",
  });
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.tasks.map(({ title }) => title),
    [targetTitle, "第二页任务"],
  );
  assert.equal(appServer.calls.length, 2);
});

test("fails closed when visible task pagination loops", async () => {
  const appServer = fakeAppServer((method) => {
    assert.equal(method, "thread/list");
    return {
      data: [{ id: targetId, name: targetTitle, status: { type: "idle" } }],
      nextCursor: "looping-cursor",
    };
  });

  await assert.rejects(
    executeControllerThreadRequest(appServer, { action: "list" }),
    (error) => error.code === "task_list_incomplete",
  );
  assert.equal(appServer.calls.length, 2);
});

test("fails closed at the complete-list hard page limit", async () => {
  let page = 0;
  const appServer = fakeAppServer((method) => {
    assert.equal(method, "thread/list");
    page += 1;
    return {
      data: [
        {
          id: `019f4444-4444-4444-8444-${String(page).padStart(12, "0")}`,
          name: `任务 ${page}`,
          status: { type: "idle" },
        },
      ],
      nextCursor: `cursor-${page}`,
    };
  });

  await assert.rejects(
    executeControllerThreadRequest(appServer, { action: "list" }),
    (error) => error.code === "task_list_incomplete",
  );
  assert.equal(appServer.calls.length, 50);
});

test("reads only an exact title and returns a bounded recent transcript", async () => {
  const thread = {
    id: targetId,
    name: targetTitle,
    cwd: "C:\\private\\workspace",
    status: { type: "idle" },
    turns: [
      {
        id: "turn-private",
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "核实旧会话" }] },
          { type: "agentMessage", text: "已经核实，建议归档。" },
        ],
      },
    ],
  };
  const appServer = fakeAppServer((method, params) => {
    if (method === "thread/list") return listResult([thread]);
    assert.equal(method, "thread/read");
    assert.equal(params.threadId, targetId);
    return { thread };
  });

  const result = await executeControllerThreadRequest(appServer, {
    action: "read",
    title: targetTitle,
  });
  assert.equal(result.task.title, targetTitle);
  assert.equal(result.task.turnCount, 1);
  assert.deepEqual(result.task.recentTurns, [
    {
      status: "completed",
      user: "核实旧会话",
      assistant: "已经核实，建议归档。",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /019f2222|turn-private|private\\\\workspace/);
});

test("rejects partial and ambiguous titles before reading or sending", async () => {
  const appServer = fakeAppServer((method) => {
    assert.equal(method, "thread/list");
    return listResult([
      { id: targetId, name: targetTitle, status: { type: "idle" } },
      {
        id: "019f3333-3333-4333-8333-333333333333",
        name: targetTitle,
        status: { type: "idle" },
      },
    ]);
  });

  await assert.rejects(
    executeControllerThreadRequest(appServer, {
      action: "read",
      title: "飞书 CLI 使用",
    }),
    (error) => error.code === "title_not_found",
  );
  await assert.rejects(
    executeControllerThreadRequest(appServer, {
      action: "send-and-wait",
      title: targetTitle,
      input: "请核实",
      requestId,
    }),
    (error) => error.code === "title_ambiguous",
  );
  assert.equal(appServer.calls.length, 2);
});

test("exact title matching does not collapse internal whitespace", async () => {
  const appServer = fakeAppServer((method) => {
    assert.equal(method, "thread/list");
    return listResult([
      { id: targetId, name: "任务  双空格", status: { type: "idle" } },
    ]);
  });
  await assert.rejects(
    executeControllerThreadRequest(appServer, {
      action: "read",
      title: "任务 单空格",
    }),
    (error) => error.code === "title_not_found",
  );
});

test("rejects a send to the fixed controller itself", async () => {
  const appServer = fakeAppServer((method) => {
    assert.equal(method, "thread/list");
    return listResult([
      {
        id: controllerId,
        name: "【入口】飞书总控 V0.8",
        status: { type: "idle" },
      },
    ]);
  });

  await assert.rejects(
    executeControllerThreadRequest(
      appServer,
      {
        action: "send-and-wait",
        title: "【入口】飞书总控 V0.8",
        input: "循环发送",
        requestId,
      },
      { fixedControllerThreadId: controllerId },
    ),
    (error) => error.code === "self_send_forbidden",
  );
  assert.equal(appServer.calls.length, 1);
});

test("fails closed when the exact target is already active", async () => {
  const activeThread = {
    id: targetId,
    name: targetTitle,
    status: { type: "active" },
    turns: [{ id: "active-private-turn", status: "inProgress" }],
  };
  const appServer = fakeAppServer((method, params) => {
    if (method === "thread/list") {
      return listResult([activeThread]);
    }
    if (method === "thread/read") {
      assert.equal(params.threadId, targetId);
      return { thread: activeThread };
    }
    throw new Error(`active target must not receive ${method}`);
  });

  await assert.rejects(
    executeControllerThreadRequest(
      appServer,
      {
        action: "send-and-wait",
        title: targetTitle,
        input: "不要插入正在执行的回合",
        requestId,
      },
      { fixedControllerThreadId: controllerId },
    ),
    (error) => error.code === "target_active",
  );
  assert.equal(
    appServer.calls.filter(({ method }) =>
      ["turn/start", "turn/steer"].includes(method),
    ).length,
    0,
  );
  assert.equal(appServer.waits.length, 0);
});

test("forwards input unchanged and waits for the exact target turn", async () => {
  const exactTurnId = "turn-exact-private";
  let started = false;
  const appServer = fakeAppServer((method, params) => {
    if (method === "thread/list") {
      return listResult([
        { id: targetId, name: targetTitle, status: { type: "idle" } },
      ]);
    }
    if (method === "thread/resume") {
      assert.deepEqual(params, { threadId: targetId });
      return {
        thread: { id: targetId, name: targetTitle, status: { type: "idle" } },
      };
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: targetId,
          name: targetTitle,
          status: { type: "idle" },
          turns: started
            ? [
                {
                  id: exactTurnId,
                  status: "completed",
                  items: [
                    {
                      type: "agentMessage",
                      text: `目标会话已经处理完成，内部编号 ${targetId}。`,
                    },
                  ],
                },
              ]
            : [],
        },
      };
    }
    if (method === "turn/start") {
      assert.equal(params.threadId, targetId);
      assert.deepEqual(params.input, [{ type: "text", text: "老板的原话，不加包装" }]);
      assert.equal(params.clientUserMessageId, requestId);
      started = true;
      return { turn: { id: exactTurnId } };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  const result = await executeControllerThreadRequest(
    appServer,
    {
      action: "send-and-wait",
      title: targetTitle,
      input: "老板的原话，不加包装",
      requestId,
      timeoutMs: 3210,
    },
    { fixedControllerThreadId: controllerId },
  );
  assert.deepEqual(result, {
    ok: true,
    action: "send-and-wait",
    task: { title: targetTitle },
    mode: "started",
    completionStatus: "completed",
    correlationCode: correlation,
    finalText: "目标会话已经处理完成，内部编号 [redacted-id]。",
  });
  assert.doesNotMatch(JSON.stringify(result), /019f2222|turn-exact-private/);
  assert.equal(
    appServer.calls.filter(({ method }) => method === "turn/start").length,
    1,
  );
  assert.equal(appServer.waits.length, 0);
  assert.ok(
    appServer.calls.filter(({ method }) => method === "thread/read").length >= 2,
  );
});

test("polling ignores an older completion and returns only the exact started turn", async () => {
  let started = false;
  let postStartReads = 0;
  const appServer = fakeAppServer((method) => {
    if (method === "thread/list") {
      return listResult([
        { id: targetId, name: targetTitle, status: { type: "idle" } },
      ]);
    }
    if (method === "thread/resume") {
      return {
        thread: { id: targetId, name: targetTitle, status: { type: "idle" } },
      };
    }
    if (method === "thread/read") {
      if (started) postStartReads += 1;
      const turns = [
        {
          id: "older-turn",
          status: "completed",
          items: [{ type: "agentMessage", text: "旧结果" }],
        },
      ];
      if (postStartReads >= 2) {
        turns.push({
          id: "expected-turn",
          status: "completed",
          items: [{ type: "agentMessage", text: "精确新结果" }],
        });
      }
      return {
        thread: {
          id: targetId,
          name: targetTitle,
          status: { type: "idle" },
          turns: started ? turns : [],
        },
      };
    }
    if (method === "turn/start") {
      started = true;
      return { turn: { id: "expected-turn" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  const result = await executeControllerThreadRequest(
    appServer,
    {
      action: "send-and-wait",
      title: targetTitle,
      input: "请处理",
      requestId,
    },
    {
      fixedControllerThreadId: controllerId,
      sleep: async () => {},
      now: () => 0,
    },
  );
  assert.equal(result.finalText, "精确新结果");
  assert.equal(postStartReads, 2);
  assert.equal(appServer.waits.length, 0);
});

test("a started timeout is correlated and never resent", async () => {
  let started = false;
  const appServer = fakeAppServer((method) => {
    if (method === "thread/list") {
      return listResult([
        { id: targetId, name: targetTitle, status: { type: "idle" } },
      ]);
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: targetId,
          name: targetTitle,
          status: { type: "idle" },
          turns: started
            ? [{ id: "timeout-turn", status: "inProgress", items: [] }]
            : [],
        },
      };
    }
    if (method === "thread/resume") {
      return {
        thread: { id: targetId, name: targetTitle, status: { type: "idle" } },
      };
    }
    if (method === "turn/start") {
      started = true;
      return { turn: { id: "timeout-turn" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  let captured;
  await assert.rejects(
    executeControllerThreadRequest(
      appServer,
      {
        action: "send-and-wait",
        title: targetTitle,
        input: "只发送一次",
        requestId,
        timeoutMs: 1000,
      },
      {
        fixedControllerThreadId: controllerId,
        now: (() => {
          let calls = 0;
          return () => (calls++ === 0 ? 0 : 2000);
        })(),
        sleep: async () => {},
      },
    ),
    (error) => {
      captured = error;
      return error.code === "started_but_unfinished";
    },
  );
  assert.equal(
    appServer.calls.filter(({ method }) => method === "turn/start").length,
    1,
  );
  assert.deepEqual(safeControllerThreadToolError(captured), {
    ok: false,
    error: {
      code: "started_but_unfinished",
      message:
        "The target turn started but did not finish before the timeout; do not resend it.",
    },
    correlationCode: correlation,
  });
  assert.equal(appServer.waits.length, 0);
});

test("recovers an uncertain turn/start outcome by the same request id", async () => {
  const recoveredTurnId = "recovered-private-turn";
  let startAttempted = false;
  let recoveryReads = 0;
  const appServer = fakeAppServer((method) => {
    if (method === "thread/list") {
      return listResult([
        { id: targetId, name: targetTitle, status: { type: "idle" } },
      ]);
    }
    if (method === "thread/resume") {
      return {
        thread: { id: targetId, name: targetTitle, status: { type: "idle" } },
      };
    }
    if (method === "turn/start") {
      startAttempted = true;
      throw new Error("app server disconnected after send");
    }
    if (method === "thread/read") {
      if (!startAttempted) {
        return {
          thread: {
            id: targetId,
            name: targetTitle,
            status: { type: "idle" },
            turns: [],
          },
        };
      }
      recoveryReads += 1;
      return {
        thread: {
          id: targetId,
          name: targetTitle,
          status: { type: recoveryReads === 1 ? "active" : "idle" },
          turns: [
            {
              id: recoveredTurnId,
              status: recoveryReads === 1 ? "inProgress" : "completed",
              items: [
                { type: "userMessage", clientId: requestId, text: "不确定发送" },
                ...(recoveryReads === 1
                  ? []
                  : [{ type: "agentMessage", text: "已从同一请求恢复。" }]),
              ],
            },
          ],
        },
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  const result = await executeControllerThreadRequest(
    appServer,
    {
      action: "send-and-wait",
      title: targetTitle,
      input: "不确定发送",
      requestId,
    },
    {
      fixedControllerThreadId: controllerId,
      sleep: async () => {},
      now: () => 0,
    },
  );
  assert.equal(result.mode, "recovered");
  assert.equal(result.finalText, "已从同一请求恢复。");
  assert.equal(result.correlationCode, correlation);
  assert.equal(
    appServer.calls.filter(({ method }) => method === "turn/start").length,
    1,
  );
  assert.equal(appServer.waits.length, 0);
});

test("reports an unknown start outcome without resending when recovery finds nothing", async () => {
  let startAttempted = false;
  const appServer = fakeAppServer((method) => {
    if (method === "thread/list") {
      return listResult([
        { id: targetId, name: targetTitle, status: { type: "idle" } },
      ]);
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: targetId,
          name: targetTitle,
          status: { type: "idle" },
          turns: [],
        },
      };
    }
    if (method === "thread/resume") {
      return {
        thread: { id: targetId, name: targetTitle, status: { type: "idle" } },
      };
    }
    if (method === "turn/start") {
      startAttempted = true;
      throw new Error("turn/start response connection lost");
    }
    throw new Error(`unexpected method: ${method}`);
  });

  let captured;
  await assert.rejects(
    executeControllerThreadRequest(
      appServer,
      {
        action: "send-and-wait",
        title: targetTitle,
        input: "只尝试一次",
        requestId,
      },
      { fixedControllerThreadId: controllerId },
    ),
    (error) => {
      captured = error;
      return error.code === "start_outcome_unknown";
    },
  );
  assert.equal(startAttempted, true);
  assert.equal(
    appServer.calls.filter(({ method }) => method === "turn/start").length,
    1,
  );
  assert.deepEqual(safeControllerThreadToolError(captured), {
    ok: false,
    error: {
      code: "start_outcome_unknown",
      message:
        "The send outcome could not be verified; use the correlation code and do not resend automatically.",
    },
    correlationCode: correlation,
  });
});

test("an existing client message id is deduplicated without another send", async () => {
  const existingTurn = {
    id: "existing-private-turn",
    status: "completed",
    items: [
      { type: "userMessage", clientId: requestId, text: "此前已发送" },
      { type: "agentMessage", text: "此前已完成。" },
    ],
  };
  const appServer = fakeAppServer((method) => {
    if (method === "thread/list") {
      return listResult([
        { id: targetId, name: targetTitle, status: { type: "idle" } },
      ]);
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: targetId,
          name: targetTitle,
          status: { type: "idle" },
          turns: [existingTurn],
        },
      };
    }
    throw new Error(`deduplicated request must not call ${method}`);
  });

  const result = await executeControllerThreadRequest(
    appServer,
    {
      action: "send-and-wait",
      title: targetTitle,
      input: "此前已发送",
      requestId,
    },
    { fixedControllerThreadId: controllerId },
  );
  assert.equal(result.mode, "deduplicated");
  assert.equal(result.finalText, "此前已完成。");
  assert.equal(result.correlationCode, correlation);
  assert.equal(
    appServer.calls.filter(({ method }) => method === "turn/start").length,
    0,
  );
});

test("duplicate client message ids fail closed instead of selecting a turn", async () => {
  const duplicateTurns = ["duplicate-turn-a", "duplicate-turn-b"].map((id) => ({
    id,
    status: "completed",
    items: [
      { type: "userMessage", clientId: requestId, text: "同源请求" },
      { type: "agentMessage", text: `结果 ${id}` },
    ],
  }));
  const appServer = fakeAppServer((method) => {
    if (method === "thread/list") {
      return listResult([
        { id: targetId, name: targetTitle, status: { type: "idle" } },
      ]);
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: targetId,
          name: targetTitle,
          status: { type: "idle" },
          turns: duplicateTurns,
        },
      };
    }
    throw new Error(`ambiguous request must not call ${method}`);
  });

  await assert.rejects(
    executeControllerThreadRequest(
      appServer,
      {
        action: "send-and-wait",
        title: targetTitle,
        input: "同源请求",
        requestId,
      },
      { fixedControllerThreadId: controllerId },
    ),
    (error) => error.code === "turn_correlation_ambiguous",
  );
  assert.equal(
    appServer.calls.filter(({ method }) => method === "turn/start").length,
    0,
  );
});

test("completed turns without a final response fail closed", async () => {
  const appServer = fakeAppServer((method) => {
    if (method === "thread/list") {
      return listResult([
        { id: targetId, name: targetTitle, status: { type: "idle" } },
      ]);
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: targetId,
          name: targetTitle,
          status: { type: "idle" },
          turns: [
            {
              id: "empty-private-turn",
              status: "completed",
              items: [{ type: "userMessage", clientId: requestId, text: "已发送" }],
            },
          ],
        },
      };
    }
    throw new Error(`empty completed request must not call ${method}`);
  });

  await assert.rejects(
    executeControllerThreadRequest(
      appServer,
      {
        action: "send-and-wait",
        title: targetTitle,
        input: "已发送",
        requestId,
      },
      { fixedControllerThreadId: controllerId },
    ),
    (error) => error.code === "empty_final_text",
  );
});

test("request files are restricted to the dedicated allowed root", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "controller-thread-tool-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const allowedRoot = path.join(temporaryRoot, "work", "controller-thread-requests");
  await mkdir(allowedRoot, { recursive: true });
  const allowedFile = path.join(allowedRoot, "request.json");
  const outsideFile = path.join(temporaryRoot, "outside.json");
  await writeFile(allowedFile, '{"action":"list"}', "utf8");
  await writeFile(outsideFile, '{"action":"list"}', "utf8");

  assert.deepEqual(
    await readControllerThreadRequestFile(allowedFile, { allowedRequestRoot: allowedRoot }),
    { action: "list" },
  );
  await assert.rejects(
    readControllerThreadRequestFile(outsideFile, { allowedRequestRoot: allowedRoot }),
    (error) => error.code === "request_file_invalid",
  );
});

test("unexpected errors are reduced to a safe JSON error", () => {
  const result = safeControllerThreadToolError(
    new Error(`private failure ${targetId}`),
  );
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "operation_failed",
      message: "The controller thread operation failed.",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /019f2222/);
});

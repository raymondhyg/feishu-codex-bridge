const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 5;

function turnStatus(turn) {
  if (typeof turn?.status === "string") return turn.status;
  return turn?.status?.type || "";
}

function activeTurnId(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return (
    [...turns]
      .reverse()
      .find((turn) => turnStatus(turn) === "inProgress")?.id || null
  );
}

export function codexThreadStatus(thread) {
  const type = thread?.status?.type;
  if (type === "active") return "执行中";
  if (type === "idle") return "空闲";
  if (type === "systemError") return "异常";
  if (type === "notLoaded") return "未载入";
  return "未知";
}

export async function listCodexThreads(appServer, options = {}) {
  const threads = [];
  const pageLimit = options.pageLimit || DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = {
      archived: Boolean(options.archived),
      limit: pageLimit,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: options.sourceKinds || ["vscode", "appServer"],
    };
    if (cursor) params.cursor = cursor;
    if (options.cwd) params.cwd = options.cwd;
    if (options.searchTerm) params.searchTerm = options.searchTerm;
    const result = await appServer.request("thread/list", params, {
      timeoutMs: options.timeoutMs,
    });
    const pageThreads = Array.isArray(result?.data) ? result.data : [];
    threads.push(...pageThreads);
    const nextCursor = result?.nextCursor || null;
    if (
      options.requireComplete &&
      nextCursor &&
      seenCursors.has(nextCursor)
    ) {
      const error = new Error("thread/list cursor repeated before completion");
      error.code = "CODEX_THREAD_LIST_INCOMPLETE";
      throw error;
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (!cursor) break;
    if (pageThreads.length === 0) {
      if (options.requireComplete) {
        const error = new Error("thread/list returned an empty non-terminal page");
        error.code = "CODEX_THREAD_LIST_INCOMPLETE";
        throw error;
      }
      break;
    }
    if (options.requireComplete && page === maxPages - 1) {
      const error = new Error("thread/list exceeded its complete-list page limit");
      error.code = "CODEX_THREAD_LIST_INCOMPLETE";
      throw error;
    }
  }
  return threads;
}

export async function readCodexThreadDetail(appServer, threadId) {
  const result = await appServer.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  return result?.thread || null;
}

export async function sendCodexThreadTurn(appServer, options = {}) {
  const resumed = await appServer.request("thread/resume", {
    threadId: options.threadId,
  });
  let thread = resumed?.thread || null;
  if (!thread || thread?.status?.type === "active") {
    thread = await readCodexThreadDetail(appServer, options.threadId);
  }
  if (!thread) throw new Error("thread/resume returned no thread");
  if (thread?.status?.type === "active" || activeTurnId(thread)) {
    const error = new Error("target thread is active");
    error.code = "CODEX_THREAD_ACTIVE";
    throw error;
  }

  const params = {
    threadId: options.threadId,
    input: [{ type: "text", text: options.input }],
  };
  if (
    typeof options.clientUserMessageId === "string" &&
    options.clientUserMessageId.trim()
  ) {
    params.clientUserMessageId = options.clientUserMessageId.trim();
  }
  let result;
  try {
    result = await appServer.request("turn/start", params, {
      timeoutMs: options.timeoutMs,
    });
  } catch (cause) {
    if (!options.clientUserMessageId) throw cause;
    const error = new Error("turn/start outcome is unknown", { cause });
    error.code = "CODEX_TURN_START_OUTCOME_UNKNOWN";
    throw error;
  }
  const turnId = result?.turn?.id;
  if (!turnId) {
    if (!options.clientUserMessageId) {
      throw new Error("turn/start returned no turn id");
    }
    const error = new Error("turn/start outcome is unknown");
    error.code = "CODEX_TURN_START_OUTCOME_UNKNOWN";
    throw error;
  }
  return {
    mode: "started",
    threadId: options.threadId,
    turnId,
  };
}

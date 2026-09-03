import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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

export async function resolveCodexCli(config = {}) {
  if (config.codexCliScript) {
    await access(config.codexCliScript, fsConstants.R_OK);
    return { command: process.execPath, prefix: [config.codexCliScript] };
  }

  if (process.platform !== "win32") {
    return { command: "codex", prefix: [] };
  }

  const bundledScript = path.join(
    moduleDirectory,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  try {
    await access(bundledScript, fsConstants.R_OK);
    return { command: process.execPath, prefix: [bundledScript] };
  } catch {
    // Fall through to a globally installed Codex CLI.
  }

  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const script = path.join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    try {
      await access(script, fsConstants.R_OK);
      return { command: process.execPath, prefix: [script] };
    } catch {
      // Continue through PATH.
    }
  }

  throw new Error(
    "Unable to resolve codex CLI. Install @openai/codex or set codexCliScript.",
  );
}

export async function getCodexCliVersion(codexCli, cwd) {
  const result = await runProcess(
    codexCli.command,
    [...codexCli.prefix, "--version"],
    { cwd },
  );
  if (result.code !== 0) {
    throw new Error(
      `codex --version failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return result.stdout.trim();
}

export class CodexAppServerClient {
  constructor(codexCli, options = {}) {
    this.codexCli = codexCli;
    this.options = options;
    this.child = null;
    this.output = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.child = spawn(
      this.codexCli.command,
      [
        ...this.codexCli.prefix,
        ...(Array.isArray(this.options.appServerArgs)
          ? this.options.appServerArgs
          : []),
        "app-server",
      ],
      {
        cwd: this.options.cwd,
        env: this.options.env || process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.output = readline.createInterface({ input: this.child.stdout });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.child.on("error", (error) => this.#fail(error));
    this.child.on("exit", (code) => {
      if (this.closed && (code === 0 || code === null)) return;
      this.#fail(
        new Error(
          `Codex App Server exited (exit ${code}): ${this.stderr.trim()}`,
        ),
      );
    });
    this.output.on("line", (line) => this.#handleLine(line));
    this.#send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "lark_codex_bridge",
          title: "Lark Codex Bridge",
          version: this.options.clientVersion || "unspecified",
        },
      },
    });
    return this.readyPromise;
  }

  #send(message) {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error("Codex App Server stdin is unavailable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#fail(new Error("Codex App Server returned invalid JSON"));
      return;
    }

    if (message.id === 0) {
      if (message.error) {
        this.#fail(
          new Error(
            `Codex App Server initialize failed: ${message.error.message || "unknown error"}`,
          ),
        );
        return;
      }
      this.#send({ method: "initialized", params: {} });
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `${pending.method} failed: ${message.error.message || "unknown error"}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.#send({
        id: message.id,
        error: {
          code: -32601,
          message: "Interactive requests are unavailable in the Feishu relay",
        },
      });
    }
  }

  #fail(error) {
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(method, params = {}, options = {}) {
    await this.start();
    if (this.closed) throw new Error("Codex App Server client is closed");
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.#send({ method, id, params });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.output) this.output.close();
    if (this.child && !this.child.stdin.destroyed) this.child.stdin.end();
    await new Promise((resolve) => {
      if (!this.child || this.child.exitCode !== null) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.#fail(new Error("Codex App Server client closed"));
  }
}

export function codexThreadTitle(thread) {
  const value = String(thread?.name || thread?.preview || "").replace(/\s+/g, " ").trim();
  return value || "已绑定总控";
}

export function codexThreadStatus(thread) {
  const type = thread?.status?.type;
  if (type === "active") return "执行中";
  if (type === "idle") return "空闲";
  if (type === "systemError") return "异常";
  if (type === "notLoaded") return "未载入";
  return "未知";
}

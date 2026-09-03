import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("./configure-fixed-controller-relay.mjs", import.meta.url),
);
const oldThreadId = "11111111-1111-4111-8111-111111111111";
const newThreadId = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "lark-fixed-rebind-"));
  const oldCwd = path.join(root, "old-controller");
  const newCwd = path.join(root, "new-controller");
  await mkdir(oldCwd);
  await mkdir(newCwd);
  const configPath = path.join(root, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        allowedSenderIds: ["authorized-sender"],
        fixedControllerThreadId: oldThreadId,
        codexWorkingDirectory: oldCwd,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { configPath, newCwd, oldCwd };
}

test("rebind updates the exact thread and working directory without printing either", async () => {
  const { configPath, newCwd } = await fixture();
  const { stdout } = await execFileAsync(
    process.execPath,
    [scriptPath, newThreadId, newCwd],
    { env: { ...process.env, LARK_CODEX_BRIDGE_CONFIG: configPath } },
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const receipt = JSON.parse(stdout);

  assert.equal(config.fixedControllerThreadId, newThreadId);
  assert.equal(config.codexWorkingDirectory, newCwd);
  assert.equal(config.fixedControllerDesktopVisibility, "require");
  assert.equal(receipt.fixedControllerThreadConfigured, true);
  assert.equal(receipt.fixedControllerWorkingDirectoryConfigured, true);
  assert.equal(stdout.includes(newThreadId), false);
  assert.equal(stdout.includes(newCwd), false);
});

test("rebind to a different thread requires an explicit working directory", async () => {
  const { configPath, oldCwd } = await fixture();

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, newThreadId], {
      env: { ...process.env, LARK_CODEX_BRIDGE_CONFIG: configPath },
    }),
    /requires its exact working directory/,
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.fixedControllerThreadId, oldThreadId);
  assert.equal(config.codexWorkingDirectory, oldCwd);
});

test("rebind rejects a missing working directory and preserves the config", async () => {
  const { configPath, oldCwd } = await fixture();
  const missingCwd = path.join(path.dirname(oldCwd), "missing-controller");

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, newThreadId, missingCwd], {
      env: { ...process.env, LARK_CODEX_BRIDGE_CONFIG: configPath },
    }),
    /working directory does not exist/,
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.fixedControllerThreadId, oldThreadId);
  assert.equal(config.codexWorkingDirectory, oldCwd);
});

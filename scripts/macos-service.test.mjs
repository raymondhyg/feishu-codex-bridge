import test from "node:test";
import assert from "node:assert/strict";

import { bridgeProcessIdentity } from "./bridge-service.mjs";
import { buildLaunchAgent } from "./launch-agent.mjs";

test("macOS process identity accepts only node running the exact bridge script", async () => {
  const bridgeScript = "/Applications/Bridge/scripts/bridge.mjs";
  const runner = async (_command, args) => {
    assert.deepEqual(args, ["-p", "123", "-o", "command="]);
    return {
      code: 0,
      stdout: `/opt/homebrew/bin/node ${bridgeScript}\n`,
      stderr: "",
    };
  };
  assert.equal(
    await bridgeProcessIdentity(123, { run: runner, bridgeScript }),
    "bridge",
  );
  assert.equal(
    await bridgeProcessIdentity(123, {
      bridgeScript,
      run: async () => ({
        code: 0,
        stdout: "/opt/homebrew/bin/node /Applications/Bridge/scripts/other.mjs\n",
        stderr: "",
      }),
    }),
    "other",
  );
  assert.equal(
    await bridgeProcessIdentity(123, {
      bridgeScript,
      run: async () => ({
        code: 0,
        stdout: `/opt/homebrew/bin/node ${bridgeScript}.bak\n`,
        stderr: "",
      }),
    }),
    "other",
  );
});

test("LaunchAgent uses fixed absolute paths and private log files", () => {
  const plist = buildLaunchAgent({
    nodeExecutable: "/opt/homebrew/bin/node",
    bridgeScript: "/Users/test/Bridge/scripts/bridge.mjs",
    workingDirectory: "/Users/test/Bridge/scripts",
    runtimeDirectory: "/Users/test/.codex/private/lark-im-codex-bridge",
  });
  assert.match(plist, /com\.openai\.lark-codex-bridge/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/test\/Bridge\/scripts\/bridge\.mjs<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /service\.stdout\.log/);
  assert.match(plist, /service\.stderr\.log/);
  assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/local\/bin/);
  assert.doesNotMatch(plist, /USERPROFILE|powershell|wscript/i);
});

test("LaunchAgent XML escapes paths", () => {
  const plist = buildLaunchAgent({
    nodeExecutable: "/tmp/node&tool",
    bridgeScript: "/tmp/<bridge>.mjs",
    workingDirectory: "/tmp/'workspace'",
    runtimeDirectory: '/tmp/"private"',
  });
  assert.match(plist, /node&amp;tool/);
  assert.match(plist, /&lt;bridge&gt;\.mjs/);
  assert.match(plist, /&apos;workspace&apos;/);
  assert.match(plist, /&quot;private&quot;/);
});

test("LaunchAgent installer documents first-install bootout tolerance", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("launch-agent.mjs", import.meta.url), "utf8"),
  );
  assert.match(source, /Boot-out failed: \(3\|5\)/);
  assert.match(source, /Input\\\/output error/);
});

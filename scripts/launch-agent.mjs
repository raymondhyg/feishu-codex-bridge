import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const label = "com.openai.lark-codex-bridge";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bridgeScript = path.join(scriptDirectory, "bridge.mjs");
const runtimeDirectory = path.join(homedir(), ".codex", "private", "lark-im-codex-bridge");
const agentPath = path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildLaunchAgent(options = {}) {
  const caffeinateExecutable = options.caffeinateExecutable || "/usr/bin/caffeinate";
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const sourceScript = options.bridgeScript || bridgeScript;
  const workingDirectory = options.workingDirectory || scriptDirectory;
  const privateDirectory = options.runtimeDirectory || runtimeDirectory;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(caffeinateExecutable)}</string>
    <string>-s</string>
    <string>${xml(nodeExecutable)}</string>
    <string>${xml(sourceScript)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(privateDirectory, "service.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(privateDirectory, "service.stderr.log"))}</string>
</dict>
</plist>
`;
}

async function launchctl(args, tolerateMissing = false) {
  try {
    return await execFileAsync("/bin/launchctl", args);
  } catch (error) {
    if (tolerateMissing && /Could not find service|No such process|Boot-out failed: (3|5)|Input\/output error/.test(error.stderr || error.message)) {
      return null;
    }
    throw error;
  }
}

async function install() {
  if (process.platform !== "darwin") throw new Error("LaunchAgent installation requires macOS");
  await mkdir(path.dirname(agentPath), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await writeFile(agentPath, buildLaunchAgent(), { encoding: "utf8", mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  await launchctl(["bootout", domain, agentPath], true);
  await launchctl(["bootstrap", domain, agentPath]);
  await launchctl(["enable", `${domain}/${label}`]);
  await launchctl(["kickstart", "-k", `${domain}/${label}`]);
  return {
    ok: true,
    status: "installed",
    label,
    sleep_policy: "prevent-idle-system-sleep-on-ac-power",
    display_sleep_unchanged: true,
  };
}

async function uninstall() {
  if (process.platform !== "darwin") throw new Error("LaunchAgent removal requires macOS");
  const domain = `gui/${process.getuid()}`;
  await launchctl(["bootout", domain, agentPath], true);
  await rm(agentPath, { force: true });
  return { ok: true, status: "uninstalled", label };
}

async function status() {
  try {
    await readFile(agentPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, installed: false, label };
    throw error;
  }
  const domain = `gui/${process.getuid()}`;
  try {
    const result = await launchctl(["print", `${domain}/${label}`]);
    return { ok: true, installed: true, loaded: true, label, detail: result.stdout.trim().slice(0, 1000) };
  } catch {
    return { ok: true, installed: true, loaded: false, label };
  }
}

async function main() {
  const command = process.argv[2];
  const result = command === "install" ? await install() : command === "uninstall" ? await uninstall() : command === "status" ? await status() : null;
  if (!result) throw new Error("Usage: node launch-agent.mjs <install|uninstall|status>");
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function run(command, args) {
  const child = spawn(command, args, {
    cwd: scriptDirectory,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

const action = process.argv[2];
const extra = process.argv.slice(3);
if (!action) throw new Error("Missing service action");

if (process.platform === "win32") {
  const scripts = {
    start: ["start-bridge.ps1", "-Foreground"],
    stop: ["stop-bridge.ps1"],
    health: ["health-check.ps1"],
    "install-startup": ["install-startup-task.ps1"],
    "uninstall-startup": ["uninstall-startup-task.ps1"],
  };
  const target = scripts[action];
  if (!target) throw new Error(`Unsupported Windows service action: ${action}`);
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(scriptDirectory, target[0]),
    ...target.slice(1),
    ...extra,
  ]);
} else if (process.platform === "darwin") {
  const scripts = {
    start: ["bridge-service.mjs", "start", "--foreground"],
    stop: ["bridge-service.mjs", "stop"],
    health: ["health-check.mjs"],
    "install-startup": ["launch-agent.mjs", "install"],
    "uninstall-startup": ["launch-agent.mjs", "uninstall"],
    "startup-status": ["launch-agent.mjs", "status"],
  };
  const target = scripts[action];
  if (!target) throw new Error(`Unsupported macOS service action: ${action}`);
  run(process.execPath, [path.join(scriptDirectory, target[0]), ...target.slice(1), ...extra]);
} else {
  throw new Error(`Unsupported operating system: ${process.platform}`);
}

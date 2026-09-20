import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDirectory, "..");
const packageName = "feishu-codex-bridge";
const files = [
  ".gitignore", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "README.md",
  "README-FIRST.md", "SECURITY.md", "SKILL.md", "THIRD_PARTY_NOTICES.md",
  "agents/openai.yaml", "assets/acceptance-fixture.png", "assets/acceptance-fixture.txt",
  "references/implementation-plan.md", "references/macos-deployment-guide.md",
  "references/new-computer-deployment-guide.md", "scripts/bootstrap-prerequisites.ps1",
  "scripts/bridge-core.mjs", "scripts/bridge-core.test.mjs", "scripts/bridge-process-identity.ps1",
  "scripts/bridge-service.mjs", "scripts/bridge.mjs", "scripts/build-portable-package.mjs",
  "scripts/build-portable-package.ps1", "scripts/codex-app-server.mjs",
  "scripts/codex-desktop-ipc.mjs", "scripts/codex-desktop-ipc.test.mjs",
  "scripts/config.example.json", "scripts/configure-fixed-controller-relay.mjs",
  "scripts/configure-fixed-controller-relay.test.mjs", "scripts/controller-thread-tool.mjs",
  "scripts/controller-thread-tool.test.mjs", "scripts/controller-thread-transport.mjs",
  "scripts/fixed-controller-relay.mjs", "scripts/fixed-controller-relay.test.mjs",
  "scripts/health-check.mjs", "scripts/health-check.ps1", "scripts/install-startup-task.ps1",
  "scripts/launch-agent.mjs", "scripts/macos-service.test.mjs", "scripts/package-lock.json",
  "scripts/package.json", "scripts/platform-service.mjs", "scripts/prepare-macos.mjs",
  "scripts/prepare-new-computer.ps1", "scripts/run-bridge-hidden.js", "scripts/start-bridge.ps1",
  "scripts/startup-scripts.test.mjs", "scripts/stop-bridge.ps1",
  "scripts/uninstall-startup-task.ps1", "scripts/upgrade-or-repair-existing-computer.ps1",
].sort();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed (${code}): ${stderr || stdout}`)));
  });
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function walk(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await walk(path.join(directory, entry.name), relative));
    else output.push(relative);
  }
  return output.sort();
}

async function main() {
  const outputDirectory = path.resolve(process.argv[2] || "");
  if (!process.argv[2] || outputDirectory === path.parse(outputDirectory).root || outputDirectory === sourceRoot || outputDirectory.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error("Usage: node build-portable-package.mjs <new-output-directory-outside-source>");
  }
  try { await stat(outputDirectory); throw new Error("Refusing to reuse an existing release directory"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const metadata = JSON.parse(await readFile(path.join(scriptDirectory, "package.json"), "utf8"));
  const actual = await walk(sourceRoot);
  if (JSON.stringify(actual) !== JSON.stringify(files)) throw new Error(`Release allowlist mismatch\nexpected=${files.join("\n")}\nactual=${actual.join("\n")}`);

  const work = await mkdtemp(path.join(tmpdir(), "feishu-codex-release-"));
  try {
    const staging = path.join(work, "staging");
    const packageRoot = path.join(staging, packageName);
    const verification = path.join(work, "verification");
    await mkdir(packageRoot, { recursive: true });
    for (const relative of files) {
      const destination = path.join(packageRoot, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(sourceRoot, relative), destination);
    }
    const forbidden = [/[\u5149\u54e5]/i, /[\u7c73\u7c92]/i, /codex:\/\/threads\/[0-9a-f-]{36}/i, /C:[\\/]Users[\\/]hanyo/i];
    for (const relative of files.filter((item) => /\.(md|mjs|ps1|json|ya?ml|txt)$/.test(item))) {
      const content = await readFile(path.join(packageRoot, relative), "utf8");
      if (forbidden.some((pattern) => pattern.test(content))) throw new Error(`External content scan rejected ${relative}`);
    }
    const archiveName = `${packageName}-v${metadata.version}-portable.zip`;
    const archive = path.join(work, archiveName);
    await run("/usr/bin/zip", ["-qry", archive, packageName], { cwd: staging });
    await mkdir(verification);
    await run("/usr/bin/unzip", ["-q", archive, "-d", verification]);
    const verifiedRoot = path.join(verification, packageName);
    if (JSON.stringify(await walk(verifiedRoot)) !== JSON.stringify(files)) throw new Error("Extracted package file list mismatch");
    await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: path.join(verifiedRoot, "scripts") });
    await run("npm", ["run", "check"], { cwd: path.join(verifiedRoot, "scripts") });
    await run("npm", ["test"], { cwd: path.join(verifiedRoot, "scripts") });
    const entries = await Promise.all(files.map(async (relative) => ({
      path: relative, bytes: (await stat(path.join(packageRoot, relative))).size,
      sha256: await sha256(path.join(packageRoot, relative)),
    })));
    await mkdir(outputDirectory, { recursive: true });
    const publishedArchive = path.join(outputDirectory, archiveName);
    await cp(archive, publishedArchive);
    const archiveHash = await sha256(publishedArchive);
    await writeFile(path.join(outputDirectory, `${archiveName}.sha256`), `${archiveHash}  ${archiveName}\n`, "ascii");
    for (const relative of ["README-FIRST.md", "references/new-computer-deployment-guide.md", "references/macos-deployment-guide.md"]) {
      await cp(path.join(sourceRoot, relative), path.join(outputDirectory, path.basename(relative)));
    }
    const manifest = {
      package: packageName, version: metadata.version,
      audience: "external-windows-macos-fixed-controller-distribution",
      built_utc: new Date().toISOString(),
      archive: { file: archiveName, bytes: (await stat(publishedArchive)).size, sha256: archiveHash },
      smoke_test: { extracted_file_count: files.length, npm_ci: "passed", syntax_check: "passed", automated_tests: "passed", external_content_scan: "passed", private_runtime_required: false },
      entries,
    };
    const manifestPath = path.join(outputDirectory, `${packageName}-v${metadata.version}-manifest.json`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, version: metadata.version, entries: files.length, archive: publishedArchive, sha256: archiveHash, manifest: manifestPath }, null, 2));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });

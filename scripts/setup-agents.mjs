#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "buzzassist";
const marketplaceName = "buzzassist-local";
const personalMarketplaceName = "personal";
const homeDir = homedir();
const managedPluginDir = join(homeDir, "plugins", pluginName);
const personalMarketplacePath = join(homeDir, ".agents", "plugins", "marketplace.json");
const claudeInstalledPluginsPath = join(homeDir, ".claude", "plugins", "installed_plugins.json");
const claudeSettingsPath = join(homeDir, ".claude", "settings.json");
const argv = process.argv.slice(2);

function usage() {
  return `Usage: node scripts/setup-agents.mjs [options]

Options:
  --project-dir <path>   Project whose canvas/ directory should store state.
  --canvas-dir <path>    Override canvas data directory.
  --dry-run              Print commands without changing host config.
  --skip-install         Do not run npm install.
  --skip-build           Do not run npm run build.
  --skip-plugin-source   Do not refresh ~/plugins/buzzassist.
  --no-launch            Do not start the canvas service.
  --help                 Show this message.
`;
}

function readArg(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function hasArg(name) {
  return argv.includes(name);
}

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

const dryRun = hasArg("--dry-run");
const skipInstall = hasArg("--skip-install");
const skipBuild = hasArg("--skip-build");
const skipPluginSource = hasArg("--skip-plugin-source");
const launchCanvas = !hasArg("--no-launch");
const projectDir = resolve(
  readArg("--project-dir", process.env.BUZZASSIST_PROJECT_DIR || process.env.EXCALIDRAW_PROJECT_DIR || process.cwd()),
);
const canvasDir = resolve(readArg("--canvas-dir", process.env.EXCALIDRAW_CANVAS_DIR || join(projectDir, "canvas")));

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function logStep(message) {
  console.log(`\n==> ${message}`);
}

function logCommand(command, args) {
  console.log(`$ ${formatCommand(command, args)}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    inherit = false,
    allowFailure = false,
  } = options;

  if (dryRun) {
    logCommand(command, args);
    return { ok: true, code: 0, stdout: "", stderr: "" };
  }

  logCommand(command, args);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === "win32",
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    if (!inherit) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      const result = { ok: false, code: null, stdout, stderr, error };
      if (allowFailure) resolveRun(result);
      else rejectRun(error);
    });

    child.on("close", (code) => {
      const ok = code === 0;
      if (!inherit && stdout.trim()) console.log(stdout.trim());
      if (!inherit && stderr.trim()) console.error(stderr.trim());
      const result = { ok, code, stdout, stderr };
      if (ok || allowFailure) resolveRun(result);
      else rejectRun(new Error(`${formatCommand(command, args)} exited with ${code}`));
    });
  });
}

async function commandAvailable(command) {
  if (dryRun) return true;
  const result = await run(command, ["--version"], { allowFailure: true });
  return result.ok || result.code !== null;
}

function includesConfiguredMarketplace(output) {
  return output.includes(marketplaceName) || output.includes(repoRoot);
}

async function ensureDependencies() {
  if (skipInstall) {
    console.log("Skipping npm install.");
    return;
  }

  const dependencyMarker = join(repoRoot, "node_modules", "@excalidraw", "excalidraw", "package.json");
  if (await pathExists(dependencyMarker)) {
    console.log("npm dependencies are already present.");
    return;
  }

  logStep("Installing npm dependencies");
  await run(commandName("npm"), ["install"], { inherit: true });
}

async function ensureBuild() {
  if (skipBuild) {
    console.log("Skipping npm run build.");
    return;
  }

  if (await pathExists(join(repoRoot, "dist", "index.html"))) {
    console.log("Canvas build already exists.");
    return;
  }

  logStep("Building the static canvas UI");
  await run(commandName("npm"), ["run", "build"], { inherit: true });
}

async function copyIfExists(source, target) {
  if (!(await pathExists(source))) return;
  await cp(source, target, { recursive: true, force: true, dereference: false });
}

async function refreshManagedPluginSource() {
  if (skipPluginSource) {
    console.log(`Skipping managed plugin source refresh: ${managedPluginDir}`);
    return managedPluginDir;
  }

  logStep("Refreshing local plugin source");
  if (dryRun) {
    console.log(`Would refresh ${managedPluginDir} from ${repoRoot}`);
    return managedPluginDir;
  }

  const tmpDir = `${managedPluginDir}.tmp-${process.pid}`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  for (const dirName of ["assets", "dist", "lib", "mcp", "scripts", "skills", ".codex-plugin", ".claude-plugin"]) {
    await copyIfExists(join(repoRoot, dirName), join(tmpDir, dirName));
  }

  for (const fileName of [
    ".mcp.json",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "SETUP.md",
    "package.json",
    "package-lock.json",
    "vite.config.js",
  ]) {
    await copyIfExists(join(repoRoot, fileName), join(tmpDir, fileName));
  }

  await rm(join(tmpDir, "node_modules"), { recursive: true, force: true });
  await rm(join(tmpDir, "canvas"), { recursive: true, force: true });
  await rm(managedPluginDir, { recursive: true, force: true });
  await mkdir(dirname(managedPluginDir), { recursive: true });
  await rename(tmpDir, managedPluginDir);
  return managedPluginDir;
}

async function ensureCodexPersonalMarketplace(pluginDir) {
  logStep("Updating Codex personal marketplace");
  const entry = {
    name: pluginName,
    source: {
      source: "local",
      path: `./plugins/${pluginName}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };

  if (dryRun) {
    console.log(`Would write ${personalMarketplacePath}`);
    console.log(`Would point ${pluginName} to ${pluginDir}`);
    return;
  }

  const marketplace = await readJson(personalMarketplacePath, {
    name: personalMarketplaceName,
    interface: { displayName: "Personal" },
    plugins: [],
  });
  marketplace.name ||= personalMarketplaceName;
  marketplace.interface ||= { displayName: "Personal" };
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];

  const index = marketplace.plugins.findIndex((plugin) => plugin?.name === pluginName);
  if (index >= 0) marketplace.plugins[index] = entry;
  else marketplace.plugins.push(entry);

  await writeJson(personalMarketplacePath, marketplace);
}

async function setupCodex(pluginDir) {
  logStep("Configuring Codex");
  const codex = commandName("codex");
  if (!(await commandAvailable(codex))) {
    console.warn("Codex CLI was not found. Run these commands after installing Codex:");
    console.warn(`  ${formatCommand("codex", ["plugin", "add", `${pluginName}@${personalMarketplaceName}`])}`);
    return { ok: false, skipped: true };
  }

  await ensureCodexPersonalMarketplace(pluginDir);

  const installed = await run(codex, ["plugin", "add", `${pluginName}@${personalMarketplaceName}`], { allowFailure: true });
  if (!installed.ok) {
    console.warn("Codex plugin install did not complete. Check the Codex CLI output above.");
  }
  return { ok: installed.ok };
}

async function setupClaude(pluginDir) {
  logStep("Configuring Claude Code");
  const claude = commandName("claude");
  if (!(await commandAvailable(claude))) {
    console.warn("Claude Code CLI was not found. Run these commands after installing Claude Code:");
    console.warn(`  ${formatCommand("claude", ["plugin", "marketplace", "add", pluginDir, "--scope", "user"])}`);
    console.warn(`  ${formatCommand("claude", ["plugin", "install", `${pluginName}@${marketplaceName}`, "--scope", "user"])}`);
    return { ok: false, skipped: true };
  }

  const added = await run(claude, ["plugin", "marketplace", "add", pluginDir, "--scope", "user"], { allowFailure: true });
  if (!added.ok) {
    console.warn("Claude Code marketplace add did not complete. Continuing to plugin install in case it is already configured.");
  }

  await installClaudePluginDirect(pluginDir);
  return { ok: true };
}

async function installClaudePluginDirect(pluginDir) {
  logStep("Installing Claude Code plugin non-interactively");
  const selector = `${pluginName}@${marketplaceName}`;
  const version = JSON.parse(await readFile(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")).version || "0.1.0";
  const installPath = join(homeDir, ".claude", "plugins", "cache", marketplaceName, pluginName, version);

  if (dryRun) {
    console.log(`Would copy ${pluginDir} to ${installPath}`);
    console.log(`Would update ${claudeInstalledPluginsPath}`);
    console.log(`Would enable ${selector} in ${claudeSettingsPath}`);
    return;
  }

  await rm(installPath, { recursive: true, force: true });
  await mkdir(dirname(installPath), { recursive: true });
  await cp(pluginDir, installPath, { recursive: true, force: true, dereference: false });

  const now = new Date().toISOString();
  const installed = await readJson(claudeInstalledPluginsPath, { version: 2, plugins: {} });
  installed.version = 2;
  installed.plugins ||= {};
  const existing = Array.isArray(installed.plugins[selector]) ? installed.plugins[selector].find((entry) => entry?.scope === "user") : null;
  installed.plugins[selector] = [
    {
      scope: "user",
      installPath,
      version,
      installedAt: existing?.installedAt || now,
      lastUpdated: now,
    },
  ];
  await writeJson(claudeInstalledPluginsPath, installed);

  const settings = await readJson(claudeSettingsPath, {});
  settings.enabledPlugins ||= {};
  settings.enabledPlugins[selector] = true;
  await writeJson(claudeSettingsPath, settings);
}

async function readDiscovery() {
  try {
    return JSON.parse(await readFile(join(canvasDir, ".server.json"), "utf8"));
  } catch {
    return null;
  }
}

async function isReachable(url) {
  if (!url || dryRun) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function launchCanvasServer() {
  logStep("Starting the BuzzAssist canvas");
  await mkdir(canvasDir, { recursive: true });

  const existing = await readDiscovery();
  if (existing?.url && (await isReachable(existing.url))) {
    console.log(`Using existing canvas server: ${existing.url}`);
    return existing;
  }

  const command = process.execPath;
  const args = [join(repoRoot, "scripts", "serve-canvas.mjs"), projectDir];
  if (dryRun) {
    logCommand(command, args);
    return {
      url: "http://127.0.0.1:43219/",
      mcpUrl: "http://127.0.0.1:43219/mcp",
      canvasDir,
      projectDir,
      dryRun: true,
    };
  }

  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      EXCALIDRAW_PROJECT_DIR: projectDir,
      EXCALIDRAW_CANVAS_DIR: canvasDir,
    },
  });
  child.unref();

  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(1000);
    const discovery = await readDiscovery();
    if (discovery?.url && (await isReachable(discovery.url))) {
      console.log(`Started canvas server: ${discovery.url}`);
      return discovery;
    }
  }

  throw new Error(`Canvas server did not become reachable. Check ${join(canvasDir, ".server.json")} or run node scripts/serve-canvas.mjs ${shellQuote(projectDir)} manually.`);
}

async function main() {
  console.log("BuzzAssist setup");
  console.log(`Repository: ${repoRoot}`);
  console.log(`Project dir: ${projectDir}`);
  console.log(`Canvas dir: ${canvasDir}`);
  console.log(`Plugin source: ${managedPluginDir}`);

  await ensureDependencies();
  await ensureBuild();
  const pluginDir = await refreshManagedPluginSource();

  const codex = await setupCodex(pluginDir);
  const claude = await setupClaude(pluginDir);
  const discovery = launchCanvas ? await launchCanvasServer() : null;

  logStep("Setup summary");
  console.log(`Codex: ${codex.ok ? "configured" : codex.skipped ? "skipped" : "needs attention"}`);
  console.log(`Claude Code: ${claude.ok ? "configured" : claude.skipped ? "skipped" : "needs attention"}`);
  if (discovery?.url) {
    console.log(`BUZZASSIST_CANVAS_URL=${discovery.url}`);
    console.log("Open BUZZASSIST_CANVAS_URL in the current host's in-app browser now.");
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});

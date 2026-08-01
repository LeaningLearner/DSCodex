#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildCatalog, syncCatalog } from "./catalog.mjs";
import { install, uninstall } from "./config.mjs";
import { deleteStoredKey, readStoredKey, writeStoredKey } from "./keys.mjs";
import { createProxyServer } from "./proxy.mjs";
import { DEFAULT_PORT, HOST, VERSION, pathsFor, resolveCodexHome } from "./constants.mjs";

const APP_SERVER_WRAPPER = fileURLToPath(new URL("./codex-wrapper.mjs", import.meta.url));

function launchctlGet(name) {
  if (process.platform !== "darwin") return process.env[name]?.trim() ?? "";
  try {
    return execFileSync("/bin/launchctl", ["getenv", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function stockCodexPath() {
  const candidates = [
    launchctlGet("DSCODEX_REAL_CODEX"),
    process.env.DSCODEX_REAL_CODEX?.trim(),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ];
  try {
    candidates.push(execFileSync("/usr/bin/which", ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch {
    // The bundled ChatGPT path above is the normal macOS install.
  }
  return candidates.find((candidate) => candidate && candidate !== APP_SERVER_WRAPPER && existsSync(candidate)) ?? "";
}

function nodePath() {
  // Windows has no versioned-Cellar problem; the running interpreter is stable.
  if (process.platform === "win32") return process.execPath;
  // Prefer the PATH-resolved `node` (a stable Homebrew symlink); process.execPath
  // resolves to the versioned Cellar binary, which disappears on the next upgrade.
  try {
    const resolved = execFileSync("/usr/bin/which", ["node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (resolved && existsSync(resolved)) return resolved;
  } catch {
    // Fall back to the current interpreter below.
  }
  return process.execPath;
}

function writeBridgeShim(path) {
  // GUI apps get a bare launchd PATH (/usr/bin:/bin:...), so a `#!/usr/bin/env node`
  // shebang fails there. Point CODEX_CLI_PATH at a shim with absolute paths instead.
  const content = `#!/bin/sh\nexec ${JSON.stringify(nodePath())} ${JSON.stringify(APP_SERVER_WRAPPER)} "$@"\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o755 });
}

function bridgePlan(paths) {
  if (process.platform !== "darwin") return null;
  const existing = launchctlGet("CODEX_CLI_PATH");
  if (existing && existing !== paths.bridgeShim && existing !== APP_SERVER_WRAPPER) {
    throw new Error(`Refusing to replace user-owned CODEX_CLI_PATH: ${existing}`);
  }
  const realCodex = stockCodexPath();
  if (!realCodex) throw new Error("Could not locate the stock Codex binary for the app-server bridge");
  return { realCodex, shim: paths.bridgeShim };
}

function activateBridge(plan) {
  if (!plan) return;
  writeBridgeShim(plan.shim);
  execFileSync("/bin/launchctl", ["setenv", "DSCODEX_REAL_CODEX", plan.realCodex]);
  execFileSync("/bin/launchctl", ["setenv", "CODEX_CLI_PATH", plan.shim]);
}

function deactivateBridge(paths) {
  if (process.platform !== "darwin") return;
  const current = launchctlGet("CODEX_CLI_PATH");
  if (current !== paths.bridgeShim && current !== APP_SERVER_WRAPPER) return;
  execFileSync("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
  execFileSync("/bin/launchctl", ["unsetenv", "DSCODEX_REAL_CODEX"]);
}

function parsePort(args, env = process.env) {
  const index = args.indexOf("--port");
  const raw = index === -1 ? env.DSCODEX_PORT : args[index + 1];
  const port = raw ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${raw}`);
  return port;
}

function runtime(env = process.env) {
  const codexHome = resolveCodexHome(env);
  return { codexHome, paths: pathsFor(codexHome) };
}

function launchctlKey() {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("/bin/launchctl", ["getenv", "DEEPSEEK_API_KEY"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// Resolution order: one-off env override, then the durable stored key, then the
// legacy macOS login-session value so installs created before `key set` keep working.
function resolveDeepSeekKey(env = process.env, keyFile = "") {
  if (env.DEEPSEEK_API_KEY?.trim()) return env.DEEPSEEK_API_KEY.trim();
  const stored = keyFile ? readStoredKey(keyFile) : "";
  if (stored) return stored;
  return launchctlKey();
}

function keySource(keyFile, env = process.env) {
  if (env.DEEPSEEK_API_KEY?.trim()) return "environment";
  if (readStoredKey(keyFile)) return `stored in ${keyFile}`;
  if (launchctlKey()) return "macOS launchctl login session";
  return "";
}

function promptSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error("Interactive prompt unavailable; pass DEEPSEEK_API_KEY via the environment"));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (chunk) => {
      process.stdout.write(chunk.includes(prompt) ? chunk : "*");
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function health(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(700) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function syncIfPossible(paths) {
  if (existsSync(paths.cache) && existsSync(paths.catalog)) {
    syncCatalog({ cachePath: paths.cache, catalogPath: paths.catalog });
  }
}

function loadModels(paths) {
  if (existsSync(paths.catalog)) return JSON.parse(readFileSync(paths.catalog, "utf8")).models ?? [];
  if (existsSync(paths.cache)) return buildCatalog(JSON.parse(readFileSync(paths.cache, "utf8"))).models;
  return [];
}

async function serve(port) {
  process.title = "dscodex";
  const { paths } = runtime();
  syncIfPossible(paths);
  const deepSeekKey = resolveDeepSeekKey(process.env, paths.keyFile);
  const server = createProxyServer({ deepSeekKey, models: loadModels(paths) });
  server.listen(port, HOST, () => {
    console.log(`DSCodex ${VERSION} listening at http://${HOST}:${port}/v1`);
    console.log(`DeepSeek key: ${deepSeekKey ? "configured" : "missing (GPT OAuth passthrough still works)"}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function start(port) {
  const running = await health(port);
  if (running) {
    console.log(`DSCodex is already running on ${HOST}:${port}`);
    return;
  }
  const { paths } = runtime();
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  syncIfPossible(paths);
  const deepSeekKey = resolveDeepSeekKey(process.env, paths.keyFile);
  const logFd = openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--port", String(port)], {
    detached: true,
    windowsHide: true,
    env: { ...process.env, ...(deepSeekKey ? { DEEPSEEK_API_KEY: deepSeekKey } : {}) },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(paths.pid, `${JSON.stringify({ pid: child.pid, port })}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ready = await health(port);
    if (ready) {
      console.log(`DSCodex started on ${HOST}:${port} (pid ${child.pid})`);
      console.log(`DeepSeek key: ${ready.deepseek_key ? "configured" : "missing"}`);
      return;
    }
  }
  throw new Error(`DSCodex did not become ready; inspect ${paths.log}`);
}

async function stop() {
  const { paths } = runtime();
  if (!existsSync(paths.pid)) {
    console.log("DSCodex is not running (no pid file)");
    return;
  }
  const state = JSON.parse(readFileSync(paths.pid, "utf8"));
  try {
    process.kill(state.pid, "SIGTERM");
    console.log(`Stopped DSCodex pid ${state.pid}`);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    console.log("Removed stale DSCodex pid file");
  }
  unlinkSync(paths.pid);
}

async function status(port) {
  const ready = await health(port);
  if (!ready) {
    console.log(`stopped (${HOST}:${port})`);
    process.exitCode = 1;
    return;
  }
  console.log(`running (${HOST}:${port}); DeepSeek key ${ready.deepseek_key ? "configured" : "missing"}`);
}

async function manageKey(subcommand, paths, port) {
  if (subcommand === "set") {
    const key = process.env.DEEPSEEK_API_KEY?.trim() || launchctlKey() || await promptSecret("DeepSeek API Key: ");
    writeStoredKey(paths.keyFile, key);
    console.log(`Stored DeepSeek API key in ${paths.keyFile} (mode 0600)`);
    if (await health(port)) console.log("Restart the router (stop && start) so the running server picks up the new key");
    return;
  }
  if (subcommand === "delete") {
    deleteStoredKey(paths.keyFile);
    console.log(`Removed ${paths.keyFile}`);
    if (await health(port)) console.log("Restart the router (stop && start) to drop the in-memory key");
    return;
  }
  if (subcommand === "status") {
    const source = keySource(paths.keyFile);
    console.log(source ? `DeepSeek key: configured (${source})` : "DeepSeek key: missing");
    return;
  }
  throw new Error(`Unknown key subcommand: ${subcommand}`);
}

async function doctor(port) {
  const { paths } = runtime();
  const config = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  const ready = await health(port);
  const checks = {
    config_injected: config.includes("# DSCodex managed"),
    catalog_present: existsSync(paths.catalog),
    proxy_running: Boolean(ready),
    deepseek_key_in_proxy: Boolean(ready?.deepseek_key),
    // The app-server bridge is macOS-only: Windows GUI apps cannot spawn a script
    // shim (CreateProcess requires an .exe), so the check is skipped elsewhere.
    app_server_bridge: process.platform !== "darwin" || (
      launchctlGet("CODEX_CLI_PATH") === paths.bridgeShim && Boolean(launchctlGet("DSCODEX_REAL_CODEX"))
    ),
  };
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok" : "missing"}  ${name}`);
  if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
}

function usage() {
  console.log(`DSCodex ${VERSION}

Usage: dscodex <command> [--port ${DEFAULT_PORT}]

  install     merge 🐳 V4 Flash into the Codex model catalog
  sync        refresh native GPT entries in the merged catalog
  key set     store the DeepSeek API key (hidden prompt, or DEEPSEEK_API_KEY env)
  key status  show where the DeepSeek key comes from
  key delete  remove the stored DeepSeek key
  start       run the loopback router in the background
  serve       run the loopback router in the foreground
  status      show router state
  doctor      verify catalog, routing, key, and app-server bridge state
  stop        stop the background router
  uninstall   remove only DSCodex-owned Codex configuration

Key sources, in order: DEEPSEEK_API_KEY env, ~/.codex/dscodex/config.json${
  process.platform === "darwin" ? ", then the macOS launchctl login session" : ""
}. The stored key survives reboots.`);
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const port = parsePort(args);
  const { paths } = runtime();
  switch (command) {
    case "install": {
      const plan = bridgePlan(paths);
      const result = install({ paths, port });
      activateBridge(plan);
      console.log(`Installed ${result.catalog.models[0].display_name} with default Max reasoning`);
      console.log("Installed provider-specific effort and speed memory for the ChatGPT app");
      console.log(`Fully quit and restart Codex after starting DSCodex on ${HOST}:${port}`);
      break;
    }
    case "sync": {
      const catalog = syncCatalog({ cachePath: paths.cache, catalogPath: paths.catalog });
      console.log(`Synced ${catalog.models.length} catalog entries`);
      break;
    }
    case "key": await manageKey(args[0] ?? "status", paths, port); break;
    case "start": await start(port); break;
    case "serve": await serve(port); break;
    case "status": await status(port); break;
    case "doctor": await doctor(port); break;
    case "stop": await stop(); break;
    case "uninstall":
      await stop();
      uninstall({ paths });
      deactivateBridge(paths);
      console.log("Removed DSCodex-owned config, catalog, selection state, and app-server bridge");
      break;
    case "--version":
    case "version": console.log(VERSION); break;
    case "help":
    case "--help":
    case "-h": usage(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`dscodex: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

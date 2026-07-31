#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { createAppServerState } from "./app-server-state.mjs";

const self = resolve(process.argv[1]);
const realCodex = process.env.DSCODEX_REAL_CODEX?.trim();
if (!realCodex || !existsSync(realCodex) || resolve(realCodex) === self) {
  console.error("dscodex: DSCODEX_REAL_CODEX does not point to the stock Codex binary");
  process.exit(1);
}

const args = process.argv.slice(2);
const env = { ...process.env };
delete env.CODEX_CLI_PATH;
const child = spawn(realCodex, args, { env, stdio: ["pipe", "pipe", "inherit"] });
const appServer = args.includes("app-server");

if (!appServer) {
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
} else {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const state = createAppServerState({
    configPath: join(codexHome, "config.toml"),
    statePath: join(codexHome, "dscodex", "model-selections.json"),
  });
  const clientLines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const serverLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  clientLines.on("line", (line) => {
    try {
      child.stdin.write(`${JSON.stringify(state.rewriteClient(JSON.parse(line)))}\n`);
    } catch {
      child.stdin.write(`${line}\n`);
    }
  });
  clientLines.on("close", () => child.stdin.end());
  serverLines.on("line", (line) => {
    try {
      process.stdout.write(`${JSON.stringify(state.rewriteServer(JSON.parse(line)))}\n`);
    } catch {
      process.stdout.write(`${line}\n`);
    }
  });
}

const forwardedSignals = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => child.kill(signal);
  forwardedSignals.set(signal, handler);
  process.once(signal, handler);
}
child.once("error", (error) => {
  console.error(`dscodex: failed to start stock Codex: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.removeListener(signal, forwardedSignals.get(signal));
    process.kill(process.pid, signal);
  }
  else process.exit(code ?? 1);
});

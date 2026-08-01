import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsVbs,
} from "../src/autostart.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("launchd plist embeds absolute paths and restarts only on failure", () => {
  const plist = buildLaunchdPlist({
    nodePath: "/opt/homebrew/bin/node",
    cliPath: "/x y/DSCodex/src/cli.mjs",
    port: 10110,
    logPath: "/u/.codex/dscodex/server.log",
  });
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.dscodex\.router<\/string>/);
  assert.ok(plist.includes("<string>/opt/homebrew/bin/node</string>"));
  assert.ok(plist.includes("<string>/x y/DSCodex/src/cli.mjs</string>"));
  assert.ok(plist.includes("<string>10110</string>"));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.ok(plist.includes("<string>/u/.codex/dscodex/server.log</string>"));
});

test("launchd plist XML-escapes paths", () => {
  const plist = buildLaunchdPlist({
    nodePath: "/weird/&<node>",
    cliPath: "/x/cli.mjs",
    port: 1,
    logPath: "/l",
  });
  assert.ok(plist.includes("/weird/&amp;&lt;node&gt;"));
  assert.ok(!plist.includes("/weird/&<node>"));
});

test("systemd unit quotes paths and restarts on failure only", () => {
  const unit = buildSystemdUnit({
    nodePath: "/usr/bin/node",
    cliPath: "/x y/DSCodex/src/cli.mjs",
    port: 10110,
    logPath: "/u/.codex/dscodex/server.log",
  });
  assert.ok(unit.includes('ExecStart="/usr/bin/node" "/x y/DSCodex/src/cli.mjs" serve --port 10110'));
  assert.ok(unit.includes("Restart=on-failure"));
  assert.ok(unit.includes("WantedBy=default.target"));
  assert.ok(unit.includes("StandardOutput=append:/u/.codex/dscodex/server.log"));
});

test("windows vbs hides the console and appends to the router log", () => {
  const vbs = buildWindowsVbs({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\x\\src\\cli.mjs",
    port: 10110,
    logPath: "C:\\u\\server.log",
  });
  assert.ok(vbs.startsWith('CreateObject("Wscript.Shell").Run "'));
  assert.ok(vbs.includes('""C:\\Program Files\\nodejs\\node.exe""'));
  assert.ok(vbs.includes("serve --port 10110"));
  assert.ok(vbs.includes('>> ""C:\\u\\server.log"" 2>&1'));
  assert.ok(vbs.trimEnd().endsWith(", 0, False"));
});

test("serve owns its pid file across start and graceful shutdown", { timeout: 20_000 }, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "dscodex-serve-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const pidFile = join(codexHome, "dscodex", "server.pid");
  try {
    let attempts = 0;
    while (!existsSync(pidFile) && attempts < 50) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(existsSync(pidFile), `pid file never appeared${stderr ? `: ${stderr.trim()}` : ""}`);
    assert.equal(JSON.parse(readFileSync(pidFile, "utf8")).pid, child.pid);

    child.kill("SIGTERM");
    const [code] = await new Promise((resolve) => child.once("exit", (exitCode, signal) => resolve([exitCode, signal])));
    if (process.platform !== "win32") {
      // Windows terminates the process outright, so there is no graceful exit there.
      assert.equal(code, 0);
      assert.equal(existsSync(pidFile), false);
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(codexHome, { recursive: true, force: true });
  }
});

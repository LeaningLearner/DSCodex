import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCHD_LABEL = "com.dscodex.router";
export const SYSTEMD_UNIT = "dscodex.service";
export const WINDOWS_TASK = "DSCodex";

export function autostartKind(platform = process.platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "schtasks";
  return "systemd";
}

export function launchdPlistPath(home = homedir()) {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(home = homedir()) {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// KeepAlive.SuccessfulExit=false: crashes are relaunched, but a graceful SIGTERM
// (`dscodex stop` exits 0) stays down — a manual stop must never be resurrected.
export function buildLaunchdPlist({ nodePath, cliPath, port, logPath }) {
  const args = [nodePath, cliPath, "serve", "--port", String(port)]
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Restart=on-failure mirrors the launchd semantics above: the router exits 0 on
// SIGTERM, so only crashes are restarted.
export function buildSystemdUnit({ nodePath, cliPath, port, logPath }) {
  return `[Unit]
Description=DSCodex loopback router (DeepSeek V4 Flash for Codex)

[Service]
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} serve --port ${port}
Restart=on-failure
RestartSec=2
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

// The task runs wscript.exe on this one-liner so no console window flashes at
// logon; cmd routes stdout/stderr into the regular server.log.
export function buildWindowsVbs({ nodePath, cliPath, port, logPath }) {
  const cmd = `cmd /c ""${nodePath}" "${cliPath}" serve --port ${port} >> "${logPath}" 2>&1"`;
  return `CreateObject("Wscript.Shell").Run "${cmd.replaceAll('"', '""')}", 0, False\r\n`;
}

# DSCodex

<div align="center">

<img src="assets/dscodex-banner.png" alt="DSCodex — DeepSeek V4 Flash for Codex" />

<p>
  <a href="https://github.com/fish2lab/DSCodex/releases/latest"><img src="https://img.shields.io/github/v/release/fish2lab/DSCodex?style=flat-square&color=4D6BFE" alt="Latest release" /></a>
  <a href="https://github.com/fish2lab/DSCodex/stargazers"><img src="https://img.shields.io/github/stars/fish2lab/DSCodex?style=flat-square&color=F5A623" alt="GitHub stars" /></a>
  <a href="https://developers.openai.com/codex/"><img src="https://img.shields.io/badge/Codex-App_%C2%B7_CLI_%C2%B7_IDE-412991?style=flat-square&logo=openai&logoColor=white" alt="Codex App, CLI and IDE" /></a>
  <a href="https://api-docs.deepseek.com/zh-cn/guides/responses_api/"><img src="https://img.shields.io/badge/DeepSeek-V4_Flash-4D6BFE?style=flat-square" alt="DeepSeek V4 Flash" /></a>
  <br />
  <a href="https://api-docs.deepseek.com/zh-cn/guides/responses_api/"><img src="https://img.shields.io/badge/Responses_API-native-00A98F?style=flat-square" alt="Native Responses API" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524.5-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 24.5 or newer" /></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/macOS_%7C_Linux-supported-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS and Linux supported" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F1C40F?style=flat-square" alt="MIT license" /></a>
</p>

<p><strong>DeepSeek V4 Flash for the stock ChatGPT desktop app, Codex CLI and IDE — native Responses API, full agentic tool loops, no fork.</strong></p>

</div>

[简体中文](README.md) · English

## What it solves

DSCodex is a ~40 KB, zero-dependency Node loopback router that puts DeepSeek V4 Flash into the
stock ChatGPT desktop app / Codex native model picker — no app patching, no fork, and GPT models
keep running on your OAuth subscription. It adds one entry (shared by the desktop app, CLI, and
IDE extension):

```text
🐳 V4 Flash   ·   default Max   ·   options High / Max
```

- **No DeepSeek in the stock environment.** Every request goes through the single global
  `openai_base_url` — pointing it at DeepSeek breaks the GPT models, and Chat Completions-style
  adapters lose the tool loop. DSCodex splits traffic by model name: V4 Flash goes to DeepSeek's
  **native Responses API** (SSE), everything else is forwarded unchanged to the ChatGPT backend.
  Shell, `apply_patch`, function calls, and web search keep working.
- **Effort/speed gets clobbered on model switch.** The desktop app writes the current effort into
  global config, so OpenAI High and DeepSeek Max overwrite each other. DSCodex keeps an
  independent slot per provider — switching back to GPT restores its previous effort and speed,
  and tracked threads, threads resumed after a restart, and brand-new sessions all behave alike.
- **V4 Flash is text-only and cannot see images.** Its catalog entry declares the image modality,
  so pasted images and `view_image` results ride along in requests; the router hands those images
  to GPT in parallel (borrowing your OAuth, no extra key) and injects the resulting text
  descriptions into the DeepSeek context. Identical images are described once (sha256 cache).

## How it works

```text
Codex App / CLI / IDE
        │  HTTP/SSE (zstd-compressed Requests, OAuth headers)
        ▼
http://127.0.0.1:10110/<router-token>/v1   ← authenticated DSCodex loopback router
        │
        ├── model == "deepseek/deepseek-v4-flash"
        │        ▼   (images in the request are described by GPT
        │              via chatgpt.com first, then injected as text)
        │   https://api.deepseek.com/responses   (native DeepSeek SSE)
        │
        └── any other model (gpt-5.6-*, codex-auto-review, …)
                 ▼
        https://chatgpt.com/backend-api/codex    (unmodified OAuth traffic)
```

`openai_base_url` points at the router and `model_catalog_json` merges V4 Flash into the catalog;
the router rewrites only that model's provider fields and forwards everything else unchanged. Model
switching works through the catalog out of the box. The desktop app additionally offers an
**opt-in** transparent bridge (`node src/cli.mjs bridge enable`, mounted via `CODEX_CLI_PATH`),
which rewrites only model-selection JSONL RPC before handing it to the stock bundled Codex binary;
the per-provider effort/speed slots live in that bridge (`~/.codex/dscodex/model-selections.json`).
The bridge is off by default: a global `CODEX_CLI_PATH` moves the app off its local daemon
websocket (which supports reconnect) onto stdio, breaking Computer Use.

## Requirements

- macOS, Linux, or Windows (native, no WSL), Node.js 24.5+ (Node 26 recommended: built-in zstd; proxy mode relies on `--use-env-proxy`)
- A signed-in ChatGPT desktop app or Codex CLI (for the GPT OAuth models)
- A DeepSeek API key (`sk-…`)
- Port `10110` free (change with `--port` or `DSCODEX_PORT`)

## Install

### By a coding agent (recommended)

The repo is designed for a clean-clone agent install. Give the agent this README (or clone the
repo and let it read `AGENTS.md`):

1. Get the DeepSeek API key from the user **without printing it or committing it**; store it with
   `DEEPSEEK_API_KEY=sk-… node src/cli.mjs key set` (or the interactive hidden prompt). It lands in
   `~/.codex/dscodex/config.json` (mode 0600; DPAPI-encrypted on Windows) and survives logout/reboot.
2. `node src/cli.mjs install` — writes two marker-owned root keys and merges `🐳 V4 Flash` into
   the catalog; refuses to overwrite a user-owned `openai_base_url`.
3. `node src/cli.mjs start`, then `node src/cli.mjs doctor` — all six checks, including the
   app-server bridge, must be `ok`.
4. `npm test` — all tests pass.
5. Have the user fully quit (`⌘Q`) and relaunch the ChatGPT app, start a **new** task, and pick
   `🐳 V4 Flash`.
6. Verify a real tool loop:
   `codex -m deepseek/deepseek-v4-flash -c 'model_reasoning_effort="max"' -a never exec
   --skip-git-repo-check 'call a shell tool once …'` — the model must call a tool, read its
   output, and finish.

### Manually

```bash
cd /path/to/DSCodex
node src/cli.mjs key set   # hidden prompt; stored in ~/.codex/dscodex/config.json (0600)
node src/cli.mjs proxy set http://127.0.0.1:10808   # optional: needed when chatgpt.com requires a proxy
node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor
node src/cli.mjs autostart enable   # optional: start the router at login (launchd / systemd / Task Scheduler)
```

Then quit and relaunch the ChatGPT desktop app, start a new task, and choose `🐳 V4 Flash`.

On Windows (PowerShell) the commands are identical; to pass the key via environment use
`$env:DEEPSEEK_API_KEY="sk-…"; node src/cli.mjs key set`.

Commands: `install`, `sync`, `key set|status|delete`, `proxy set|status|clear`, `start`, `serve`,
`autostart enable|disable|status`, `status`, `doctor`, `stop`, `uninstall`.

CLI note: `-m deepseek/deepseek-v4-flash` without the override may show `High`; add
`-c 'model_reasoning_effort="max"'` when the CLI must use Max.

## Verified behavior

- Real DeepSeek tool loop and GPT OAuth passthrough verified end-to-end (`DSCODEX_TOOL_OK`,
  `DSCODEX_GPT_OAUTH_OK`).
- The bridge (opt-in) covers default-picker changes, live-task switches, Fast restoration, and persistence
  across app restarts; `model/list` shows `🐳 V4 Flash`, default `max`, supported `["high","max"]`,
  with native GPT entries preserved.

## Compatibility at a glance

| Surface or behavior | Status |
| --- | --- |
| Native model picker in the ChatGPT macOS app | Supported |
| Codex CLI / IDE extension | Supported |
| Native Windows (Codex CLI / IDE extension) | Supported; the app-server bridge is macOS-only, see below |
| Multi-round DeepSeek tool calling | Supported through the native Responses API |
| GPT / Codex OAuth models | Supported through unchanged passthrough |
| chatgpt.com web app | Not supported; DSCodex integrates with the local Codex runtime |

## Known behaviors and edge cases

- **Usage stats.** The Codex app's Profile usage statistics are read-only — DeepSeek usage cannot
  be added (verified).
- **GPT vision.** Describes borrow the request's ChatGPT OAuth headers; description quality depends
  on the GPT model (`gpt-5.6-sol` by default, override with `DSCODEX_VISION_MODEL`). Without OAuth
  headers (pure API-key setups) images pass through untouched; on a failed describe a clear
  placeholder is injected so DeepSeek can honestly say it cannot see the image. Descriptions are
  cached in router memory only; if the app-server re-encodes an image the data URL changes and the
  image is described again.
- **Proxy.** The router must reach chatgpt.com itself: Node's fetch ignores system/proxy
  environment variables by default, so DSCodex resolves a proxy on its own
  (`DSCODEX_HTTPS_PROXY` / `DSCODEX_HTTP_PROXY` → lowercase/uppercase standard proxy variables
  with Node's lowercase precedence → the value stored by `proxy set`) and re-execs itself with `--use-env-proxy` (Node
  >= 24.5). GPT passthrough and GPT vision share the same path. `NO_PROXY` always includes
  loopback addresses and `api.deepseek.com`, so DeepSeek remains direct; both uppercase and
  lowercase proxy variables are set consistently for child processes. Proxy URLs may contain
  credentials; they are redacted in CLI output and encrypted with DPAPI on Windows.
- **WebSocket warning.** The catalog declares `prefer_websockets = false`; the router answers
  probes with `426`, and Codex falls back to HTTP/SSE. `codex doctor` may still show a warning;
  requests succeed.
- **Voice, pets, plugins, skills, MCP.** All client-side; voice is driven by GPT-Live and never
  routes to DeepSeek.
- **API key storage.** The key is stored in `~/.codex/dscodex/config.json` (mode 0600, directory 0700);
  Windows uses per-user DPAPI encryption and POSIX systems use the owner-only file. It survives
  logout/reboot; legacy Windows plaintext keys migrate on the next install, start, or state write.
  If persistent storage is unacceptable, skip `key set` and export
  `DEEPSEEK_API_KEY` per session instead (or `launchctl setenv` on macOS). Resolution order at
  runtime: environment variable, then the stored file, then the macOS login session; `key delete`
  plus a router restart removes it completely.
- **Loopback boundary.** `install` generates a 256-bit router token and adds it to
  `openai_base_url`; `start` / `serve` reconcile the managed URL, port, and token, and `doctor`
  verifies the exact binding. Requests without the token receive 404. The token is also required
  for the authenticated shutdown handshake, and PID cleanup atomically claims the matching
  instance state, so `stop` neither removes a replacement instance's state nor signals an
  unverified PID. Request and decompressed-body limits protect the local process from accidental
  or hostile memory spikes.
- **Platform differences.** Routing, key storage, and catalog merging behave identically on every
  platform; the app-server bridge (picker-state memory for the desktop app) is macOS-only and
  opt-in (`bridge enable`). It stays off by default because it demotes the app's app-server
  connection from the local daemon websocket to stdio, which can break Computer Use; `bridge
  disable` reverts at any time and also strips the `CODEX_CLI_PATH` copies the app snapshotted into
  `[mcp_servers.*.env]`. The bridge shim resolves node from PATH at runtime and only falls back to
  the absolute path baked at install time; when `DSCODEX_REAL_CODEX` is lost (launchctl login
  variables do not survive reboots) the wrapper falls back to the app's bundled Codex binary
  instead of exiting with an error. Windows desktop apps spawn `CODEX_CLI_PATH` directly and
  CreateProcess cannot run a script shim (only an `.exe`), so the bridge is unavailable on Windows
  and the matching `doctor` check passes trivially. Windows uses the same `%USERPROFILE%\.codex` layout; the key file's 0600 mode is a
  no-op there and protection falls back to the account ACL. The router does not auto-start by
  default; `node src/cli.mjs autostart enable` registers it at login (macOS launchd / Linux
  systemd user service / Windows Task Scheduler). Crashes are relaunched automatically, while a
  manual `stop` exits gracefully (exit code 0) and is never resurrected; `autostart disable` and
  `uninstall` both remove the entry. Without autostart, rerun `node src/cli.mjs start` after a
  reboot (the key persists).

## Why reasoning folds during a task

DeepSeek's Responses stream ends **every tool round** with `response.reasoning_text.done`,
`response.output_item.done`, `response.completed`; Codex folds the reasoning block on those
signals, runs the tool, then opens a new request whose reasoning starts over. This is API
behavior, not a bug — DSCodex forwards SSE byte-for-byte, and suppressing `response.completed`
would stall the tool loop. A no-tool turn folds once at the end.

## Uninstall

```bash
node src/cli.mjs stop
node src/cli.mjs uninstall
```

Removes only DSCodex-owned config lines, the merged catalog, the slot state, and `CODEX_CLI_PATH`
(when DSCodex still owns it). The pre-install backup stays at
`~/.codex/config.toml.pre-dscodex.bak`; GUI-written config is left untouched.

## References

- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek Codex integration](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

## License

[MIT](LICENSE)

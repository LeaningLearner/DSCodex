# DSCodex

![DSCodex](assets/dscodex-banner.png)

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
  independent slot per provider — switching back to GPT restores its previous effort and speed.

## How it works

```text
Codex App / CLI / IDE
        │  HTTP/SSE (zstd-compressed Requests, OAuth headers)
        ▼
http://127.0.0.1:10110/v1   ← DSCodex loopback router
        │
        ├── model == "deepseek/deepseek-v4-flash"
        │        ▼
        │   https://api.deepseek.com/responses   (native DeepSeek SSE)
        │
        └── any other model (gpt-5.6-*, codex-auto-review, …)
                 ▼
        https://chatgpt.com/backend-api/codex    (unmodified OAuth traffic)
```

`openai_base_url` points at the router and `model_catalog_json` merges V4 Flash into the catalog;
the router rewrites only that model's provider fields and forwards everything else unchanged. The
desktop app starts a transparent bridge via `CODEX_CLI_PATH`, which rewrites only model-selection
JSONL RPC before handing it to the stock bundled Codex binary; the per-provider effort/speed slots
live in that bridge (`~/.codex/dscodex/model-selections.json`).

## Requirements

- macOS or Linux, Node.js 20+ (Node 26 recommended: built-in zstd)
- A signed-in ChatGPT desktop app or Codex CLI (for the GPT OAuth models)
- A DeepSeek API key (`sk-…`)
- Port `10110` free (change with `--port` or `DSCODEX_PORT`)

## Install

### By a coding agent (recommended)

The repo is designed for a clean-clone agent install. Give the agent this README (or clone the
repo and let it read `AGENTS.md`):

1. Get the DeepSeek API key from the user **without printing or persisting it**; on macOS store it
   in the login-session environment: `launchctl setenv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"`, then
   unset the shell variable.
2. `node src/cli.mjs install` — writes two marker-owned root keys and merges `🐳 V4 Flash` into
   the catalog; refuses to overwrite a user-owned `openai_base_url`.
3. `node src/cli.mjs start`, then `node src/cli.mjs doctor` — all five checks, including the
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
read -s "DEEPSEEK_API_KEY?DeepSeek API Key: "; echo
launchctl setenv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"   # macOS login session
unset DEEPSEEK_API_KEY
node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor
```

Then quit and relaunch the ChatGPT desktop app, start a new task, and choose `🐳 V4 Flash`.

Commands: `install`, `sync`, `start`, `serve`, `status`, `doctor`, `stop`, `uninstall`.

CLI note: `-m deepseek/deepseek-v4-flash` without the override may show `High`; add
`-c 'model_reasoning_effort="max"'` when the CLI must use Max.

## Verified behavior

- Real DeepSeek tool loop and GPT OAuth passthrough verified end-to-end (`DSCODEX_TOOL_OK`,
  `DSCODEX_GPT_OAUTH_OK`).
- The bridge covers default-picker changes, live-task switches, Fast restoration, and persistence
  across app restarts; `model/list` shows `🐳 V4 Flash`, default `max`, supported `["high","max"]`,
  with native GPT entries preserved.

## Known behaviors and edge cases

- **Usage stats.** The Codex app's Profile usage statistics are read-only — DeepSeek usage cannot
  be added (verified).
- **WebSocket warning.** The catalog declares `prefer_websockets = false`; the router answers
  probes with `426`, and Codex falls back to HTTP/SSE. `codex doctor` may still show a warning;
  requests succeed.
- **Voice, pets, plugins, skills, MCP.** All client-side; voice is driven by GPT-Live and never
  routes to DeepSeek.
- **API key persistence.** The key lives only in the server process and the macOS login-session
  environment; re-export it after logout/reboot.

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

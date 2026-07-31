# DSCodex install instructions for coding agents

This repository adds DeepSeek V4 Flash to the stock ChatGPT / Codex app through a loopback router.
If a user asks you to install it, follow the "Install by a coding agent" section in `README.md`.
The non-negotiable details:

1. Never print, persist, or commit the DeepSeek API key. On macOS, store it in the login-session
   environment with `launchctl setenv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"` and immediately unset
   the shell variable.
2. Run `node src/cli.mjs install`, then `node src/cli.mjs start`, then
   `node src/cli.mjs doctor`. Doctor must report `ok` for config, catalog, proxy, and key.
3. Run `npm test`; all tests must pass.
4. The ChatGPT desktop app must be fully quit (`⌘Q`) and relaunched, and the user must start a NEW
   task to see `🐳 V4 Flash`. Existing tasks keep their old model state.
5. Verify with a real tool loop using
   `codex -m deepseek/deepseek-v4-flash -c 'model_reasoning_effort="max"' -a never exec
   --skip-git-repo-check 'call a shell tool exactly once …'`.
6. Do not edit `~/.codex/config.toml` by hand unless the user asks; the CLI owns its two
   marker-owned root keys. GUI-written `model` / `model_reasoning_effort` lines are user-owned and
   must be preserved.

# DSCodex

![DSCodex](assets/dscodex.png)

> 默认展示中文；英文版在文末。 · Chinese by default; English version at the bottom.

[中文](#zh) · [English](#en)

<a id="zh"></a>

## 中文说明

### 这是什么

DSCodex 让 DeepSeek V4 Flash 直接出现在原版 ChatGPT 桌面端 / Codex 的模型菜单里，不用改 App、也不用 fork Codex。它是一个约 40 KB、零依赖的 Node 本地路由，只在原生模型菜单里增加一项：

```text
🐳 V4 Flash   ·   默认 Max   ·   可选 High / Max
```

你现有的 ChatGPT OAuth 模型（GPT-5.6 系列等）会继续留在同一个菜单里，照常工作。

### 功能

- 原生模型菜单项 `🐳 V4 Flash`，ChatGPT 桌面端、Codex CLI、IDE 插件共用。
- 走 DeepSeek **原生 Responses API**（SSE），不是 Chat Completions 转换。
- 完整 Codex 工具循环：shell 命令、`apply_patch`、function call、web search、工具结果回传。
- GPT 模型继续使用你的 ChatGPT 订阅，通过同一份配置、同一套 OAuth。
- 不改 App 本体：安装/卸载只动带标记的 `config.toml` 行和一个合并后的模型目录文件，首次安装前会留备份。

### 工作原理

```text
Codex App / CLI / IDE
        │  HTTP/SSE（zstd 压缩请求、OAuth 头）
        ▼
http://127.0.0.1:10110/v1   ← DSCodex 本地路由
        │
        ├── model == "deepseek/deepseek-v4-flash"
        │        ▼
        │   https://api.deepseek.com/responses   （DeepSeek 原生 SSE）
        │
        └── 其他任何模型（gpt-5.6-*、codex-auto-review 等）
                 ▼
        https://chatgpt.com/backend-api/codex    （OAuth 流量原样转发）
```

Codex 的 `openai_base_url` 指向本地路由，`model_catalog_json` 把 V4 Flash 条目合入模型目录。选中 `deepseek/deepseek-v4-flash` 时，DSCodex 只改写模型名和 provider 相关字段；其他模型请求逐字节原样转发。

几个关键设计：

- **鲸鱼图标。** Codex 的模型目录没有 provider 图标字段，所以 `🐳` 放在 `display_name` 里，这是不改 App 前提下在原生菜单显示图标的唯一方式。
- **思考档位。** DeepSeek 只支持 `high` 和 `max`，目录也只声明这两档；更低的旧档位映射为 `high`。
- **无状态 API。** DeepSeek Responses API 没有服务端会话，路由会移除 `previous_response_id`、`conversation`、`background`、`metadata`，并强制 `store=false`。
- **纯文本。** V4 Flash 是文本模型，目录声明 `input_modalities: ["text"]`。

### 环境要求

- macOS 或 Linux，Node.js 20+（推荐 26：自带 zstd 支持）。
- 已登录的 ChatGPT 桌面端或 Codex CLI（GPT OAuth 模型需要）。
- DeepSeek API Key（`sk-…`）。
- 端口 `10110` 空闲（可用 `--port` 或 `DSCODEX_PORT` 修改）。

### 安装

#### 交给 Coding Agent 安装（推荐）

这个仓库按“克隆下来直接让 Agent 装”设计。把本 README 交给 Agent（或克隆仓库让它读 `AGENTS.md`），步骤是：

1. 从用户处拿到 DeepSeek API Key，**不要打印、不要落盘**；macOS 上写入登录会话环境：
   `launchctl setenv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"`，然后立刻 unset shell 变量。
2. `node src/cli.mjs install` —— 写入两条带标记的根配置，并把 `🐳 V4 Flash` 合入当前 Codex 模型目录；遇到用户自有的 `openai_base_url` 会拒绝覆盖。
3. `node src/cli.mjs start`，再 `node src/cli.mjs doctor` —— 四项检查必须全部 `ok`。
4. `npm test` —— 9 项协议/配置测试全绿。
5. 让用户完全退出（`⌘Q`）并重新打开 ChatGPT 桌面端，新建任务后选择 `🐳 V4 Flash`。
6. 验证真实工具循环，例如：
   `codex -m deepseek/deepseek-v4-flash -c 'model_reasoning_effort="max"' -a never exec --skip-git-repo-check 'call a shell tool once …'` —— 模型必须发起工具调用、读取输出并正常结束。

#### 手动安装

```bash
cd /path/to/DSCodex

read -s "DEEPSEEK_API_KEY?DeepSeek API Key: "; echo
launchctl setenv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"   # macOS 登录会话
unset DEEPSEEK_API_KEY

node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor
```

然后退出并重开 ChatGPT 桌面端，新建任务，选择 `🐳 V4 Flash`。

命令：`install`、`sync`、`start`、`serve`、`status`、`doctor`、`stop`、`uninstall`。

### 思考档位默认值

菜单元数据默认显示 `Max`，但有一个重要的平台细节：Codex 的 `thread/start` **不读** catalog 里的 `default_reasoning_level`，会返回 `null`，然后 App 回落到 High。新任务真正默认 Max，靠的是全局根键：

```toml
model_reasoning_effort = "max"
```

Codex 没有“某个模型单独默认档位”的配置，所以这个全局键也会让 **GPT** 新任务默认 Max。ChatGPT 桌面端在你选择模型和档位时会自己写入 `model` 和 `model_reasoning_effort`；DSCodex 把这些行视为用户自有配置，卸载时不删除。

CLI 注意：`codex -m deepseek/deepseek-v4-flash` 不带覆盖参数时可能显示 `High`；需要 Max 时加 `-c 'model_reasoning_effort="max"'`。

### 已验证行为

- 真实 DeepSeek 工具循环：V4 Flash 发出 `function_call`，Codex 执行工具，输出回传 API，模型正常结束（`DSCODEX_TOOL_OK`、`DSCODEX_MAX_OK`）。
- GPT OAuth 旁路端到端验证（`DSCODEX_GPT_OAUTH_OK`）。
- 当前 Codex 会用 zstd 压缩请求体，路由支持解码。
- `codex app-server` 的 `model/list` 返回 `🐳 V4 Flash`、默认 `max`、可选 `["high","max"]`，且原生 GPT 条目保留。

### 已知行为与边界

- **WebSocket 警告。** 目录声明 `prefer_websockets = false`，路由对 WebSocket 探测返回 `426`，Codex 回退到 HTTP/SSE。`codex doctor` 仍可能显示一条 WebSocket 警告，但请求本身正常。
- **Voice（语音）。** 桌面端语音由 GPT-Live 驱动、GPT-5.6 Terra 协调任务，两者都在 OAuth 路径上，不会路由到 DeepSeek。
- **Pets、插件、技能、MCP。** 这些是客户端功能；只要模型能发出合法工具调用就能继续工作。
- **Key 持久化。** Key 只存在于服务进程和 macOS 登录会话环境，从不写盘；注销/重启后需要重新设置。

### 为什么任务中思考会反复折叠/“跳动”

这是 DeepSeek API 的行为，不是 DSCodex 的 bug。DeepSeek 的 Responses 流在**每一轮工具调用结束时**都会发出：

```text
response.reasoning_text.done
response.output_item.done
response.completed
```

随后 Codex 执行工具，再发起**新请求**，新一轮思考重新开始。ChatGPT UI 收到这些完成信号就折叠思考块，下一轮思考又展开，所以多工具的长任务看起来像思考块反复折叠/展开。DSCodex 对 SSE 事件逐字节透传，没有新增也没有删改。代理层也不该“修”：Codex 必须收到 `response.completed` 才知道要执行工具，抑制它会让工具循环卡死。无工具的单轮只会在结尾折叠一次；新开对话在多工具轮时也是同样模式。

### 卸载

```bash
node src/cli.mjs stop
node src/cli.mjs uninstall
```

只删除 DSCodex 自己写入的配置行和合并后的模型目录；安装前备份保留在 `~/.codex/config.toml.pre-dscodex.bak`。GUI 写入的 `model` / `model_reasoning_effort` 保持不动。

### 开发

```bash
npm test               # 9 项协议/配置测试，使用真实本地 HTTP 服务器
npm run smoke:picker   # 通过 `codex app-server model/list` 验证模型菜单
```

目录结构：

```text
src/proxy.mjs     本地路由：DeepSeek 改写 + GPT OAuth 旁路
src/catalog.mjs   模型目录条目生成与同步
src/config.mjs    带标记的配置注入 / 移除
src/cli.mjs       install / start / stop / doctor / uninstall
test/             协议与配置测试
scripts/          针对真实 Codex app-server 的菜单冒烟测试
```

### 参考

- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek Codex 接入](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

<a id="en"></a>

## English

### What this is

DSCodex puts DeepSeek V4 Flash into the stock ChatGPT desktop app / Codex model picker without
patching the app or forking Codex. It is a ~40 KB, zero-dependency Node loopback router that adds
one entry to the native picker:

```text
🐳 V4 Flash   ·   default Max   ·   options High / Max
```

Your existing ChatGPT OAuth models (GPT-5.6 family, …) stay in the same picker and keep working.

### Features

- Native picker entry `🐳 V4 Flash`, shared by the ChatGPT desktop app, Codex CLI, and IDE extension.
- Native DeepSeek **Responses API** transport (SSE), not a Chat Completions conversion.
- Full Codex tool loop: shell commands, `apply_patch`, function calls, web search, and tool results
  fed back into the conversation.
- GPT models keep using your ChatGPT subscription through the same config and OAuth.
- The app itself is untouched: install/uninstall only touch marker-owned `config.toml` lines and one
  merged catalog file, with a backup taken before the first install.

### How it works

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

Codex's `openai_base_url` points at the router, and `model_catalog_json` merges the V4 Flash entry
into the catalog. When the selected model is `deepseek/deepseek-v4-flash`, DSCodex rewrites only the
model name and provider-specific fields; every other request is forwarded byte-for-byte.

Key decisions:

- **Whale icon.** The Codex catalog has no provider-icon field, so `🐳` lives in `display_name` —
  the only way to show a logo in the native picker without patching the app.
- **Reasoning levels.** DeepSeek supports only `high` and `max`; the catalog advertises exactly
  those, and legacy lower efforts map to `high`.
- **Stateless API.** DeepSeek's Responses API has no server-side session; the router removes
  `previous_response_id`, `conversation`, `background`, and `metadata`, and forces `store=false`.
- **Text only.** V4 Flash is a text model; the catalog declares `input_modalities: ["text"]`.

### Requirements

- macOS or Linux, Node.js 20+ (Node 26 recommended: built-in zstd).
- A signed-in ChatGPT desktop app or Codex CLI (for the GPT OAuth models).
- A DeepSeek API key (`sk-…`).
- Port `10110` free (change with `--port` or `DSCODEX_PORT`).

### Install

#### By a coding agent (recommended)

The repo is designed to be installed from a clean clone by a coding agent. Give the agent this
README (or clone the repo and let it read `AGENTS.md`):

1. Get the DeepSeek API key from the user **without printing or persisting it**; on macOS store it
   in the login-session environment: `launchctl setenv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"`, then
   unset the shell variable.
2. `node src/cli.mjs install` — writes two marker-owned root keys and merges `🐳 V4 Flash` into the
   current catalog. It refuses to overwrite a user-owned `openai_base_url`.
3. `node src/cli.mjs start`, then `node src/cli.mjs doctor` — all four checks must be `ok`.
4. `npm test` — all 9 protocol/config tests pass.
5. Ask the user to fully quit (`⌘Q`) and relaunch the ChatGPT app, start a **new** task, and pick
   `🐳 V4 Flash`.
6. Verify a real tool loop:
   `codex -m deepseek/deepseek-v4-flash -c 'model_reasoning_effort="max"' -a never exec
   --skip-git-repo-check 'call a shell tool once …'` — the model must call a tool, read its output,
   and finish.

#### Manually

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

### Reasoning-effort default

The picker metadata advertises `Max`, but Codex's `thread/start` **ignores** the catalog's
`default_reasoning_level`, returns `null`, and the app falls back to High. A new thread starts at
Max only when the global root key is present:

```toml
model_reasoning_effort = "max"
```

Codex has no per-model reasoning-effort default, so this global key also makes **GPT** new threads
default to Max. The ChatGPT app writes `model` and `model_reasoning_effort` itself when you choose a
model and effort; DSCodex treats those lines as user-owned and never removes them on uninstall.

CLI note: `codex -m deepseek/deepseek-v4-flash` without the override may show `High`; add
`-c 'model_reasoning_effort="max"'` when the CLI must use Max.

### Verified behavior

- Real DeepSeek tool loop: V4 Flash emitted a `function_call`, Codex executed it, the output was
  returned, and the model finished (`DSCODEX_TOOL_OK`, `DSCODEX_MAX_OK`).
- GPT OAuth passthrough verified end-to-end (`DSCODEX_GPT_OAUTH_OK`).
- Current Codex sends zstd-compressed request bodies; the router decodes them.
- `model/list` through `codex app-server` shows `🐳 V4 Flash`, default `max`,
  supported `["high","max"]`, and native GPT entries preserved.

### Known behaviors and edge cases

- **WebSocket warning.** The catalog declares `prefer_websockets = false`, and the router answers
  WebSocket probes with `426`, so Codex falls back to HTTP/SSE. `codex doctor` may still show a
  WebSocket warning; requests themselves succeed.
- **Voice.** Desktop voice is driven by GPT-Live and coordinated by GPT-5.6 Terra — both stay on
  the OAuth path and never route to DeepSeek.
- **Pets, plugins, skills, MCP.** These are client-side surfaces; they keep working as long as the
  model emits valid tool calls.
- **API key persistence.** The key lives only in the server process and the macOS login-session
  environment; it is never written to disk. Re-export it after logout/reboot.

### Why reasoning folds and “jumps” during a task

This is DeepSeek API behavior, not a DSCodex bug. DeepSeek's Responses stream ends **every tool
round** with:

```text
response.reasoning_text.done
response.output_item.done
response.completed
```

Codex then executes the tool and opens a **new** request, whose reasoning starts over. The ChatGPT
UI folds reasoning on those completion signals and re-opens it for the next round, so long
tool-heavy turns look like the thinking block repeatedly collapses and expands. DSCodex forwards
the SSE events byte-for-byte; suppressing them would break the tool loop, because Codex needs
`response.completed` to know when to run a tool. A no-tool turn folds once at the end; a fresh
conversation shows the same per-round pattern on multi-tool turns.

### Uninstall

```bash
node src/cli.mjs stop
node src/cli.mjs uninstall
```

Only DSCodex-owned config lines and the merged catalog are removed. The pre-install backup stays at
`~/.codex/config.toml.pre-dscodex.bak`, and GUI-written `model` / `model_reasoning_effort` lines are
left untouched.

### Development

```bash
npm test               # 9 protocol/config tests with real local HTTP servers
npm run smoke:picker   # validate the picker via `codex app-server model/list`
```

```text
src/proxy.mjs     loopback router: DeepSeek rewrite + GPT OAuth passthrough
src/catalog.mjs   catalog entry generation and sync
src/config.mjs    marker-owned config injection / removal
src/cli.mjs       install / start / stop / doctor / uninstall
test/             protocol and config tests
scripts/          picker smoke against the real Codex app-server
```

### References

- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek Codex integration](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

## License

MIT

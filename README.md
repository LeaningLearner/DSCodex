# DSCodex

![DSCodex](assets/dscodex-banner.png)

简体中文 · [English](README.en.md)

## 它解决什么问题

DSCodex 是一个约 40 KB、零依赖的 Node 本地路由，把 DeepSeek V4 Flash 加进原版 ChatGPT 桌面端 / Codex 的原生模型菜单——不改 App、不 fork Codex，GPT 模型照常走你的 OAuth 订阅。菜单里增加一项（桌面端、CLI、IDE 三端共用）：

```text
🐳 V4 Flash   ·   默认 Max   ·   可选 High / Max
```

- **原生环境用不了 DeepSeek。** Codex 的所有请求只走全局 `openai_base_url`，指到 DeepSeek 就废掉 GPT 模型；Chat Completions 式的转换接入又会丢工具循环。DSCodex 按模型名分流：V4 Flash 走 DeepSeek **原生 Responses API**（SSE），其余请求原样转发给 ChatGPT 后端。shell、`apply_patch`、function call、web search 全套工具照常可用。
- **切模型互相覆盖思考档位。** 桌面端切模型会把当前 effort 写进全局配置，OpenAI High 和 DeepSeek Max 互相覆盖。DSCodex 为两个 provider 各维护一个独立槽位——切回 GPT 时自动恢复它原来的档位和速度。

## 工作原理

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

`openai_base_url` 指向本地路由，`model_catalog_json` 把 V4 Flash 合入模型目录；路由只改写该模型的 provider 字段，其余请求原样转发。桌面端经 `CODEX_CLI_PATH` 挂一个透明 bridge，只改写模型选择的 JSONL RPC，再交给 App 自带的原版 Codex 二进制；双槽 effort/speed 状态就存在这个 bridge 里（`~/.codex/dscodex/model-selections.json`）。

## 环境要求

- macOS 或 Linux，Node.js 20+（推荐 26，自带 zstd）
- 已登录的 ChatGPT 桌面端或 Codex CLI（GPT OAuth 模型需要）
- DeepSeek API Key（`sk-…`）
- 端口 `10110` 空闲（`--port` 或 `DSCODEX_PORT` 可改）

## 安装

### 交给 Coding Agent 安装（推荐）

仓库按“克隆下来直接让 Agent 装”设计。把本 README 交给 Agent（或克隆仓库让它读 `AGENTS.md`）：

1. 拿到 DeepSeek API Key，**不要打印、不要落盘**；macOS 写入登录会话环境：`launchctl setenv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"`，然后立刻 unset。
2. `node src/cli.mjs install` —— 写入两条带标记的根配置，把 `🐳 V4 Flash` 合入模型目录；遇到用户自有的 `openai_base_url` 拒绝覆盖。
3. `node src/cli.mjs start`，再 `node src/cli.mjs doctor` —— 五项检查（含 app-server bridge）必须全部 `ok`。
4. `npm test` —— 全部测试通过。
5. 让用户完全退出（`⌘Q`）并重开 ChatGPT 桌面端，新建任务后选择 `🐳 V4 Flash`。
6. 验证真实工具循环：`codex -m deepseek/deepseek-v4-flash -c 'model_reasoning_effort="max"' -a never exec --skip-git-repo-check 'call a shell tool once …'` —— 模型必须发起工具调用、读取输出并正常结束。

### 手动安装

```bash
cd /path/to/DSCodex
read -s "DEEPSEEK_API_KEY?DeepSeek API Key: "; echo
launchctl setenv DEEPSEEK_API_KEY "$DEEPSEEK_API_KEY"   # macOS 登录会话
unset DEEPSEEK_API_KEY
node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor
```

然后退出重开 ChatGPT 桌面端，新建任务，选择 `🐳 V4 Flash`。

命令：`install`、`sync`、`start`、`serve`、`status`、`doctor`、`stop`、`uninstall`。

CLI 注意：`-m deepseek/deepseek-v4-flash` 不带覆盖参数时可能显示 `High`；需要 Max 时加 `-c 'model_reasoning_effort="max"'`。

## 已验证行为

- 真实 DeepSeek 工具循环与 GPT OAuth 旁路均端到端实测通过（`DSCODEX_TOOL_OK`、`DSCODEX_GPT_OAUTH_OK`）。
- bridge 覆盖默认 picker、已有任务切换、Fast 恢复与重启后的状态持久化；`model/list` 返回 `🐳 V4 Flash`、默认 `max`、可选 `["high","max"]`，原生 GPT 条目保留。

## 已知行为与边界

- **用量统计。** Codex App「Profile」的用量统计是只读的，无法计入 DeepSeek 用量——已实测。
- **WebSocket 警告。** 目录声明 `prefer_websockets = false`，路由对探测回 `426`，Codex 回退 HTTP/SSE；`codex doctor` 可能仍显示警告，但请求正常。
- **Voice、Pets、插件、技能、MCP。** 都是客户端功能；语音由 GPT-Live 驱动，不会路由到 DeepSeek。
- **Key 不落盘。** 只存在于服务进程和 macOS 登录会话环境，注销/重启后需重新设置。

## 任务中思考为什么反复折叠

DeepSeek 的 Responses 流在**每轮工具调用结束**时发 `response.reasoning_text.done` / `response.output_item.done` / `response.completed`，Codex 收到就折叠思考块、执行工具，再开新请求让下一轮思考重新展开——这是 API 行为，不是 bug。DSCodex 逐字节透传；抑制 `response.completed` 会让工具循环卡死。无工具的单轮只折叠一次。

## 卸载

```bash
node src/cli.mjs stop
node src/cli.mjs uninstall
```

只删除 DSCodex 写入的配置行、合并后的模型目录、双槽状态和它设置的 `CODEX_CLI_PATH`；备份留在 `~/.codex/config.toml.pre-dscodex.bak`，GUI 写入的配置不动。

## 参考

- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek Codex 接入](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

## 许可证

[MIT](LICENSE)

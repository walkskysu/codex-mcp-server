---
name: codex-mcp-server
description: 连接已运行的 Codex MCP Server，检测服务端口、Streamable HTTP 协议和工具可用性，并通过 MCP 进行文字对话或生成图片。
---

# Codex MCP Server 客户端

安装此 skill 只需复制整个 `codex-mcp-server` 目录（含 `scripts`）到 Agent 的技能目录。客户端不需要 Codex CLI、Codex 登录或 npm 依赖。不要因安装、接入或检测失败而安装/升级 Codex CLI、执行 `codex login`、启动服务或修改服务端配置；服务端由用户独立部署和维护。

## 接入前检测

默认 MCP 地址是 `http://127.0.0.1:9827/mcp`；用户指定地址时使用该地址。使用已有 Node.js 22+，从本 skill 目录执行：

```sh
node scripts/check-service.mjs
node scripts/check-service.mjs --url http://127.0.0.1:9828/mcp
```

脚本依次检查 HTTP 端口和 `/health`、MCP `initialize` / `notifications/initialized`、`tools/list` 中的 `codex_chat` 与 `codex_draw`，最后实际调用一次 `codex_chat` 验证后端可用。该调用使用服务端账号，可能产生模型用量。退出码 0 表示这些检查通过；失败返回非零退出码及失败阶段。仅端口开放、健康检查成功或工具存在都不能证明工具能执行。

需要验证画图能力时执行 `node scripts/check-service.mjs --draw`（也可组合 `--url`），会额外调用一次 `codex_draw`，检查 PNG 图片结果，产生图片用量和服务端文件。普通检测不会生成图片，也不宣称图片生成已验证。

协议请求默认 10 秒超时，工具执行默认 660 秒；可用 `--timeout-ms 20000 --tool-timeout-ms 900000` 调整。脚本针对本项目的无状态 Streamable HTTP / JSON 响应；不支持旧版 SSE 或 stdio。

若没有 Node.js，使用 Agent 已有的 HTTP/MCP 客户端执行同样的健康检查、初始化、工具发现和实际调用，不自动安装运行时或 CLI。连接失败时报告地址和失败阶段，提示用户检查服务进程/端口；协议失败时核对 `/mcp` 和传输类型；工具返回 `isError: true` 时转述服务端错误，让用户检查服务端登录、权限或模型能力。不要把失败当作安装依赖的指令，也不要无限重试。

## 使用工具

在 Agent 的 MCP 配置中连接上述 URL，传输类型选 HTTP / Streamable HTTP。配置格式依宿主 Agent 而定，不配置本地 `codex` 或 stdio 启动命令。

- `codex_chat`：传入 `prompt`，读取 MCP `text` 内容。每次调用独立，多轮对话需在 prompt 中带上必要上下文。
- `codex_draw`：传入图片描述 `prompt`，读取 MCP `image`（PNG base64）内容；返回的路径是服务端路径。
- 两者均可传可选的 `model`，省略时采用服务端配置。工具超时应长于服务端执行超时（默认 600 秒）。始终检查 `isError`，不要将错误文本作为成功结果。

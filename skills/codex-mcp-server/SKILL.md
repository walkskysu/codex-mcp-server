---
name: codex-mcp-server
description: 连接已运行的 Codex MCP Server，检测服务端口、Streamable HTTP 协议和工具可用性，并通过 MCP 进行多附件对话、生成或修改图片。
---

# Codex MCP Server 客户端

安装此 skill 只需复制整个 `codex-mcp-server` 目录（含 `scripts`）到 Agent 的技能目录。客户端不需要 Codex CLI、Codex 登录或 npm 依赖。不要因安装、接入或检测失败而安装/升级 Codex CLI、执行 `codex login`、启动服务或修改服务端配置；服务端由用户独立部署和维护。

## 接入前检测

默认 MCP 地址是 `http://127.0.0.1:9827/mcp`；用户指定地址时使用该地址。使用已有 Node.js 22+，从本 skill 目录执行：

```sh
node scripts/check-service.mjs
node scripts/check-service.mjs --url http://127.0.0.1:9828/mcp
```

脚本依次检查 HTTP 端口和 `/health`、MCP `initialize` / `notifications/initialized`、`tools/list` 中的 `codex_chat`、`codex_draw` 与 `codex_edit`，最后实际调用一次 `codex_chat` 验证后端可用。该调用使用服务端账号，可能产生模型用量。退出码 0 表示这些检查通过；失败返回非零退出码及失败阶段。仅端口开放、健康检查成功或工具存在都不能证明工具能执行。检测脚本不会实际上传附件或修改图片，不宣称这些能力已验证。

需要验证画图能力时执行 `node scripts/check-service.mjs --draw`（也可组合 `--url`），会额外调用一次 `codex_draw`，检查 PNG 图片结果，产生图片用量和服务端文件。普通检测不会生成图片，也不宣称图片生成已验证。

协议请求默认 10 秒超时，工具执行默认 660 秒；可用 `--timeout-ms 20000 --tool-timeout-ms 900000` 调整。脚本针对本项目的无状态 Streamable HTTP / JSON 响应；不支持旧版 SSE 或 stdio。

若没有 Node.js，使用 Agent 已有的 HTTP/MCP 客户端执行同样的健康检查、初始化、工具发现和实际调用，不自动安装运行时或 CLI。连接失败时报告地址和失败阶段，提示用户检查服务进程/端口；协议失败时核对 `/mcp` 和传输类型；工具返回 `isError: true` 时转述服务端错误，让用户检查服务端登录、权限或模型能力。不要把失败当作安装依赖的指令，也不要无限重试。

## 使用工具

在 Agent 的 MCP 配置中连接上述 URL，传输类型选 HTTP / Streamable HTTP。配置格式依宿主 Agent 而定，不配置本地 `codex` 或 stdio 启动命令。

- `codex_chat`：传入 `prompt` 和可选 `attachments` 数组，读取 MCP `text` 内容。每次调用独立，多轮对话需在 prompt 中带上必要上下文，重新上传本轮需要的附件。
- `codex_draw`：传入图片描述 `prompt`，读取 MCP `image`（PNG base64）内容；返回的路径是服务端路径。
- `codex_edit`：传入修改要求 `prompt` 和必填 `images` 数组（一张或多张参考图片），读取 MCP `image`（修改后的单张 PNG base64）内容及服务端路径。
- 三者均可传可选的 `model`，省略时采用服务端配置。工具超时应长于服务端执行超时（默认 600 秒）。始终检查 `isError`，不要将错误文本作为成功结果。

附件通过工具参数直接上传内容，无需单独上传接口。`attachments` / `images` 的每项为 `{ "name": "photo.jpg", "mimeType": "image/jpeg", "data": "<文件字节的标准 base64>" }`。读取客户端文件字节并编码，不能用本地路径、URL 或带 `data:` 前缀的字符串代替 `data`。`name` 仅为文件名，不含目录。每次最多 10 个文件，解码后单文件最多 10 MiB、合计最多 20 MiB，整个 JSON 请求最多 30 MiB。

图片只支持 `image/png`、`image/jpeg`、`image/webp`；普通对话还可传 `text/plain`、`text/csv`、`application/pdf` 等附件，其读取能力取决于服务端 Codex 的工具。服务按数组顺序提供图片和文件清单，因此提示词可用“第一张图”“第二个附件”来引用。调用示例（省略实际 base64）：

```json
{
  "name": "codex_edit",
  "arguments": {
    "prompt": "把第一张照片的背景改成第二张图中的花园，保留人物外貌。",
    "images": [
      { "name": "person.jpg", "mimeType": "image/jpeg", "data": "<base64>" },
      { "name": "garden.png", "mimeType": "image/png", "data": "<base64>" }
    ]
  }
}
```

普通对话使用 `codex_chat` 和 `attachments` 数组，格式相同。附件保存在服务端独立任务目录，原始请求（含附件 base64）也会记入服务端日志；保留策略由服务维护者管理。

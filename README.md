# Codex MCP Server

把本机 Codex CLI 暴露为三个 MCP 工具：支持多附件的对话 `codex_chat`、画图 `codex_draw` 和修改图片 `codex_edit`。默认地址为 **`http://127.0.0.1:9827/mcp`**，使用官方 MCP SDK 的无状态 Streamable HTTP（JSON 响应）。

## 安装 skill / 接入已有服务

其他 AI Agent 安装本项目 skill 时，**不安装 Codex CLI、不执行 Codex 登录、不启动服务**。将 [`skills/codex-mcp-server`](skills/codex-mcp-server/SKILL.md) 整个目录（含脚本）复制到 Agent 的技能目录即可。客户端只连接已运行的 MCP 服务；Codex CLI 和账号由服务端维护。

使用已有 Node.js 22+ 检测服务，无需 `npm install`：

```sh
node skills/codex-mcp-server/scripts/check-service.mjs
# 自定义服务端口
node skills/codex-mcp-server/scripts/check-service.mjs --url http://127.0.0.1:9828/mcp
# 额外验证图片生成能力
node skills/codex-mcp-server/scripts/check-service.mjs --draw
```

检测包含 HTTP 端口和 `/health`、MCP 初始化与工具发现，以及一次真实 `codex_chat` 调用。默认不生成图片；`--draw` 会额外调用 `codex_draw` 并检查 PNG 内容。真实调用使用服务端账号，可能产生用量。成功退出码为 0，失败为 1 并输出失败阶段；服务未启动、协议不匹配或后端不可用时报告问题，不自动安装或修复服务端。协议请求默认 10 秒、工具调用默认 660 秒，可通过 `--timeout-ms` / `--tool-timeout-ms` 调整。

## 服务端部署（仅服务维护者）

以下步骤只用于用户主动部署服务端，不是 skill 的安装步骤。

需要 Node.js 22+、已安装并登录的 Codex CLI。画图还需要当前 Codex CLI / 账号具备图片生成能力及可用的 `imagegen` 技能。先在同一系统用户下确认 Codex 可以正常对话和生成图片。

```sh
npm install -g @openai/codex
codex login
npm ci
npm start
```

Windows PowerShell 可使用 `npm.cmd`、`codex.cmd`。服务支持 npm 安装的 Windows Codex 启动器，会解析到其 JavaScript 入口并直接调用 Node，避免通过 shell 执行请求文本。

健康检查：`GET http://127.0.0.1:9827/health`。此接口仅表示服务正在运行，不验证 Codex 登录状态。

## 连接 AI Agent

在支持 Streamable HTTP 的 MCP 客户端中添加：

```json
{
  "mcpServers": {
    "codex-local": {
      "url": "http://127.0.0.1:9827/mcp"
    }
  }
}
```

不同客户端配置格式可能不同，请将传输类型设为 HTTP / Streamable HTTP。该服务不提供旧版 `/sse` 传输，也不使用 stdio。

使用本项目依赖的 JavaScript SDK：

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:9827/mcp'),
));
try {
  console.log(await client.callTool({
    name: 'codex_chat',
    arguments: { prompt: '用中文解释什么是 MCP' },
  }, undefined, { timeout: 660_000 }));
  console.log(await client.callTool({
    name: 'codex_draw',
    arguments: { prompt: '画一只在月球上喝茶的猫，水彩风格' },
  }, undefined, { timeout: 660_000 }));
} finally {
  await client.close();
}
```

三个工具均接受必填 `prompt`（1–100,000 字符）和可选 `model`（Codex 模型名称，省略时使用 CLI 配置）。每次调用都是独立的 Codex 执行；多轮聊天请在 `prompt` 中带上需要的历史上下文，并重新上传本轮需要的附件。

- `codex_chat`：通过 stdin 传递提示词，可选 `attachments` 上传多个附件，以 `codex exec` 执行，返回最终回复的 MCP `text` 内容。
- `codex_draw`：提示 Codex 使用 `$imagegen` 生成一张图片，并保存到独立任务目录的 `output.png`。返回 PNG 的 MCP `image` 内容（base64）以及本机文件路径，调用方无需访问服务器文件系统即可显示图片。
- `codex_edit`：必填 `images` 上传一张或多张参考图片，在 `prompt` 中描述修改要求。提示 Codex 使用 `$imagegen` 基于这些图片修改，返回一张 PNG 的 MCP `image` 内容（base64）及服务端保存路径，与 `codex_draw` 返回结构一致。

画图和改图读取实际 PNG 文件，不把 CLI 返回的文字当作图片。CLI 不支持生图/改图、账号无权限、未输出图片、文件格式错误或图片超过 10 MiB 时返回 `isError: true`，并附带错误说明。服务不直接调用 Images API；图片能力和费用取决于本机 Codex 配置。

### 上传附件与修改图片

`attachments` 和 `images` 中每个对象均包含 `name`（不含目录的原始文件名）、`mimeType` 和 `data`（文件字节的标准 base64，含必要的 `=` 填充，不带 `data:` 前缀）。调用方读取本地文件后上传内容，不传服务端文件路径或 URL。每次最多 10 个文件，单文件解码后最多 10 MiB，合计最多 20 MiB；改图至少需要 1 张图片。

图片支持 PNG（`image/png`）、JPEG（`image/jpeg`）、WebP（`image/webp`），会校验文件头与 MIME 类型。普通对话还可上传文本、CSV、PDF 等其他文件；服务将原始字节保存到任务目录，具体读取能力取决于服务端 Codex 可用的工具。图片通过 CLI `--image` 参数传入，其他文件通过提示词中的文件清单读取。

以下代码在上面的 SDK `client` 已连接时使用：

```js
import { readFile } from 'node:fs/promises';

async function upload(file, name, mimeType) {
  return { name, mimeType, data: (await readFile(file)).toString('base64') };
}

const photo = await upload('./photo.jpg', 'photo.jpg', 'image/jpeg');
const reference = await upload('./reference.png', 'reference.png', 'image/png');
console.log(await client.callTool({
  name: 'codex_edit',
  arguments: {
    prompt: '把第一张照片的背景换成第二张图中的花园，保留人物外貌和衣服。',
    images: [photo, reference],
  },
}, undefined, { timeout: 660_000 }));

console.log(await client.callTool({
  name: 'codex_chat',
  arguments: {
    prompt: '根据需求文档和照片，给出布置建议。',
    attachments: [await upload('./requirements.txt', 'requirements.txt', 'text/plain'), photo],
  },
}, undefined, { timeout: 660_000 }));
```

附件按传入顺序保存为 `attachments/1.jpg` 等服务端生成的文件名，同名附件不会相互覆盖。原文件名和 MIME 类型保留在提示词清单中。无效 base64、超限、非法文件名或不匹配的图片类型会返回 `isError: true`，且不会启动 CLI；整个 HTTP JSON 请求超过 30 MiB 时返回 HTTP 413。

## 配置

通过环境变量配置（服务不会自动加载 `.env`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9827` | HTTP 端口，1–65535 |
| `CODEX_BIN` | `codex` | CLI 命令或可执行文件 / JS 入口路径；不支持拼接额外命令参数 |
| `CODEX_TIMEOUT_MS` | `600000` | 每次 CLI 执行的超时毫秒数 |
| `CODEX_MAX_CONCURRENT` | `2` | 同时运行的 CLI 数量，1–32；超出时立即返回 busy 错误，可稍后重试 |
| `LOG_FILE` | `logs/requests.jsonl` | JSONL 日志路径 |
| `DATA_DIR` | `data/requests` | 各任务的输出目录 |

相对路径以启动服务时的目录为基准。示例（PowerShell）：

```powershell
$env:PORT = '9827'
$env:CODEX_TIMEOUT_MS = '900000'
npm.cmd start
```

客户端超时也应适当调大，尤其是生成图片时。HTTP 连接中断、服务退出或 CLI 超时会尝试终止对应进程树；Ctrl+C 可停止服务。由于采用无状态传输，跨 HTTP 请求的 MCP `notifications/cancelled` 不关联到先前请求；请关闭原调用的 HTTP 连接以取消执行。

## 日志与执行范围

每个收到的 MCP JSON 请求（包括无效工具名和参数）都会带上唯一 `requestId`，原样打印到 console 并追加到 JSONL 文件。执行命令、任务目录、完成耗时及执行错误使用同一 ID 关联。日志包含完整提示词和上传附件的 base64；请按本机数据保留要求管理。日志、上传附件和输出文件均已加入 `.gitignore`，不会自动清理或轮转。

服务仅绑定 `127.0.0.1`，检查 Host / Origin，供同机可信 Agent 使用。没有远程认证功能，请勿直接转发到公网。它继承当前用户的 Codex 登录信息、技能及配置；不要在子 Codex 配置中再次启用本服务，以免递归调用。

所有调用在独立任务目录运行，禁用交互式审批；对话工具使用 `read-only` 沙箱，画图和改图使用 `workspace-write`。提示词通过 stdin 传递，子进程使用参数数组和 `shell: false`。服务不允许调用方指定工作目录、额外 CLI 参数或解除沙箱。HTTP 请求体限制为 30 MiB（为最多 20 MiB 附件的 base64 编码及 JSON 留出空间），CLI stdout/stderr 合计和最终文字各限制为 2 MiB。

## 测试

```sh
npm test
```

使用 Node 内置测试框架、真实 HTTP MCP 客户端和独立 CLI fixture 进程，不需要登录、API key 或付费模型调用。覆盖工具发现、文字与图片返回、单图/多图修改、多附件字节传递与隔离、文件名/base64/格式/大小校验、双通道日志、CLI 启动失败/非零退出/超时/取消/输出上限、并发限制和 Windows 启动器解析。fixture 测试验证协议及集成路径，不验证实际账号的模型或图片生成/修改可用性。

skill 检测脚本的测试还覆盖无客户端 CLI 的独立运行、自定义端口、协议协商、健康检查/协议/工具调用失败、超时、默认只验证文字及显式图片验证。

参考：[Codex 非交互执行](https://developers.openai.com/codex/noninteractive)、[图片生成](https://learn.chatgpt.com/docs/image-generation?surface=cli)、[MCP SDK Streamable HTTP](https://ts.sdk.modelcontextprotocol.io/server)。

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { MAX_BODY_BYTES, uploadsSchema } from './attachments.js';

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(Object.assign(new Error('Request body exceeds 30 MiB'), { status: 413 }));
      } else chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
  });
}

function createMcpServer(run, logger, requestId, signal) {
  const server = new McpServer({ name: 'codex-mcp-server', version: '0.1.0' });
  for (const [name, description] of [
    ['codex_chat', 'Send a prompt with optional uploaded attachments to Codex CLI and return its answer. Stateless: include prior conversation in the prompt when needed.'],
    ['codex_draw', 'Generate one PNG using Codex image generation. Returns inline image data and a local saved path. Requires an image-capable Codex installation/account.'],
    ['codex_edit', 'Edit one or more uploaded reference images according to a prompt. Returns one edited PNG inline and a local saved path. Requires an image-capable Codex installation/account.'],
  ]) {
    server.registerTool(name, {
      description,
      inputSchema: z.object({
        prompt: z.string().trim().min(1).max(100_000).describe('Text question or image description'),
        model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/).optional().describe('Optional Codex model; defaults to the CLI configuration'),
        ...(name === 'codex_chat' ? { attachments: uploadsSchema().optional().describe('Up to 10 base64 files; 10 MiB each, 20 MiB total. Images: PNG, JPEG or WebP. Other files are read from the task directory.') } : {}),
        ...(name === 'codex_edit' ? { images: uploadsSchema(true).describe('1–10 base64 reference images (PNG, JPEG or WebP); 10 MiB each, 20 MiB total') } : {}),
      }).strict(),
    }, async (input, extra) => {
      const started = Date.now();
      try {
        const result = await run({ ...input, tool: name, requestId, signal: AbortSignal.any([signal, extra.signal]) });
        logger.log('tool.completed', { requestId, tool: name, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        logger.log('tool.failed', { requestId, tool: name, durationMs: Date.now() - started, error: error.message });
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  return server;
}

export function createHttpServer({ config, logger, run }) {
  const active = new Set();
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      try { logger.log('http.failed', { error: error.message }); } catch { console.error(error); }
      if (!response.headersSent) sendJson(response, error.status || 500, {
        jsonrpc: '2.0', id: null, error: { code: error.status === 400 ? -32700 : -32603, message: error.message },
      });
      else response.end();
    });
  });

  async function handle(request, response) {
    // Local agents only. Validate Host/Origin as well as the bind address to
    // prevent a browser on an unrelated site from reaching the CLI via DNS rebinding.
    const port = server.address()?.port;
    const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = request.headers.host;
    if (!authorities.has(host) || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
      sendJson(response, 403, { error: 'Only same-origin loopback requests are accepted' });
      return;
    }
    if (request.url === '/health' && request.method === 'GET') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.url !== '/mcp') { sendJson(response, 404, { error: 'Not found' }); return; }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, { error: 'Use POST for stateless Streamable HTTP MCP' });
      return;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      sendJson(response, 415, { error: 'Content-Type must be application/json' });
      return;
    }
    const requestId = randomUUID();
    const body = await readJson(request);
    // Log before validation/dispatch, including unknown tools and invalid arguments.
    logger.log('mcp.request', { requestId, body });
    const controller = new AbortController();
    const mcp = createMcpServer(run, logger, requestId, controller.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const entry = { controller, mcp };
    active.add(entry);
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
      active.delete(entry);
      void mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
      });
      return server.address();
    },
    async close() {
      for (const { controller } of active) controller.abort();
      await Promise.allSettled([...active].map(({ mcp }) => mcp.close()));
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

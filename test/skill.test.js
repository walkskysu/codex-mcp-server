import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkService, parseArgs } from '../skills/codex-mcp-server/scripts/check-service.mjs';
import { createHttpServer } from '../src/server.js';
import { createCodexRunner } from '../src/codex.js';
import { setup } from './helpers.js';

async function start(t, overrides = {}) {
  const context = await setup(t, overrides);
  const service = createHttpServer({ ...context, run: createCodexRunner(context.config, context.logger) });
  const address = await service.listen();
  t.after(() => service.close());
  return { ...context, service, url: `http://127.0.0.1:${address.port}/mcp` };
}

function runScript(script, args) {
  return new Promise((resolve, reject) => {
    // No executable lookup is available to the client, including npm and codex.
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, PATH: '', Path: '' }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('copied standalone skill checks real MCP and chat without client CLI or npm packages', async (t) => {
  const { directory, url, consoleLines } = await start(t);
  const isolated = path.join(directory, 'standalone');
  await mkdir(isolated);
  const script = path.join(isolated, 'check-service.mjs');
  await copyFile('skills/codex-mcp-server/scripts/check-service.mjs', script);
  const result = await runScript(script, ['--url', url]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.checks, ['health', 'initialize', 'tools/list', 'codex_chat']);
  assert.equal(report.drawing, 'not tested');
  const methods = consoleLines.map((line) => JSON.parse(line)).filter((line) => line.event === 'mcp.request').map((line) => line.body.method);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(consoleLines.map(JSON.parse).filter((line) => line.event === 'codex.start').length, 1);
});

test('explicit drawing check verifies actual image output through MCP', async (t) => {
  const { url } = await start(t);
  const report = await checkService({ url, draw: true });
  assert.equal(report.ok, true);
  assert.equal(report.drawing, 'verified');
  assert.equal(report.checks.at(-1), 'codex_draw');
});

test('healthy HTTP and tool discovery do not hide a missing server-side Codex executable', async (t) => {
  const { url } = await start(t, { codexBin: path.resolve('nonexistent-codex-skill-test') });
  const result = await runScript('skills/codex-mcp-server/scripts/check-service.mjs', ['--url', url]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /codex_chat:/);
  assert.equal(result.stdout, '');
});

// Controlled HTTP responses exercise failures that a healthy SDK server cannot produce.
async function fakeServer(t, reply) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const overridden = reply(request, body);
    if (overridden === 'hang') return;
    if (overridden) {
      response.writeHead(overridden.status || 200, { 'Content-Type': overridden.type || 'application/json' });
      response.end(overridden.raw ?? JSON.stringify(overridden.body));
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"status":"ok"}');
      return;
    }
    assert.equal(request.headers.accept, 'application/json, text/event-stream');
    if (body.method !== 'initialize') assert.equal(request.headers['mcp-protocol-version'], '2025-03-26');
    if (body.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
    const results = {
      initialize: { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } },
      'tools/list': { tools: ['codex_chat', 'codex_draw', 'codex_edit'].map((name) => ({ name, inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } })) },
      'tools/call': { content: [{ type: 'text', text: 'OK' }] },
    };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

test('protocol negotiation sends the negotiated version on subsequent requests', async (t) => {
  const url = await fakeServer(t, () => undefined);
  assert.equal((await checkService({ url })).protocolVersion, '2025-03-26');
});

test('service check reports an older server missing the image editing tool', async (t) => {
  const url = await fakeServer(t, (_request, body) => {
    if (body?.method === 'tools/list') return { body: {
      jsonrpc: '2.0', id: body.id, result: {
        tools: ['codex_chat', 'codex_draw'].map((name) => ({ name, inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } })),
      },
    } };
  });
  await assert.rejects(checkService({ url }), /tools\/list: Missing tool or prompt schema: codex_edit/);
});

for (const [name, method, override, expected] of [
  ['wrong health service', undefined, { body: { status: 'down' } }, /health: Expected health/],
  ['HTTP authentication failure', 'initialize', { status: 401, body: {} }, /initialize: HTTP 401/],
  ['legacy SSE response', 'initialize', { type: 'text/event-stream', raw: 'data: {}\n\n' }, /initialize: Expected Streamable HTTP JSON/],
  ['malformed JSON', 'initialize', { raw: '{' }, /initialize:/],
  ['wrong response id', 'initialize', { body: { jsonrpc: '2.0', id: 999, result: {} } }, /mismatched id/],
  ['unsupported protocol', 'initialize', { result: { protocolVersion: 'wrong' } }, /Unsupported MCP protocol/],
  ['missing tools capability', 'initialize', { result: { protocolVersion: '2025-03-26', serverInfo: { name: 'x', version: '1' }, capabilities: {} } }, /Missing MCP server info or tools/],
  ['rejected initialization notification', 'notifications/initialized', { status: 400, body: {} }, /notifications\/initialized: HTTP 400/],
  ['missing tool', 'tools/list', { result: { tools: [] } }, /tools\/list: Missing tool/],
  ['JSON-RPC error', 'tools/list', { error: { code: -32601, message: 'Unavailable' } }, /tools\/list: JSON-RPC error: Unavailable/],
  ['backend authentication failure', 'tools/call', { result: { isError: true, content: [{ type: 'text', text: 'Please log in on server' }] } }, /codex_chat: Please log in on server/],
  ['empty chat', 'tools/call', { result: { content: [] } }, /codex_chat: Expected non-empty text/],
]) {
  test(`service check rejects ${name}`, async (t) => {
    const url = await fakeServer(t, (_request, body) => {
      if (body?.method !== method) return;
      if ('result' in override || 'error' in override) return { body: { jsonrpc: '2.0', id: body.id, ...override } };
      return override;
    });
    await assert.rejects(checkService({ url }), expected);
  });
}

test('drawing check rejects text without PNG image data', async (t) => {
  const url = await fakeServer(t, () => undefined);
  await assert.rejects(checkService({ url, draw: true }), /codex_draw: Expected PNG/);
});

test('drawing check rejects a truncated PNG header', async (t) => {
  const url = await fakeServer(t, (_request, body) => {
    if (body?.params?.name === 'codex_draw') return { body: {
      jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] },
    } };
  });
  await assert.rejects(checkService({ url, draw: true }), /codex_draw: Expected PNG/);
});

test('closed service port is reported as a health failure', async (t) => {
  const { service, url } = await start(t);
  await service.close();
  // Avoid closing the same service again in the registered cleanup.
  service.close = async () => {};
  await assert.rejects(checkService({ url }), /health: fetch failed/);
});

for (const [method, stage] of [[undefined, 'health'], ['tools/call', 'codex_chat']]) {
  test(`${stage} timeout is bounded and reported`, async (t) => {
    const url = await fakeServer(t, (_request, body) => body?.method === method ? 'hang' : undefined);
    await assert.rejects(checkService({ url, timeoutMs: method ? 5000 : 100, toolTimeoutMs: 100 }), new RegExp(`${stage}: .*timeout`, 'i'));
  });
}

test('invalid command arguments fail without contacting or changing a service', async () => {
  assert.deepEqual(parseArgs(['--url', 'http://localhost:9828/mcp', '--draw', '--timeout-ms', '20']), { url: 'http://localhost:9828/mcp', draw: true, timeoutMs: 20 });
  assert.throws(() => parseArgs(['--url']), /missing value/);
  assert.throws(() => parseArgs(['--install']), /Unknown option/);
  await assert.rejects(checkService({ url: 'file:///mcp' }), /HTTP or HTTPS/);
  for (const timeoutMs of [0, -1, NaN, 1.5, 2_147_483_648]) {
    await assert.rejects(checkService({ timeoutMs }), /Timeout must/);
  }
});

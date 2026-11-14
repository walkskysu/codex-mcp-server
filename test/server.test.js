import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/server.js';
import { createCodexRunner } from '../src/codex.js';
import { setup, pngData } from './helpers.js';
import { MAX_BODY_BYTES } from '../src/attachments.js';

async function start(t, customRun) {
  const context = await setup(t);
  const service = createHttpServer({ ...context, run: customRun || createCodexRunner(context.config, context.logger) });
  const address = await service.listen();
  t.after(() => service.close());
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  t.after(() => client.close());
  return { ...context, service, url, client };
}

test('SDK client initializes, discovers tools and calls text/image over HTTP', async (t) => {
  const { client, config, consoleLines } = await start(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['codex_chat', 'codex_draw', 'codex_edit']);
  assert.deepEqual(tools[0].inputSchema.required, ['prompt']);
  assert.deepEqual(tools.find((tool) => tool.name === 'codex_edit').inputSchema.required, ['prompt', 'images']);
  assert.equal(tools[0].inputSchema.properties.attachments.maxItems, 10);
  const chat = await client.callTool({ name: 'codex_chat', arguments: { prompt: '你好 Codex' } });
  assert.equal(chat.isError, undefined);
  assert.equal(chat.content[0].text, 'Reply: 你好 Codex');
  const drawing = await client.callTool({ name: 'codex_draw', arguments: { prompt: '画一只猫' } });
  assert.equal(drawing.isError, undefined);
  assert.equal(drawing.content[1].mimeType, 'image/png');
  assert.ok(Buffer.from(drawing.content[1].data, 'base64').length > 33);
  const lines = (await readFile(config.logFile, 'utf8')).trim().split('\n');
  assert.deepEqual(lines, consoleLines);
  const records = lines.map((line) => JSON.parse(line));
  const calls = records.filter((record) => record.event === 'mcp.request' && record.body.method === 'tools/call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.params.arguments.prompt, '你好 Codex');
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  assert.equal(records.filter((record) => record.event === 'tool.completed').length, 2);
  assert.equal(records.filter((record) => record.event === 'codex.start').length, 2);
});

test('tool failures return MCP isError and are logged without killing the server', async (t) => {
  const { client, consoleLines } = await start(t);
  const result = await client.callTool({ name: 'codex_chat', arguments: { prompt: 'fail', model: 'fixture-fail' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /authentication failure/);
  assert.ok(consoleLines.some((line) => JSON.parse(line).event === 'tool.failed'));
  assert.equal((await client.listTools()).tools.length, 3);
});

test('HTTP uploads multiple attachments above the former body limit and edits multiple images', async (t) => {
  const { client, config, consoleLines } = await start(t);
  const photo = { name: 'photo.png', mimeType: 'image/png', data: pngData };
  const document = { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.alloc(1024 * 1024, 'a').toString('base64') };
  const chat = await client.callTool({ name: 'codex_chat', arguments: { prompt: 'Read both files', attachments: [document, photo] } });
  assert.equal(chat.isError, undefined);
  const edited = await client.callTool({ name: 'codex_edit', arguments: { prompt: 'Combine these photos', images: [photo, photo] } });
  assert.equal(edited.isError, undefined);
  assert.equal(edited.content[1].type, 'image');
  assert.equal(edited.content[1].data, pngData);
  const starts = consoleLines.map(JSON.parse).filter((line) => line.event === 'codex.start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].cwd, starts[1].cwd);
  const invocations = await Promise.all(starts.map(async ({ requestId }) =>
    JSON.parse(await readFile(path.join(config.dataDir, requestId, 'invocation.json'), 'utf8'))));
  assert.deepEqual(invocations[0].attachments.map((file) => file.data), [document.data, photo.data]);
  assert.deepEqual(invocations[0].images, [photo.data]);
  assert.deepEqual(invocations[1].images, [photo.data, photo.data]);
});

test('invalid upload requests fail before dispatch and editing failures remain MCP errors', async (t) => {
  let calls = 0;
  const { client } = await start(t, async () => { calls++; return { content: [] }; });
  const photo = { name: 'photo.png', mimeType: 'image/png', data: pngData };
  for (const [name, args] of [
    ['codex_edit', {}], ['codex_edit', { images: [] }],
    ['codex_edit', { images: [{ ...photo, mimeType: 'text/plain' }] }],
    ['codex_chat', { attachments: [{ ...photo, name: '../photo.png' }] }],
    ['codex_chat', { attachments: [{ ...photo, data: 'invalid' }] }],
    ['codex_chat', { attachments: Array(11).fill(photo) }],
    ['codex_draw', { attachments: [photo] }],
  ]) {
    const result = await client.callTool({ name, arguments: { prompt: 'test', ...args } });
    assert.equal(result.isError, true);
  }
  assert.equal(calls, 0);
  const actual = await start(t);
  for (const args of [
    { images: [{ ...photo, data: 'bm90IHBob3Rv' }] },
    { images: [photo], model: 'fixture-no-image' },
  ]) {
    const result = await actual.client.callTool({ name: 'codex_edit', arguments: { prompt: 'edit', ...args } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /valid PNG|did not create output.png/);
  }
});

test('invalid and unknown tool requests never reach the CLI but are logged', async (t) => {
  let calls = 0;
  const { client, consoleLines } = await start(t, async () => { calls++; return { content: [] }; });
  for (const args of [{}, { prompt: '   ' }, { prompt: 123 }, { prompt: 'ok', model: '--bad' }, { prompt: 'ok', cwd: '/' }]) {
    const result = await client.callTool({ name: 'codex_chat', arguments: args });
    assert.equal(result.isError, true);
  }
  const unknown = await client.callTool({ name: 'missing', arguments: { prompt: 'x' } });
  assert.equal(unknown.isError, true);
  assert.equal(calls, 0);
  const records = consoleLines.map((line) => JSON.parse(line));
  assert.equal(records.filter((record) => record.body?.method === 'tools/call').length, 6);
});

test('HTTP health, methods, JSON parsing, body limits and origin/host checks', async (t) => {
  const { url } = await start(t);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(url.replace('/mcp', '/health'))).status, 200);
  assert.equal((await fetch(url.replace('/mcp', '/missing'))).status, 404);
  for (const method of ['GET', 'DELETE', 'PUT']) assert.equal((await fetch(url, { method })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ value: 'x'.repeat(MAX_BODY_BYTES) }) })).status, 413);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(url, { headers: { Host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHost, 403);
});

test('disconnecting HTTP cancels in-flight work', { timeout: 10_000 }, async (t) => {
  let markStarted;
  let markCancelled;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const cancelled = new Promise((resolve) => { markCancelled = resolve; });
  const { url } = await start(t, async ({ signal }) => {
    markStarted();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    markCancelled();
    throw new Error('cancelled');
  });
  const controller = new AbortController();
  const pending = fetch(url, { method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'codex_chat', arguments: { prompt: 'wait' } } }),
  });
  const rejection = assert.rejects(pending, /abort/i);
  await started;
  controller.abort();
  await rejection;
  await cancelled;
});

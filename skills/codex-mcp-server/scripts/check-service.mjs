#!/usr/bin/env node
// Self-contained client: copying the skill requires no npm packages or Codex CLI.
import { pathToFileURL } from 'node:url';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const DEFAULT_URL = 'http://127.0.0.1:9827/mcp';

export async function checkService({
  url = DEFAULT_URL, timeoutMs = 10_000, toolTimeoutMs = 660_000, draw = false,
} = {}) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('URL must use HTTP or HTTPS');
  for (const value of [timeoutMs, toolTimeoutMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('Timeout must be an integer between 1 and 2147483647');
  }
  let stage = 'health';
  let protocolVersion;
  let nextId = 1;
  const checks = [];

  async function request(target, options, timeout) {
    const response = await fetch(target, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  }

  async function rpc(method, params, { notification = false, timeout = timeoutMs } = {}) {
    const id = notification ? undefined : nextId++;
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }, timeout);
    if (notification) {
      await response.body?.cancel();
      if (response.status !== 202) throw new Error('Expected HTTP 202 for initialized notification');
      return;
    }
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      await response.body?.cancel();
      throw new Error('Expected Streamable HTTP JSON response');
    }
    const body = await response.json();
    if (!body || body.jsonrpc !== '2.0' || body.id !== id) throw new Error('Invalid JSON-RPC response or mismatched id');
    if (body.error) throw new Error(`JSON-RPC error: ${body.error.message || JSON.stringify(body.error)}`);
    if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new Error('Missing JSON-RPC result');
    return body.result;
  }

  async function callTool(name, prompt) {
    stage = name;
    const result = await rpc('tools/call', { name, arguments: { prompt } }, { timeout: toolTimeoutMs });
    if (result.isError) {
      throw new Error(result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') || 'Tool returned isError');
    }
    if (!Array.isArray(result.content)) throw new Error('Tool returned no content');
    return result.content;
  }

  try {
    const response = await request(new URL('/health', endpoint), {}, timeoutMs);
    if ((await response.json())?.status !== 'ok') throw new Error('Expected health status ok');
    checks.push('health');

    stage = 'initialize';
    const initialized = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {},
      clientInfo: { name: 'codex-mcp-skill-check', version: '1.0.0' },
    });
    if (!PROTOCOL_VERSIONS.includes(initialized.protocolVersion)) throw new Error('Unsupported MCP protocol version');
    if (!initialized.serverInfo?.name || !initialized.serverInfo?.version || !initialized.capabilities?.tools) {
      throw new Error('Missing MCP server info or tools capability');
    }
    protocolVersion = initialized.protocolVersion;
    stage = 'notifications/initialized';
    await rpc('notifications/initialized', undefined, { notification: true });
    checks.push('initialize');

    stage = 'tools/list';
    const { tools } = await rpc('tools/list');
    for (const name of ['codex_chat', 'codex_draw', 'codex_edit']) {
      const tool = Array.isArray(tools) && tools.find((item) => item.name === name);
      if (!tool || tool.inputSchema?.type !== 'object' || tool.inputSchema?.properties?.prompt?.type !== 'string') {
        throw new Error(`Missing tool or prompt schema: ${name}`);
      }
    }
    checks.push('tools/list');

    const chat = await callTool('codex_chat', 'Reply with OK only. This is a service connectivity check.');
    if (!chat.some((item) => item.type === 'text' && typeof item.text === 'string' && item.text.trim())) {
      throw new Error('Expected non-empty text from codex_chat');
    }
    checks.push('codex_chat');

    if (draw) {
      const drawing = await callTool('codex_draw', 'Generate a small plain blue square image for a service connectivity check.');
      if (!drawing.some((item) => {
        if (item.type !== 'image' || item.mimeType !== 'image/png' || typeof item.data !== 'string') return false;
        const png = Buffer.from(item.data, 'base64');
        return png.length >= 33 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          && png.toString('ascii', 12, 16) === 'IHDR';
      })) {
        throw new Error('Expected PNG image content from codex_draw');
      }
      checks.push('codex_draw');
    }
    return { ok: true, url: endpoint.href, protocolVersion, checks, drawing: draw ? 'verified' : 'not tested' };
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`, { cause: error });
  }
}

export function parseArgs(args) {
  const options = {};
  const values = { '--url': 'url', '--timeout-ms': 'timeoutMs', '--tool-timeout-ms': 'toolTimeoutMs' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--draw') options.draw = true;
    else if (arg === '--help') options.help = true;
    else if (values[arg] && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i];
      options[values[arg]] = arg === '--url' ? value : Number(value);
    } else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node check-service.mjs [--url URL] [--draw] [--timeout-ms MS] [--tool-timeout-ms MS]\nChecks health, MCP and a real chat call; --draw also generates an image using the server account.');
    else console.log(JSON.stringify(await checkService(options), null, 2));
  } catch (error) {
    console.error(`Service check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

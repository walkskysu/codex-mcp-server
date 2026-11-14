import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodexRunner, resolveCodexCommand } from '../src/codex.js';
import { setup } from './helpers.js';

test('text uses stdin literally and fixed noninteractive sandbox arguments', async (t) => {
  const { config, logger } = await setup(t);
  const run = createCodexRunner(config, logger);
  const requestId = randomUUID();
  const prompt = '你好\n"; $(echo danger) & %PATH% `echo nope` --help';
  const result = await run({ tool: 'codex_chat', prompt, model: 'test-model', requestId });
  assert.equal(result.content[0].text, `Reply: ${prompt}`);
  const invocation = JSON.parse(await readFile(path.join(config.dataDir, requestId, 'invocation.json'), 'utf8'));
  assert.equal(invocation.prompt, prompt);
  assert.equal(invocation.args.at(-1), '-');
  assert.ok(!invocation.args.includes(prompt));
  assert.deepEqual(invocation.args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.ok(invocation.args.includes('read-only'));
  assert.ok(!invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('drawing returns actual PNG bytes and retains isolated artifacts', async (t) => {
  const { config, logger } = await setup(t);
  const requestId = randomUUID();
  const result = await createCodexRunner(config, logger)({ tool: 'codex_draw', prompt: '画猫', requestId });
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/png');
  const saved = await readFile(path.join(config.dataDir, requestId, 'output.png'));
  assert.deepEqual(Buffer.from(result.content[1].data, 'base64'), saved);
  const invocation = JSON.parse(await readFile(path.join(config.dataDir, requestId, 'invocation.json'), 'utf8'));
  assert.match(invocation.prompt, /\$imagegen/);
  assert.match(invocation.prompt, /画猫/);
  assert.ok(invocation.args.includes('workspace-write'));
});

for (const [model, tool, message] of [
  ['fixture-fail', 'codex_chat', /exited with 7.*authentication failure/],
  ['fixture-empty', 'codex_chat', /empty response/],
  ['fixture-missing-response', 'codex_chat', /ENOENT/],
  ['fixture-flood', 'codex_chat', /output exceeded/],
  ['fixture-no-image', 'codex_draw', /did not create output.png/],
  ['fixture-invalid-image', 'codex_draw', /not a PNG/],
  ['fixture-large-image', 'codex_draw', /artifact exceeded/],
]) {
  test(`handles ${model}`, async (t) => {
    const { config, logger } = await setup(t);
    await assert.rejects(createCodexRunner(config, logger)({ tool, prompt: 'test', model, requestId: randomUUID() }), message);
  });
}

test('missing CLI gives an actionable error', async (t) => {
  const { config, logger } = await setup(t);
  config.codexBin = path.join(config.dataDir, 'missing-codex.exe');
  await assert.rejects(createCodexRunner(config, logger)({ tool: 'codex_chat', prompt: 'test', requestId: randomUUID() }), /Unable to start Codex CLI/);
});

test('timeout terminates CLI and releases concurrency slot', async (t) => {
  const { config, logger } = await setup(t, { timeoutMs: 1500, maxConcurrent: 1 });
  const run = createCodexRunner(config, logger);
  const requestId = randomUUID();
  await assert.rejects(run({ tool: 'codex_chat', prompt: 'test', model: 'fixture-hang', requestId }), /timed out/);
  const { pid } = JSON.parse(await readFile(path.join(config.dataDir, requestId, 'invocation.json'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const result = await run({ tool: 'codex_chat', prompt: 'again', requestId: randomUUID() });
  assert.equal(result.content[0].text, 'Reply: again');
});

test('cancellation stops a running process and rejects an already aborted request', async (t) => {
  const { config, logger } = await setup(t);
  const run = createCodexRunner(config, logger);
  const controller = new AbortController();
  const pending = run({ tool: 'codex_chat', prompt: 'test', model: 'fixture-hang', requestId: randomUUID(), signal: controller.signal });
  const rejection = assert.rejects(pending, /cancelled/);
  const timer = setTimeout(() => controller.abort(), 300);
  try { await rejection; } finally { clearTimeout(timer); }
  await assert.rejects(run({ tool: 'codex_chat', prompt: 'test', requestId: randomUUID(), signal: controller.signal }), /cancelled/);
});

test('concurrent runs use distinct directories and excess work fails promptly', async (t) => {
  const { config, logger } = await setup(t, { maxConcurrent: 1 });
  const run = createCodexRunner(config, logger);
  const first = run({ tool: 'codex_chat', prompt: 'first', model: 'fixture-delay', requestId: randomUUID() });
  await assert.rejects(run({ tool: 'codex_chat', prompt: 'second', requestId: randomUUID() }), /busy/);
  assert.equal((await first).content[0].text, 'Reply: first');
  assert.equal((await run({ tool: 'codex_chat', prompt: 'third', requestId: randomUUID() })).content[0].text, 'Reply: third');
});

test('Windows npm command resolves to Node without a shell, including paths with spaces', async (t) => {
  const { directory } = await setup(t);
  const npmDir = path.join(directory, 'npm with spaces');
  const entry = path.join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, '');
  await writeFile(path.join(npmDir, 'codex.cmd'), '');
  assert.deepEqual(await resolveCodexCommand('codex', { PATH: npmDir }, 'win32'), { executable: process.execPath, prefix: [entry] });
  await assert.rejects(resolveCodexCommand(path.join(directory, 'unknown.cmd')), /CODEX_BIN/);
});

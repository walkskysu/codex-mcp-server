import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { setup } from './helpers.js';

test('entry point rejects invalid configuration with a nonzero exit code', async () => {
  const child = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, PORT: 'invalid' }, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(stderr, /PORT must be an integer/);
});

test('entry point starts a reachable service and reports its endpoint', { timeout: 10_000 }, async (t) => {
  const { config } = await setup(t);
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, PORT: String(port), LOG_FILE: config.logFile, DATA_DIR: config.dataDir, CODEX_BIN: path.resolve(config.codexBin) },
    windowsHide: true,
  });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('\n')) resolve(JSON.parse(stdout.split('\n')[0]));
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Server exited before startup: ${stderr}`)));
  });
  const record = await started;
  assert.equal(record.event, 'server.started');
  assert.equal(record.url, `http://127.0.0.1:${port}/mcp`);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { status: 'ok' });
});

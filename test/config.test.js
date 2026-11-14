import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { setup } from './helpers.js';

test('defaults to loopback port 9827 and validates configuration', () => {
  assert.equal(loadConfig({}).port, 9827);
  assert.equal(loadConfig({}).host, '127.0.0.1');
  assert.equal(loadConfig({ PORT: '1234' }).port, 1234);
  for (const value of ['0', '-1', '65536', 'abc', '12.5', '']) {
    assert.throws(() => loadConfig({ PORT: value }), /PORT/);
  }
  assert.throws(() => loadConfig({ CODEX_TIMEOUT_MS: '0' }), /CODEX_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ CODEX_MAX_CONCURRENT: '33' }), /CODEX_MAX_CONCURRENT/);
});

test('console and file receive identical JSONL, including Unicode and escaped newlines', async (t) => {
  const { config, logger, consoleLines } = await setup(t);
  logger.log('request', { prompt: '画一只猫\n第二行', requestId: 'abc' });
  const lines = (await readFile(config.logFile, 'utf8')).trim().split('\n');
  assert.deepEqual(lines, consoleLines);
  const record = JSON.parse(lines[0]);
  assert.equal(record.prompt, '画一只猫\n第二行');
  assert.ok(Date.parse(record.timestamp));
});

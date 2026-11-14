import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export async function setup(t, overrides = {}) {
  const root = path.resolve('.test-tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'case-'));
  t.after(async () => {
    if (!path.resolve(directory).startsWith(root + path.sep)) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  });
  const config = { ...loadConfig({}), port: 0,
    codexBin: fileURLToPath(new URL('./fixtures/codex.js', import.meta.url)),
    dataDir: path.join(directory, 'data'), logFile: path.join(directory, 'requests.jsonl'),
    timeoutMs: 10_000, ...overrides };
  const consoleLines = [];
  const logger = createLogger(config.logFile, { log: (line) => consoleLines.push(line) });
  return { directory, config, logger, consoleLines };
}

import path from 'node:path';

function positiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return Number(value);
}

export function loadConfig(env = process.env) {
  return {
    host: '127.0.0.1',
    port: positiveInteger(env.PORT, 9827, 'PORT', 65535),
    codexBin: env.CODEX_BIN || 'codex',
    timeoutMs: positiveInteger(env.CODEX_TIMEOUT_MS, 600_000, 'CODEX_TIMEOUT_MS', 2_147_483_647),
    maxConcurrent: positiveInteger(env.CODEX_MAX_CONCURRENT, 2, 'CODEX_MAX_CONCURRENT', 32),
    logFile: path.resolve(env.LOG_FILE || 'logs/requests.jsonl'),
    dataDir: path.resolve(env.DATA_DIR || 'data/requests'),
  };
}

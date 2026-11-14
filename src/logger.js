import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function createLogger(file, consoleOutput = console) {
  mkdirSync(path.dirname(file), { recursive: true });
  // Fail at startup if request logging cannot be persisted.
  appendFileSync(file, '', { mode: 0o600 });
  return {
    log(event, fields = {}) {
      const line = JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields });
      consoleOutput.log(line);
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
    },
  };
}

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createCodexRunner } from './codex.js';
import { createHttpServer } from './server.js';

let service;
try {
  const config = loadConfig();
  const logger = createLogger(config.logFile);
  service = createHttpServer({ config, logger, run: createCodexRunner(config, logger) });
  const address = await service.listen();
  logger.log('server.started', { url: `http://${config.host}:${address.port}/mcp`, logFile: config.logFile });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await service.close(); logger.log('server.stopped'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  if (service?.server.listening) await service.close();
  console.error(`codex-mcp-server: ${error.message}`);
  process.exitCode = 1;
}

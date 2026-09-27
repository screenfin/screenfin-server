import { loadConfig } from './config';
import { buildServer } from './server';

const config = loadConfig(process.env);
const server = await buildServer({ config });

try {
  await server.app.listen({ port: config.port, host: config.host });
} catch (err) {
  server.app.log.error(err);
  process.exit(1);
}

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.app.log.info({ signal }, 'shutting down');
  server.shutdown().then(
    () => process.exit(0),
    (err: unknown) => {
      server.app.log.error(err);
      process.exit(1);
    },
  );
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

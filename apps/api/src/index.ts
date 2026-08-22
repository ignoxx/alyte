import { createServer } from './server.js';
import { createJobRunner } from './worker.js';

const port = Number.parseInt(process.env.PORT ?? '4317', 10);
const host = process.env.HOST ?? '127.0.0.1';
const server = createServer();
const jobRunner = createJobRunner();

jobRunner.start();

try {
  await server.listen({ port, host });
} catch (error) {
  jobRunner.stop();
  console.error(error);
  process.exitCode = 1;
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  jobRunner.stop();
  await server.close();
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

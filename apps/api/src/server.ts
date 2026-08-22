import Fastify, { type FastifyInstance } from 'fastify';
import type { HealthResponse } from '@alyte/contracts';

const CONTRACT_VERSION = '2026-08-01';

export function createServer(): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    contractVersion: CONTRACT_VERSION,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'local',
  }));

  return server;
}

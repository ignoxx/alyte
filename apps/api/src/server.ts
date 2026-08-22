import Fastify, { type FastifyInstance } from 'fastify';
import { CONTRACT_VERSION, type HealthResponse } from '@alyte/contracts';

export function createServer(): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    contractVersion: CONTRACT_VERSION,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'local',
  }));

  return server;
}

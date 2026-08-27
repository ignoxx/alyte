import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.js';

describe('API foundation', () => {
  it('exposes only a non-sensitive health contract', async () => {
    const server = createServer();
    const response = await server.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'ok',
      contractVersion: '2026-08-27',
      environment: 'local',
    });
    await server.close();
  });
});

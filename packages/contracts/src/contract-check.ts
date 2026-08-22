import assert from 'node:assert/strict';
import { CONTRACT_VERSION, type HealthResponse } from './index.js';

const response: HealthResponse = {
  status: 'ok',
  contractVersion: CONTRACT_VERSION,
  environment: 'production',
};

assert.equal(response.contractVersion, CONTRACT_VERSION);
assert.equal(response.environment, 'production');

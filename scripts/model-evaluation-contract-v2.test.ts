import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createProductionV2Contract } from './model-evaluation-contract-v2';

test('generated production contract records catalogue identity for reproducibility', () => {
  const generated = JSON.parse(
    readFileSync('packages/model-evaluation/generated/evaluation-contract-v2.json', 'utf8'),
  ) as Record<string, unknown>;
  const contract = createProductionV2Contract() as Record<string, unknown>;
  assert.equal(contract.catalogueVersion, '0.2.0');
  assert.equal(contract.catalogueSchemaVersion, 'alyte.catalogue.v1');
  assert.equal(generated.catalogueVersion, contract.catalogueVersion);
  assert.equal(generated.catalogueSchemaVersion, contract.catalogueSchemaVersion);
});

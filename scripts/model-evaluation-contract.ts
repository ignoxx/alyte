import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { format } from 'prettier';
import { createCanonicalEvaluationContract } from '../packages/model-evaluation/src/contract';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const outputPath = resolve(
  repositoryRoot,
  'packages/model-evaluation/generated/evaluation-contract-v1.json',
);
async function main(): Promise<void> {
  const expected = await format(JSON.stringify(createCanonicalEvaluationContract()), {
    parser: 'json',
  });
  if (process.argv.includes('--check')) {
    let actual: string;
    try {
      actual = readFileSync(outputPath, 'utf8');
    } catch {
      throw new Error(`missing generated evaluation contract: ${outputPath}`);
    }
    if (actual !== expected) {
      throw new Error(`stale generated evaluation contract: ${outputPath}`);
    }
  } else {
    writeFileSync(outputPath, expected);
  }
}

void main();

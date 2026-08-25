import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { format } from 'prettier';
import { createCanonicalEvaluationContract } from '../packages/model-evaluation/src/contract';
import {
  candidateEvaluationManifests,
  type EvaluationCandidate,
} from '../packages/model-evaluation/src/manifest';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const outputPath = resolve(
  repositoryRoot,
  'packages/model-evaluation/generated/evaluation-contract-v1.json',
);

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const candidate = argumentValue('--candidate') ?? 'qwen';
  if (!(candidate in candidateEvaluationManifests)) {
    throw new Error(`unsupported evaluation candidate: ${candidate}`);
  }
  const manifest = candidateEvaluationManifests[candidate as EvaluationCandidate];
  const requestedOutputPath = argumentValue('--output');
  const destination = requestedOutputPath ? resolve(requestedOutputPath) : outputPath;
  const expected = await format(JSON.stringify(createCanonicalEvaluationContract(manifest)), {
    parser: 'json',
  });
  if (process.argv.includes('--check')) {
    let actual: string;
    try {
      actual = readFileSync(destination, 'utf8');
    } catch {
      throw new Error(`missing generated evaluation contract: ${destination}`);
    }
    if (actual !== expected) {
      throw new Error(`stale generated evaluation contract: ${destination}`);
    }
  } else {
    writeFileSync(destination, expected);
  }
}

void main();

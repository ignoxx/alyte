import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { format } from 'prettier';
import {
  SEMANTIC_MAPPER_CONTEXT,
  SEMANTIC_MAPPER_GRAMMAR,
  SEMANTIC_MAPPER_LIMITS,
  SEMANTIC_MAPPER_PROMPT_VERSION,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  SEMANTIC_OCR_CHUNK_VERSION,
  serializeSemanticMapperChunk,
  productionLocalModelManifest,
} from './model-evaluation-production';
import {
  PRODUCTION_V2_FIXTURE_VERSION,
  productionV2Fixtures,
} from './model-evaluation-v2-fixtures';
import { CATALOGUE_SCHEMA_VERSION, CATALOGUE_VERSION } from '@alyte/catalogue';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = resolve(
  repositoryRoot,
  'packages/model-evaluation/generated/evaluation-contract-v2.json',
);
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

export function createProductionV2Contract() {
  return {
    contractVersion: 'alyte.semantic-mapper.production-baseline.v1',
    manifestVersion: productionLocalModelManifest.manifestVersion,
    promptBundleVersion: SEMANTIC_MAPPER_PROMPT_VERSION,
    fixtureVersion: PRODUCTION_V2_FIXTURE_VERSION,
    schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
    ocrChunkVersion: SEMANTIC_OCR_CHUNK_VERSION,
    catalogueVersion: CATALOGUE_VERSION,
    catalogueSchemaVersion: CATALOGUE_SCHEMA_VERSION,
    model: productionLocalModelManifest.pack.artifact,
    runtime: productionLocalModelManifest.runtime,
    thinking: false,
    grammar: SEMANTIC_MAPPER_GRAMMAR,
    grammarRoot: 'root',
    limits: SEMANTIC_MAPPER_LIMITS,
    context: SEMANTIC_MAPPER_CONTEXT,
    fixtures: productionV2Fixtures.map((fixture) => ({
      id: fixture.id,
      language: fixture.language,
      serializedInput: serializeSemanticMapperChunk(fixture.rows, fixture.language),
      expected: fixture.expected,
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void (async () => {
    const destination = resolve(argument('--output') ?? defaultOutput);
    const expected = await format(JSON.stringify(createProductionV2Contract()), { parser: 'json' });
    if (process.argv.includes('--check')) {
      let actual: string;
      try {
        actual = readFileSync(destination, 'utf8');
      } catch {
        throw new Error('production-v2-contract-missing');
      }
      try {
        if (JSON.stringify(JSON.parse(actual)) !== JSON.stringify(JSON.parse(expected))) {
          throw new Error('production-v2-contract-drift');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'production-v2-contract-drift') throw error;
        throw new Error('production-v2-contract-drift');
      }
    } else {
      writeFileSync(destination, expected, { encoding: 'utf8', mode: 0o600 });
    }
  })();
}

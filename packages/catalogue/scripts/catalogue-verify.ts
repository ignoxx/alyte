import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateCatalogueArtifact,
  type CatalogueArtifact,
  type CatalogueEnvironment,
  type CatalogueTrustedKey,
} from '../src/index';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const input = option('--in');
if (input === undefined)
  throw new Error('usage: --in artifact.json [--environment development|test|production|release]');
const environment = (option('--environment') ?? 'test') as CatalogueEnvironment;
const trustedPath = option('--trusted-keys');
const trustedKeysJson =
  trustedPath === undefined
    ? process.env.ALYTE_CATALOGUE_TRUSTED_KEYS
    : await readFile(resolve(trustedPath), 'utf8');
const trustedKeys =
  trustedKeysJson === undefined
    ? undefined
    : (JSON.parse(trustedKeysJson) as readonly CatalogueTrustedKey[]);
const artifact = JSON.parse(await readFile(resolve(input), 'utf8')) as CatalogueArtifact;
const result = await validateCatalogueArtifact(artifact, {
  environment,
  trustedKeys,
});
if (!result.ok) {
  console.error(`Catalogue verification failed: ${result.reason}`);
  process.exitCode = 1;
} else {
  console.error(
    `Catalogue verification passed (${result.signed ? 'signed' : 'development-unsigned'}).`,
  );
}

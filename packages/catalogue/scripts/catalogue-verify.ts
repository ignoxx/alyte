import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateCatalogueArtifact,
  type CatalogueArtifact,
  type CatalogueTrustedKey,
} from '../src/index';

const ENVIRONMENTS = ['development', 'test', 'production', 'release'] as const;
type VerifyEnvironment = (typeof ENVIRONMENTS)[number];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function assertKnownOptions(options: readonly string[]): void {
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--') && !options.includes(argument))
      throw new Error(`unknown catalogue verify option: ${argument}`);
  }
}

function environmentOption(): VerifyEnvironment {
  const value = option('--environment');
  if (value === undefined) return 'test';
  if (!ENVIRONMENTS.includes(value as VerifyEnvironment))
    throw new Error(`--environment must be one of: ${ENVIRONMENTS.join('|')}`);
  return value as VerifyEnvironment;
}

const input = option('--in');
assertKnownOptions(['--in', '--environment', '--trusted-keys']);
if (input === undefined)
  throw new Error('usage: --in artifact.json [--environment development|test|production|release]');
const environment = environmentOption();
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
  ...(trustedKeys === undefined ? {} : { trustedKeys }),
});
if (!result.ok) {
  console.error(`Catalogue verification failed: ${result.reason}`);
  process.exitCode = 1;
} else {
  console.error(
    `Catalogue verification passed (${result.signed ? 'signed' : 'development-unsigned'}).`,
  );
}

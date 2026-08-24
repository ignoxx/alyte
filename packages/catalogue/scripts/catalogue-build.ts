import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CATALOGUE_ARTIFACT_SCHEMA_VERSION, catalogueManifest } from '../src/schema';
import { createCatalogueArtifact, validateCatalogueArtifact } from '../src/artifact';
import type { CatalogueArtifact, CatalogueTrustedKey } from '../src/schema';
import { sourceCatalogue } from '../src/source';
import {
  renderGeneratedCatalogueJson,
  renderGeneratedCatalogueModule,
} from './catalogue-generation';

type BuildMode = 'development' | 'release';
const BUILD_MODES = ['development', 'release'] as const satisfies readonly BuildMode[];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function assertKnownOptions(options: readonly string[]): void {
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--') && !options.includes(argument))
      throw new Error(`unknown catalogue build option: ${argument}`);
  }
}

function enumOption<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = option(name);
  if (value === undefined) return fallback;
  if (!values.includes(value as T)) throw new Error(`${name} must be one of: ${values.join('|')}`);
  return value as T;
}

function trustedKeysFromEnvironment(): readonly CatalogueTrustedKey[] | undefined {
  const value = process.env.ALYTE_CATALOGUE_TRUSTED_KEYS;
  if (value === undefined) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('ALYTE_CATALOGUE_TRUSTED_KEYS must be a JSON array');
  return parsed as readonly CatalogueTrustedKey[];
}

async function main(): Promise<void> {
  assertKnownOptions(['--mode', '--in', '--out', '--json-out']);
  const mode = enumOption('--mode', BUILD_MODES, 'development');
  const input = option('--in');
  const output = resolve(process.cwd(), option('--out') ?? 'src/generated/catalogue-artifact.ts');
  const jsonOutput = resolve(process.cwd(), option('--json-out') ?? 'dist/catalogue.artifact.json');
  const trustedKeys = trustedKeysFromEnvironment();
  let artifact: CatalogueArtifact;

  if (input !== undefined) {
    artifact = JSON.parse(
      await readFile(resolve(process.cwd(), input), 'utf8'),
    ) as CatalogueArtifact;
  } else {
    if (mode === 'release') throw new Error('release build requires signed trusted input via --in');
    artifact = await createCatalogueArtifact(sourceCatalogue, catalogueManifest);
  }

  const verificationOptions = {
    environment: mode,
    ...(trustedKeys === undefined ? {} : { trustedKeys }),
  };
  const verification = await validateCatalogueArtifact(artifact, verificationOptions);
  if (!verification.ok) throw new Error(`Catalogue ${mode} build refused: ${verification.reason}`);

  // Verify the exact artifact immediately before emitting either representation. A release cannot
  // be validated as development content and relabelled after generation.
  const finalVerification = await validateCatalogueArtifact(artifact, verificationOptions);
  if (!finalVerification.ok)
    throw new Error(`Catalogue ${mode} emission refused: ${finalVerification.reason}`);

  const generated = renderGeneratedCatalogueModule(artifact);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, generated, 'utf8');
  await mkdir(dirname(jsonOutput), { recursive: true });
  await writeFile(jsonOutput, renderGeneratedCatalogueJson(artifact), 'utf8');
  console.error(
    `Catalogue ${mode} artifact (${CATALOGUE_ARTIFACT_SCHEMA_VERSION}) emitted to ${output} and ${jsonOutput}`,
  );
}

await main();

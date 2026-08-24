import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCatalogueArtifact } from '../src/artifact';
import { catalogueManifest } from '../src/schema';
import { sourceCatalogue } from '../src/source';
import { renderGeneratedCatalogueModule } from './catalogue-generation';

const generatedPath = resolve(process.cwd(), 'src/generated/catalogue-artifact.ts');
const artifact = await createCatalogueArtifact(sourceCatalogue, catalogueManifest);
const expected = renderGeneratedCatalogueModule(artifact);
const actual = await readFile(generatedPath, 'utf8');

if (actual !== expected) {
  throw new Error(
    `Generated catalogue is stale or tampered: regenerate with npm run catalogue:build --workspace=@alyte/catalogue (${generatedPath})`,
  );
}

console.error(`Generated catalogue freshness verified: ${generatedPath}`);

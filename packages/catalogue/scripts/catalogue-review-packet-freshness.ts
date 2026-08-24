import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCatalogueArtifact } from '../src/artifact';
import { catalogueManifest } from '../src/schema';
import { sourceCatalogue } from '../src/source';
import { renderGeneratedCatalogueModule } from './catalogue-generation';
import { renderCatalogueReviewPacket } from './catalogue-review-packet-generation';

const generatedPath = resolve(process.cwd(), 'src/generated/catalogue-artifact.ts');
const packetPath = resolve(process.cwd(), 'review/catalogue-review-packet.md');
const artifact = await createCatalogueArtifact(sourceCatalogue, catalogueManifest);
const generatedExpected = renderGeneratedCatalogueModule(artifact);
const generatedActual = await readFile(generatedPath, 'utf8');
if (generatedActual !== generatedExpected) {
  throw new Error(
    `Generated catalogue is stale or tampered: regenerate with npm run catalogue:build --workspace=@alyte/catalogue (${generatedPath})`,
  );
}

const packetExpected = renderCatalogueReviewPacket(artifact);
const packetActual = await readFile(packetPath, 'utf8');
if (packetActual !== packetExpected) {
  throw new Error(
    `Catalogue review packet is stale: regenerate with npm run catalogue:review-packet --workspace=@alyte/catalogue (${packetPath})`,
  );
}

console.error(`Catalogue review packet freshness verified: ${packetPath}`);

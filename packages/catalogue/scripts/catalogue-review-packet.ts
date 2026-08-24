import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createCatalogueArtifact } from '../src/artifact';
import { catalogueManifest } from '../src/schema';
import { sourceCatalogue } from '../src/source';
import { renderCatalogueReviewPacket } from './catalogue-review-packet-generation';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--') && argument !== '--out')
    throw new Error(`unknown catalogue review packet option: ${argument}`);
}

const output = resolve(process.cwd(), option('--out') ?? 'review/catalogue-review-packet.md');
const artifact = await createCatalogueArtifact(sourceCatalogue, catalogueManifest);
const packet = renderCatalogueReviewPacket(artifact);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, packet, 'utf8');
console.error(`Catalogue review packet emitted to ${output}`);

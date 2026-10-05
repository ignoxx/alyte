import { mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { modelRoot, digest } from './paddle';
import { productionLocalModelManifest as manifest } from '../mobile/src/features/local-models/production-manifest.generated';
await mkdir(modelRoot, { recursive: true, mode: 0o700 });
for (const artifact of [manifest.pack.artifact, manifest.pack.projector]) {
  const destination = join(modelRoot, artifact.filename);
  if ((await digest(destination).catch(() => '')) === artifact.sha256) continue;
  process.stdout.write(
    `Downloading ${artifact.filename} (${Math.round(artifact.bytes / 1e6)} MB)\n`,
  );
  const partial = destination + '.partial';
  try {
    const response = await fetch(artifact.url);
    if (!response.ok || !response.body) throw new Error('Model download failed');
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(partial, { mode: 0o600 }),
    );
    if ((await digest(partial)) !== artifact.sha256) throw new Error('Model checksum mismatch');
    await rename(partial, destination);
  } finally {
    await rm(partial, { force: true });
  }
}
process.stdout.write('PaddleOCR model files verified.\n');

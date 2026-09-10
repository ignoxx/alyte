import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  assertLocalModelManifest,
  LOCAL_MODEL_PACK_ID,
  productionLocalModelManifest,
} from './manifest';

const mobileRoot = process.cwd().endsWith('apps/mobile')
  ? process.cwd()
  : resolve(process.cwd(), 'apps/mobile');

test('generated TypeScript manifest decodes exactly from the authoritative production source', () => {
  const source = JSON.parse(
    readFileSync(
      resolve(mobileRoot, 'modules/alyte-local-models/manifest/production.json'),
      'utf8',
    ),
  );
  assert.deepEqual(productionLocalModelManifest, source);
});

test('production model manifest pins the complete public PaddleOCR-VL pack and runtime', () => {
  assert.doesNotThrow(() => assertLocalModelManifest());
  assert.equal(productionLocalModelManifest.pack.id, LOCAL_MODEL_PACK_ID);
  assert.equal(productionLocalModelManifest.pack.artifact.bytes, 498_316_256);
  assert.equal(productionLocalModelManifest.pack.projector.bytes, 881_770_560);
  assert.equal(productionLocalModelManifest.pack.bytes, 1_380_086_816);
  assert.equal(
    productionLocalModelManifest.pack.source.repository,
    'SanjeevSOLANKI/PaddleOCR-VL-1.6-GGUF',
  );
  assert.equal(productionLocalModelManifest.pack.quantization, 'Q8_0 + F16 projector');
  assert.deepEqual(productionLocalModelManifest.compatibility.languages, ['en', 'de', 'lt']);
  assert.equal(
    productionLocalModelManifest.compatibility.promptBundle,
    'alyte.document-ocr.raw.v1',
  );
  assert.equal(productionLocalModelManifest.compatibility.ocrChunk, 'alyte.document-band.v1');
  assert.equal(
    productionLocalModelManifest.compatibility.semanticSchema,
    'alyte.paddleocr-vl.flat-rows.v1',
  );
  assert.equal(
    productionLocalModelManifest.pack.artifact.sha256,
    '2bda93a416339f2d9f06accae505600544a9e72cc159d0cd1af4c0f679866e1c',
  );
  assert.equal(productionLocalModelManifest.pack.artifact.url.includes('/main/'), false);
  assert.equal(
    productionLocalModelManifest.pack.projector.sha256,
    '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a',
  );
  assert.deepEqual(productionLocalModelManifest.allowlist.files, [
    'PaddleOCR-VL-1.6-Q8_0.gguf',
    'PaddleOCR-VL-1.6-mmproj.gguf',
  ]);
});

test('generated manifest retains the exact reviewed Hugging Face download host list', () => {
  assert.deepEqual(productionLocalModelManifest.allowlist.hosts, [
    'huggingface.co',
    'cdn-lfs.huggingface.co',
    'cdn-lfs-us-1.hf.co',
    'cdn-lfs-eu-1.hf.co',
    'cdn-lfs.hf.co',
    'cas-bridge.xethub.hf.co',
    'us.aws.cdn.hf.co',
    'us.gcp.cdn.hf.co',
    'cas-server.xethub.hf.co',
    'cas-server.xethub-eu.hf.co',
    'transfer.xethub.hf.co',
    'transfer.xethub-eu.hf.co',
  ]);
});

test('manifest rejects moving revisions, arbitrary hosts, and unlisted files', () => {
  const moving = {
    ...productionLocalModelManifest,
    pack: {
      ...productionLocalModelManifest.pack,
      artifact: {
        ...productionLocalModelManifest.pack.artifact,
        url: productionLocalModelManifest.pack.artifact.url.replace(
          productionLocalModelManifest.pack.artifact.revision,
          'main',
        ),
      },
    },
  };
  assert.throws(() => assertLocalModelManifest(moving as never), /immutable|artifact_url/i);
  const otherPinnedRevision = {
    ...productionLocalModelManifest,
    pack: {
      ...productionLocalModelManifest.pack,
      source: {
        ...productionLocalModelManifest.pack.source,
        revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
  };
  assert.throws(() => assertLocalModelManifest(otherPinnedRevision as never), /exact|immutable/i);
  const otherHash = {
    ...productionLocalModelManifest,
    pack: {
      ...productionLocalModelManifest.pack,
      artifact: {
        ...productionLocalModelManifest.pack.artifact,
        sha256: '0'.repeat(64),
      },
    },
  };
  assert.throws(() => assertLocalModelManifest(otherHash as never), /integrity/i);
  const arbitraryHost = {
    ...productionLocalModelManifest,
    pack: {
      ...productionLocalModelManifest.pack,
      artifact: {
        ...productionLocalModelManifest.pack.artifact,
        url: productionLocalModelManifest.pack.artifact.url.replace(
          'huggingface.co',
          'example.com',
        ),
      },
    },
  };
  assert.throws(() => assertLocalModelManifest(arbitraryHost as never), /public|immutable/i);
  const unlistedFile = {
    ...productionLocalModelManifest,
    allowlist: { ...productionLocalModelManifest.allowlist, files: ['other.gguf'] },
  };
  assert.throws(() => assertLocalModelManifest(unlistedFile as never), /allowlisted|artifact/i);
});

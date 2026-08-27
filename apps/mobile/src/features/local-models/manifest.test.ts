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

test('production model manifest pins one public Gemma artifact and runtime', () => {
  assert.doesNotThrow(() => assertLocalModelManifest());
  assert.equal(productionLocalModelManifest.pack.id, LOCAL_MODEL_PACK_ID);
  assert.equal(productionLocalModelManifest.pack.artifact.bytes, 2_841_481_184);
  assert.equal(
    productionLocalModelManifest.compatibility.promptBundle,
    'alyte.semantic-mapper.prompt.v5',
  );
  assert.equal(productionLocalModelManifest.compatibility.ocrChunk, 'alyte.semantic-ocr-chunk.v3');
  assert.equal(
    productionLocalModelManifest.compatibility.semanticSchema,
    'alyte.semantic-mapper.v2',
  );
  assert.equal(
    productionLocalModelManifest.pack.artifact.sha256,
    '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
  );
  assert.equal(productionLocalModelManifest.pack.artifact.url.includes('/main/'), false);
  assert.deepEqual(productionLocalModelManifest.allowlist.files, ['gemma-4-E2B-it-Q4_0.gguf']);
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

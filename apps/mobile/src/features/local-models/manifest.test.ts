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

test('production model manifest pins the complete public Qwen VLM pack and runtime', () => {
  assert.doesNotThrow(() => assertLocalModelManifest());
  assert.equal(productionLocalModelManifest.pack.id, LOCAL_MODEL_PACK_ID);
  assert.equal(productionLocalModelManifest.pack.artifact.bytes, 1_107_409_952);
  assert.equal(productionLocalModelManifest.pack.projector.bytes, 445_053_216);
  assert.equal(productionLocalModelManifest.pack.bytes, 1_552_463_168);
  assert.deepEqual(productionLocalModelManifest.compatibility.languages, ['en', 'de']);
  assert.equal(
    productionLocalModelManifest.compatibility.promptBundle,
    'alyte.document-vlm.prompt.v1',
  );
  assert.equal(productionLocalModelManifest.compatibility.ocrChunk, 'alyte.document-band.v1');
  assert.equal(
    productionLocalModelManifest.compatibility.semanticSchema,
    'alyte.document-vlm.flat-rows.v1',
  );
  assert.equal(
    productionLocalModelManifest.pack.artifact.sha256,
    '089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae',
  );
  assert.equal(productionLocalModelManifest.pack.artifact.url.includes('/main/'), false);
  assert.equal(
    productionLocalModelManifest.pack.projector.sha256,
    'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82',
  );
  assert.deepEqual(productionLocalModelManifest.allowlist.files, [
    'Qwen3VL-2B-Instruct-Q4_K_M.gguf',
    'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
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

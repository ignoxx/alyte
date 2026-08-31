import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isExternalAggregatePath,
  loopbackModelPreflight,
  loopbackTransport,
} from './model-evaluation-runner';
import { EXPECTED_MODEL, verifyExternalArtifact } from './model-evaluation-prepare';

test('model preparation fails closed for missing, wrong, or repository-local artifacts', async () => {
  await assert.rejects(
    verifyExternalArtifact('/tmp/not-the-pinned-model.gguf'),
    /model-preparation-failed:missing/,
  );
  const external = mkdtempSync(join(tmpdir(), 'alyte-evaluation-'));
  const wrong = join(external, 'gemma-4-E2B-it-Q4_0.gguf');
  writeFileSync(wrong, 'synthetic fixture bytes');
  await assert.rejects(verifyExternalArtifact(wrong), /model-preparation-failed:size/);
});

test('model preparation rejects symlink escapes and preserves bounded output-path checks', async () => {
  const external = mkdtempSync(join(tmpdir(), 'alyte-evaluation-links-'));
  const link = join(external, 'gemma-4-E2B-it-Q4_0.gguf');
  symlinkSync('/etc/hosts', link);
  await assert.rejects(verifyExternalArtifact(link), /model-preparation-failed:path/);
});

test('Ollama preflight never accepts a digest outside the exact FROM blob line', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const preflight = loopbackModelPreflight();
    const respond = (body: unknown) => {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      return preflight();
    };
    await assert.rejects(
      respond({ digest: `sha256-${EXPECTED_MODEL.sha256}`, modelfile: 'FROM /blobs/sha256-wrong' }),
      /ollama-identity/u,
    );
    await assert.rejects(
      respond({
        modelfile: `FROM /ollama/blobs/sha256-${EXPECTED_MODEL.sha256}-suffix`,
      }),
      /ollama-identity/u,
    );
    await assert.rejects(
      respond({
        modelfile: `# sha256-${EXPECTED_MODEL.sha256}\nFROM /ollama/blobs/sha256-wrong`,
      }),
      /ollama-identity/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('aggregate output accepts only an explicitly external safe filename', () => {
  assert.equal(isExternalAggregatePath('/tmp/model-evaluation-aggregate-gemma-v2.json'), true);
  assert.equal(isExternalAggregatePath('/tmp/health-export.json'), false);
  assert.equal(
    isExternalAggregatePath('packages/model-evaluation/model-evaluation-aggregate.json'),
    false,
  );
});

test('Ollama transport rejects non-loopback endpoints before sending a request', () => {
  assert.throws(() => loopbackTransport('https://example.invalid/api/generate'), /loopback-only/);
  assert.throws(() => loopbackTransport('not-an-endpoint'), /endpoint/);
});

test('Ollama preflight binds the fixed alias to actual pinned model metadata', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const preflight = loopbackModelPreflight();
    let requestedUrl = '';
    let requestedBody = '';
    const respond = (body: unknown, status = 200) => {
      globalThis.fetch = async (input, init) => {
        requestedUrl = String(input);
        requestedBody = String(init?.body);
        return new Response(JSON.stringify(body), { status });
      };
      return preflight();
    };
    await assert.rejects(
      respond({ modelfile: 'FROM /ollama/blobs/sha256-wrong-sha256' }),
      /ollama-identity/,
    );
    await assert.rejects(respond({ details: { format: 'gguf' } }), /ollama-identity/);
    await assert.doesNotReject(
      respond({
        modelfile: `FROM /ollama/blobs/sha256-${EXPECTED_MODEL.sha256}`,
        details: {
          format: 'gguf',
          quantization_level: 'Q4_0',
        },
      }),
    );
    assert.equal(requestedUrl, 'http://127.0.0.1:11434/api/show');
    assert.deepEqual(JSON.parse(requestedBody), {
      name: 'alyte-gemma-4-e2b-evaluation-v2',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

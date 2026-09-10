import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parsePipelineResult,
  readJsonFile,
  sha256File,
  writeJsonFile,
  type PipelineResult,
} from './contract';
import { createRawSnapshotBinding, type RawSnapshotIdentity } from './raw-snapshot-binding';
import { runGrounding } from './qwen35-grounding-run';

const REPORT_HASH = '1'.repeat(64);
const identity: RawSnapshotIdentity = {
  reportSha256: REPORT_HASH,
  readerVersion: 'alyte.mac.vision-reader.test.v1',
  runtimeVersion: 'test-runtime.v1',
  readerBinarySha256: '2'.repeat(64),
  readerSourceSha256: '3'.repeat(64),
};

function proposals(): PipelineResult {
  return {
    schemaVersion: 'alyte.import-eval.v1',
    reportId: 'synthetic',
    reportSha256: REPORT_HASH,
    pipeline: {
      id: 'synthetic-proposals',
      version: 'test.v1',
      configuration: {},
      runtime: {},
    },
    stages: [],
    elapsedMs: 12.5,
    measurements: [
      {
        id: 'proposal-1',
        sourceLabel: 'Analyte',
        valueString: '42',
        valueType: 'numeric',
        parsedValue: 42,
        comparator: null,
        unit: null,
        referenceInterval: null,
        flag: null,
        collectionDate: null,
        collectionGroup: null,
        specimen: null,
        page: 1,
        location: null,
        ambiguousFields: [],
      },
    ],
    diagnostics: { counts: {}, limitations: [] },
  };
}

function fixture(): {
  readonly root: string;
  readonly proposalsPath: string;
  readonly visionPath: string;
  readonly bindingPath: string;
  readonly outputPath: string;
  readonly rawText: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'alyte-grounding-run-'));
  chmodSync(root, 0o700);
  const proposalsPath = join(root, 'proposals.json');
  const visionPath = join(root, 'vision.json');
  const bindingPath = join(root, 'vision.binding.json');
  const outputPath = join(root, 'grounded.json');
  writeJsonFile(proposalsPath, proposals());
  const rawText = `${JSON.stringify({
    ...identity,
    pageCount: 1,
    pages: [
      {
        pageIndex: 0,
        result: {
          observations: [
            {
              id: 'label',
              text: 'Analyte',
              pageIndex: 0,
              boundingBox: { x: 0.1, y: 0.2, width: 0.1, height: 0.01 },
            },
            {
              id: 'value',
              text: '42',
              pageIndex: 0,
              boundingBox: { x: 0.4, y: 0.2, width: 0.1, height: 0.01 },
            },
          ],
        },
      },
    ],
  })}\n`;
  writeFileSync(visionPath, rawText, { encoding: 'utf8', mode: 0o600 });
  chmodSync(visionPath, 0o600);
  writeJsonFile(bindingPath, createRawSnapshotBinding(rawText, identity));
  return { root, proposalsPath, visionPath, bindingPath, outputPath, rawText };
}

function run(fixtureValue: ReturnType<typeof fixture>) {
  return runGrounding({
    proposalsPath: fixtureValue.proposalsPath,
    visionPath: fixtureValue.visionPath,
    outputPath: fixtureValue.outputPath,
    privateRoot: fixtureValue.root,
  });
}

function fixtureWithCollectionDate(): ReturnType<typeof fixture> {
  const value = fixture();
  const artifact = JSON.parse(value.rawText) as {
    pages: Array<{ result: { observations: Array<Record<string, unknown>> } }>;
  };
  artifact.pages[0]!.result.observations.push({
    id: 'date-header',
    text: 'Date Collected: 2025-04-01',
    pageIndex: 0,
    boundingBox: { x: 0.1, y: 0.05, width: 0.3, height: 0.02 },
  });
  const rawText = `${JSON.stringify(artifact)}\n`;
  writeFileSync(value.visionPath, rawText, { encoding: 'utf8', mode: 0o600 });
  chmodSync(value.visionPath, 0o600);
  writeJsonFile(value.bindingPath, createRawSnapshotBinding(rawText, identity));
  return { ...value, rawText };
}

test('verifies the sibling binding and records native/script provenance', () => {
  const value = fixture();
  const result = run(value);
  const sourceSnapshot = result.pipeline.configuration.sourceSnapshot as Record<string, unknown>;
  const groundingScript = result.pipeline.configuration.groundingScript as Record<string, unknown>;
  assert.equal(result.diagnostics.counts.sourceGroundingAccepted, 1);
  const bindingStage = result.stages.find((stage) => stage.name === 'source-binding-verification');
  const groundingStage = result.stages.find((stage) => stage.name === 'source-grounding');
  const metadataProposalStage = result.stages.find((stage) => stage.name === 'metadata-proposals');
  const metadataAttachmentStage = result.stages.find(
    (stage) => stage.name === 'metadata-attachment',
  );
  assert.ok(bindingStage !== undefined && bindingStage.elapsedMs >= 0);
  assert.ok(groundingStage !== undefined && groundingStage.elapsedMs >= 0);
  assert.ok(metadataProposalStage !== undefined && metadataProposalStage.elapsedMs >= 0);
  assert.ok(metadataAttachmentStage !== undefined && metadataAttachmentStage.elapsedMs >= 0);
  assert.ok(result.elapsedMs >= proposals().elapsedMs);
  assert.equal(
    sourceSnapshot.snapshotSha256,
    createRawSnapshotBinding(value.rawText, identity).snapshotSha256,
  );
  assert.equal(sourceSnapshot.reportSha256, REPORT_HASH);
  assert.equal(groundingScript.version, 'qwen35-grounding-run.v2');
  assert.match(String(groundingScript.scriptSha256), /^[a-f0-9]{64}$/u);
  assert.match(String(groundingScript.algorithmSha256), /^[a-f0-9]{64}$/u);
  const metadataConfig = result.pipeline.configuration.collectionDateMetadata as Record<
    string,
    unknown
  >;
  assert.equal(metadataConfig.schemaVersion, 'alyte.import-eval.collection-date-metadata.v1');
  assert.match(String(metadataConfig.algorithmSha256), /^[a-f0-9]{64}$/u);
  assert.match(String(metadataConfig.artifactSha256), /^[a-f0-9]{64}$/u);
  assert.equal(
    metadataConfig.artifactSha256,
    sha256File(join(value.root, 'grounded.collection-date-metadata.json')),
  );
  assert.equal(readJsonFile(value.outputPath) !== null, true);
});

test('attaches a private source-grounded page date and records its artifact binding', () => {
  const value = fixtureWithCollectionDate();
  const result = run(value);
  const attached = result.measurements[0]!;
  assert.equal(attached.collectionDate, '2025-04-01');
  assert.equal(attached.collectionGroup, null);
  assert.ok(attached.sourceIds?.includes('date-header'));
  assert.equal(result.diagnostics.counts.collectionDateMetadataAttached, 1);
  assert.equal(result.diagnostics.counts.collectionDateMetadataKnownPageContexts, 1);
  const artifact = readJsonFile(
    join(value.root, 'grounded.collection-date-metadata.json'),
  ) as Record<string, unknown>;
  assert.equal(artifact.schemaVersion, 'alyte.import-eval.collection-date-metadata.v1');
  assert.equal(artifact.reportSha256, REPORT_HASH);
  assert.equal((artifact.metadata as Record<string, unknown>).pageContexts !== undefined, true);
});

test('replay strips prior postprocess stages, metadata, and elapsed time before recomputing', () => {
  const value = fixture();
  run(value);
  const replayOutputPath = join(value.root, 'replayed.json');
  const replay = runGrounding({
    proposalsPath: value.outputPath,
    visionPath: value.visionPath,
    outputPath: replayOutputPath,
    privateRoot: value.root,
  });
  assert.equal(replay.stages.filter((stage) => stage.name === 'source-grounding').length, 1);
  assert.equal(replay.stages.filter((stage) => stage.name === 'metadata-proposals').length, 1);
  assert.equal(replay.stages.filter((stage) => stage.name === 'metadata-attachment').length, 1);
  const configuration = replay.pipeline.configuration as Record<string, unknown>;
  assert.ok(configuration.sourceSnapshot !== undefined);
  assert.ok(configuration.groundingScript !== undefined);
  assert.ok(configuration.collectionDateMetadata !== undefined);
  assert.equal(replay.diagnostics.counts.sourceGroundingAccepted, 1);
  assert.equal(replay.diagnostics.counts.collectionDateMetadataProposals, 0);
  assert.ok(replay.elapsedMs >= proposals().elapsedMs);
});

test('rejects a missing binding and changed raw content', () => {
  const missing = fixture();
  unlinkSync(missing.bindingPath);
  assert.throws(() => run(missing), /grounding-binding-missing/u);

  const changed = fixture();
  writeFileSync(changed.visionPath, `${changed.rawText} `, { encoding: 'utf8', mode: 0o600 });
  assert.throws(() => run(changed), /grounding-raw-snapshot-content-mismatch/u);

  const staleEnvelope = fixture();
  const staleBinding = readJsonFile(staleEnvelope.bindingPath) as Record<string, unknown>;
  writeJsonFile(staleEnvelope.bindingPath, { ...staleBinding, runtimeVersion: 'stale-runtime' });
  assert.throws(() => run(staleEnvelope), /grounding-raw-snapshot-envelope-binding-mismatch/u);

  const malformedIdentity = fixture();
  const malformedBinding = readJsonFile(malformedIdentity.bindingPath) as Record<string, unknown>;
  writeJsonFile(malformedIdentity.bindingPath, {
    ...malformedBinding,
    readerBinarySha256: 'invalid',
  });
  assert.throws(() => run(malformedIdentity), /grounding-raw-snapshot-reader-binary-hash-invalid/u);
});

test('rejects a native snapshot bound to a different proposal report', () => {
  const value = fixture();
  const mismatched = { ...proposals(), reportSha256: '4'.repeat(64) };
  writeJsonFile(value.proposalsPath, mismatched);
  assert.throws(() => run(value), /grounding-report-binding-mismatch/u);
});

test('CLI uses the default sibling binding and writes a parseable result', () => {
  const value = fixture();
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), 'qwen35-grounding-run.ts');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      runnerPath,
      '--proposals',
      value.proposalsPath,
      '--vision',
      value.visionPath,
      '--output',
      value.outputPath,
      '--private-root',
      value.root,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = parsePipelineResult(readJsonFile(value.outputPath));
  assert.equal(result.diagnostics.counts.sourceGroundingAccepted, 1);
  assert.equal(child.stderr, '');
});

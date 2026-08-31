import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSourceSelectorFormat,
  createSourceSelectorPrompt,
  mapSelectedSourceFields,
  runSourceSelectorAB,
  runSourceSelectorCandidate,
  runSourceSelectorLfm2Comparison,
  runSourceSelectorQwen3,
  serializeSourceSelectorChunk,
  SOURCE_SELECTOR_SCHEMA_VERSION,
  SOURCE_SELECTOR_CHUNK_VERSION,
  SOURCE_SELECTOR_FORMAT_MAX_ENCODED_BYTES,
  SOURCE_SELECTOR_LIMITS,
  SOURCE_SELECTOR_PROMPT_VERSION,
  sourceSelectorPromptFitsContext,
  sourceSelectorPromptTokenEstimate,
  validateSourceSelectorOutput,
  isSourceSelectorAggregatePath,
  writeSourceSelectorAggregate,
  loopbackCandidatePreflight,
  verifySourceSelectorArtifact,
} from './model-evaluation-source-selector';
import {
  candidateEvaluationManifests,
  lfm2_1_2bExtractEvaluationManifest,
  lfm2_350mExtractEvaluationManifest,
  qwen3EvaluationManifest,
  sourceSelectorCandidateManifests,
} from '../packages/model-evaluation/src/manifest';
import { productionV2Fixtures } from './model-evaluation-v2-fixtures';

const fixture = productionV2Fixtures[0]!;
const row = fixture.rows[0]!;

function responseFor(rowIndex = 0): string {
  return JSON.stringify({
    schemaVersion: SOURCE_SELECTOR_SCHEMA_VERSION,
    selections: [
      {
        rowKey: `r${rowIndex}`,
        labelKey: 'c0',
        valueKey: 'c1',
        unitKey: 'c2',
        referenceIntervalKey: 'c3',
        flagKey: null,
      },
    ],
  });
}

function schemaNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(schemaNodes);
  if (value === null || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [value, ...Object.values(object).flatMap(schemaNodes)];
}

test('source-selector transport contains only bounded row-local cell fields', () => {
  const format = createSourceSelectorFormat([row]);
  const properties = format.properties as Record<string, unknown>;
  assert.deepEqual(properties.schemaVersion, { const: SOURCE_SELECTOR_SCHEMA_VERSION });
  assert.deepEqual(Object.keys(properties), ['schemaVersion', 'selections']);
  for (const node of schemaNodes(format)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const keys = Object.keys(node as object);
    assert.equal(keys.includes('biomarkerId'), false);
    assert.equal(keys.includes('role'), false);
    assert.equal(keys.includes('specimenType'), false);
    assert.equal(keys.includes('sourceObservationIds'), false);
    assert.equal(keys.includes('value'), false);
    assert.equal(keys.includes('unit'), false);
  }
  const branches = (properties.selections as { items: { oneOf: readonly unknown[] } }).items.oneOf;
  assert.ok(branches.length > 0);
  for (const branch of branches) {
    const branchProperties = (branch as { properties: Record<string, { const?: unknown }> })
      .properties;
    const selected = Object.values(branchProperties)
      .map((property) => property.const)
      .filter((value): value is string => typeof value === 'string' && /^c\d+$/u.test(value));
    assert.equal(new Set(selected).size, selected.length);
  }
});

test('source-selector schema fails closed before oversized branch enumeration', () => {
  const wide = {
    ...row,
    rowId: 'wide',
    sourceObservationIds: Array.from({ length: 7 }, (_, index) => `wide-c${index}`),
    observations: Array.from({ length: 7 }, (_, index) => ({
      ...row.observations[index % row.observations.length]!,
      id: `wide-c${index}`,
    })),
  };
  assert.throws(
    () => createSourceSelectorFormat([wide]),
    /model-evaluation-failed:source-selector-schema/u,
  );
  const fiveCellRows = Array.from({ length: 2 }, (_, rowIndex) => ({
    ...row,
    rowId: `five-${rowIndex}`,
    sourceObservationIds: Array.from(
      { length: 5 },
      (_, cellIndex) => `five-${rowIndex}-c${cellIndex}`,
    ),
    observations: Array.from({ length: 5 }, (_, cellIndex) => ({
      ...row.observations[cellIndex % row.observations.length]!,
      id: `five-${rowIndex}-c${cellIndex}`,
    })),
  }));
  const format = createSourceSelectorFormat(fiveCellRows);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(format)).byteLength <=
      SOURCE_SELECTOR_FORMAT_MAX_ENCODED_BYTES,
  );
});

test('selector serializer omits source IDs and catalogue hints', () => {
  const serialized = serializeSourceSelectorChunk([row], 'en');
  assert.match(serialized, /"version":"alyte\.semantic-source-selector-chunk\.v1"/u);
  assert.equal(serialized.includes(row.sourceObservationIds[0]!), false);
  assert.equal(serialized.includes('biomarkerId'), false);
  assert.equal(serialized.includes('specimenType'), false);
  assert.equal(serialized.includes('role'), false);
});

test('Qwen3 uses the reviewed non-thinking raw ChatML template and pinned provenance', async () => {
  const serialized = serializeSourceSelectorChunk([row], 'en');
  const prompt = createSourceSelectorPrompt('qwen3', 'en-US', serialized);
  assert.match(prompt, /^<\|im_start\|>system/u);
  assert.match(prompt, /<\|im_start\|>assistant\n<think>\n\n<\/think>\n\n$/u);
  const requests: Array<Record<string, unknown>> = [];
  const directory = mkdtempSync(join(tmpdir(), 'alyte-qwen3-artifact-'));
  const artifactPath = join(directory, sourceSelectorCandidateManifests.qwen3.model.filename);
  writeFileSync(artifactPath, 'synthetic artifact seam');
  try {
    const report = await runSourceSelectorQwen3({
      modelAlias: 'qwen3-source-selector-test',
      artifactPath,
      artifactReader: {
        stat: () => ({
          isFile: () => true,
          size: sourceSelectorCandidateManifests.qwen3.model.bytes,
        }),
        sha256: async () => sourceSelectorCandidateManifests.qwen3.model.sha256,
      },
      fixtures: productionV2Fixtures,
      transport: async (request) => {
        requests.push(request as unknown as Record<string, unknown>);
        return responseFor();
      },
      capturedAt: () => '2026-08-30T00:00:00.000Z',
    });
    assert.equal(requests.length, 6);
    assert.equal(report.quality.expectedRows, 6);
    assert.equal(report.quality.selectedRows, 6);
    assert.equal(report.quality.supportedExpectedRows, 4);
    assert.equal(report.quality.unsupportedExpectedRows, 2);
    assert.equal(report.provenance.candidate, 'qwen3');
    assert.equal(report.provenance.modelId, 'qwen3-1.7b');
    assert.equal(report.provenance.modelFilename, 'Qwen3-1.7B-Q4_K_M.gguf');
    assert.equal(report.provenance.selectorPromptVersion, SOURCE_SELECTOR_PROMPT_VERSION);
    assert.equal(
      report.provenance.candidatePromptBundleVersion,
      sourceSelectorCandidateManifests.qwen3.promptBundleVersion,
    );
    assert.equal(
      report.provenance.modelSha256,
      sourceSelectorCandidateManifests.qwen3.model.sha256,
    );
    assert.equal(report.provenance.turnTemplate, 'qwen3-v1');
    const request = requests[0]!;
    assert.equal(request.raw, true);
    assert.equal(request.stream, false);
    assert.equal(request.think, false);
    assert.deepEqual(request.options, {
      num_ctx: 2_048,
      num_predict: 256,
      temperature: 0,
      top_p: 1,
    });
    assert.deepEqual(Object.keys(request.format as object).sort(), [
      'additionalProperties',
      'properties',
      'required',
      'type',
    ]);
    assert.match(request.prompt as string, /<\|im_start\|>assistant\n<think>\n\n<\/think>\n\n$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Qwen3 artifact verification fails closed on basename, bytes, hash, and symlink', async () => {
  const expected = sourceSelectorCandidateManifests.qwen3.model;
  const directory = mkdtempSync(join(tmpdir(), 'alyte-qwen3-identity-'));
  const validPath = join(directory, expected.filename);
  const wrongNamePath = join(directory, 'wrong.gguf');
  writeFileSync(validPath, 'synthetic artifact seam');
  writeFileSync(wrongNamePath, 'synthetic artifact seam');
  let symlinkDirectory: string | undefined;
  const validReader = {
    stat: () => ({ isFile: () => true, size: expected.bytes }),
    sha256: async () => expected.sha256,
  };
  try {
    await assert.doesNotReject(verifySourceSelectorArtifact(validPath, 'qwen3', validReader));
    await assert.rejects(
      verifySourceSelectorArtifact(wrongNamePath, 'qwen3', validReader),
      /model-preparation-failed:filename/u,
    );
    await assert.rejects(
      verifySourceSelectorArtifact(validPath, 'qwen3', {
        ...validReader,
        stat: () => ({ isFile: () => true, size: expected.bytes - 1 }),
      }),
      /model-preparation-failed:size/u,
    );
    await assert.rejects(
      verifySourceSelectorArtifact(validPath, 'qwen3', {
        ...validReader,
        sha256: async () => '0'.repeat(64),
      }),
      /model-preparation-failed:sha256/u,
    );
    symlinkDirectory = mkdtempSync(join(tmpdir(), 'alyte-qwen3-symlink-'));
    const symlinkPath = join(symlinkDirectory, expected.filename);
    symlinkSync(validPath, symlinkPath);
    await assert.rejects(
      verifySourceSelectorArtifact(symlinkPath, 'qwen3', validReader),
      /model-preparation-failed:path/u,
    );
  } finally {
    if (symlinkDirectory !== undefined) rmSync(symlinkDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('LFM2 comparison runs the Qwen3 control then both candidates over all six fixtures', async () => {
  const candidates = [
    qwen3EvaluationManifest,
    lfm2_350mExtractEvaluationManifest,
    lfm2_1_2bExtractEvaluationManifest,
  ] as const;
  const directory = mkdtempSync(join(tmpdir(), 'alyte-lfm2-artifacts-'));
  const requests: Array<Record<string, unknown>> = [];
  try {
    const options = candidates.map((manifest) => ({
      modelAlias: `${manifest.model.id}-test`,
      artifactPath: join(directory, manifest.model.filename),
      artifactReader: {
        stat: () => ({ isFile: () => true, size: manifest.model.bytes }),
        sha256: async () => manifest.model.sha256,
      },
      transport: async (request: unknown) => {
        requests.push(request as Record<string, unknown>);
        return responseFor();
      },
      capturedAt: () => '2026-08-30T00:00:00.000Z',
    }));
    for (const option of options) writeFileSync(option.artifactPath, 'synthetic artifact seam');
    const report = await runSourceSelectorLfm2Comparison({
      qwen3: options[0]!,
      lfm2_350m: options[1]!,
      lfm2_1_2b: options[2]!,
    });
    assert.deepEqual(Object.keys(report).sort(), [
      'lfm2_1_2b_extract',
      'lfm2_350m_extract',
      'qwen3_control',
      'reportVersion',
    ]);
    assert.deepEqual(
      requests.map((request) => request.model),
      [
        ...Array(6).fill('qwen3-1.7b-test'),
        ...Array(6).fill('lfm2-350m-extract-test'),
        ...Array(6).fill('lfm2-1.2b-extract-test'),
      ],
    );
    for (const [key, manifest] of [
      ['qwen3_control', qwen3EvaluationManifest],
      ['lfm2_350m_extract', lfm2_350mExtractEvaluationManifest],
      ['lfm2_1_2b_extract', lfm2_1_2bExtractEvaluationManifest],
    ] as const) {
      const candidate = report[key];
      assert.equal(candidate.quality.expectedRows, 6);
      assert.equal(candidate.quality.selectedRows, 6);
      assert.equal(candidate.provenance.selectorPromptVersion, SOURCE_SELECTOR_PROMPT_VERSION);
      assert.equal(candidate.provenance.candidatePromptBundleVersion, manifest.promptBundleVersion);
      assert.equal(
        candidate.provenance.modelLicense,
        manifest === qwen3EvaluationManifest ? 'Apache-2.0' : 'LFM-Open-License-v1.0',
      );
      assert.equal(candidate.provenance.modelQuantization, 'Q4_K_M');
      assert.equal(
        candidate.provenance.sourceModelRevision,
        manifest.sourceModel?.revision ?? null,
      );
      assert.equal(
        candidate.provenance.sourceModelChatTemplateUrl,
        manifest.sourceModel?.chatTemplateUrl ?? null,
      );
      assert.equal(
        candidate.provenance.turnTemplate,
        manifest === qwen3EvaluationManifest ? 'qwen3-v1' : 'lfm2-v1',
      );
    }
    for (const [index, request] of requests.entries()) {
      assert.equal(request.raw, true);
      assert.equal(request.stream, false);
      assert.equal(request.think, false);
      assert.deepEqual(request.options, {
        num_ctx: 2_048,
        num_predict: 256,
        temperature: 0,
        top_p: 1,
      });
      if (index < 6) {
        assert.match(
          request.prompt as string,
          /^<\|im_start\|>system[\s\S]*<think>\n\n<\/think>\n\n$/u,
        );
      } else {
        assert.match(
          request.prompt as string,
          /^<\|startoftext\|><\|im_start\|>system[\s\S]*<\|im_start\|>assistant\n$/u,
        );
        assert.equal((request.prompt as string).includes('<think>'), false);
      }
      assert.deepEqual(Object.keys(request.format as object).sort(), [
        'additionalProperties',
        'properties',
        'required',
        'type',
      ]);
    }
    assert.equal(JSON.stringify(report).includes('sourceObservationIds'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each LFM2 artifact identity gate rejects wrong bytes and hash before inference', async () => {
  const candidates = [
    ['lfm2-350m-extract', lfm2_350mExtractEvaluationManifest],
    ['lfm2-1.2b-extract', lfm2_1_2bExtractEvaluationManifest],
  ] as const;
  const directory = mkdtempSync(join(tmpdir(), 'alyte-lfm2-identity-'));
  try {
    for (const [candidate, manifest] of candidates) {
      const artifactPath = join(directory, manifest.model.filename);
      writeFileSync(artifactPath, 'synthetic artifact seam');
      const reader = {
        stat: () => ({ isFile: () => true, size: manifest.model.bytes }),
        sha256: async () => manifest.model.sha256,
      };
      await assert.doesNotReject(verifySourceSelectorArtifact(artifactPath, candidate, reader));
      const wrongNamePath = join(directory, `wrong-${manifest.model.filename}`);
      writeFileSync(wrongNamePath, 'synthetic artifact seam');
      await assert.rejects(
        verifySourceSelectorArtifact(wrongNamePath, candidate, reader),
        /model-preparation-failed:filename/u,
      );
      await assert.rejects(
        verifySourceSelectorArtifact(artifactPath, candidate, {
          ...reader,
          stat: () => ({ isFile: () => true, size: manifest.model.bytes - 1 }),
        }),
        /model-preparation-failed:size/u,
      );
      await assert.rejects(
        verifySourceSelectorArtifact(artifactPath, candidate, {
          ...reader,
          sha256: async () => '0'.repeat(64),
        }),
        /model-preparation-failed:sha256/u,
      );
      const symlinkDirectory = mkdtempSync(join(tmpdir(), 'alyte-lfm2-symlink-'));
      try {
        const symlinkPath = join(symlinkDirectory, manifest.model.filename);
        symlinkSync(artifactPath, symlinkPath);
        await assert.rejects(
          verifySourceSelectorArtifact(symlinkPath, candidate, reader),
          /model-preparation-failed:path/u,
        );
      } finally {
        rmSync(symlinkDirectory, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('three-arm comparison requires every control and candidate artifact before inference', async () => {
  const manifests = [
    qwen3EvaluationManifest,
    lfm2_350mExtractEvaluationManifest,
    lfm2_1_2bExtractEvaluationManifest,
  ] as const;
  const directory = mkdtempSync(join(tmpdir(), 'alyte-three-arm-identity-'));
  const requests: unknown[] = [];
  try {
    const options = manifests.map((manifest) => {
      const artifactPath = join(directory, manifest.model.filename);
      writeFileSync(artifactPath, 'synthetic artifact seam');
      return {
        modelAlias: `${manifest.model.id}-test`,
        artifactPath,
        artifactReader: {
          stat: () => ({ isFile: () => true, size: manifest.model.bytes }),
          sha256: async () => manifest.model.sha256,
        },
        transport: async (request: unknown) => {
          requests.push(request);
          return responseFor();
        },
      };
    });
    const input = () => ({
      qwen3: options[0]!,
      lfm2_350m: options[1]!,
      lfm2_1_2b: options[2]!,
    });
    await assert.rejects(
      runSourceSelectorLfm2Comparison({
        ...input(),
        qwen3: { ...options[0]!, artifactPath: undefined },
      } as never),
      /model-evaluation-failed:artifact-path/u,
    );
    for (const index of [0, 1, 2]) {
      requests.length = 0;
      const broken = options.map((option, optionIndex) =>
        optionIndex === index
          ? {
              ...option,
              artifactReader: {
                ...option.artifactReader,
                sha256: async () => '0'.repeat(64),
              },
            }
          : option,
      );
      await assert.rejects(
        runSourceSelectorLfm2Comparison({
          qwen3: broken[0]!,
          lfm2_350m: broken[1]!,
          lfm2_1_2b: broken[2]!,
        }),
        /model-evaluation-failed:artifact-identity/u,
      );
      assert.equal(requests.length, 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validator expands an accepted exact row-local selection', () => {
  const valid = validateSourceSelectorOutput(JSON.parse(responseFor()), [row]);
  assert.equal(valid.malformedEnvelope, false);
  assert.equal(valid.selections.length, 1);
  assert.deepEqual(valid.selections[0]?.sourceFields, {
    label: row.sourceObservationIds[0],
    value: row.sourceObservationIds[1],
    unit: row.sourceObservationIds[2],
    referenceInterval: row.sourceObservationIds[3],
    flag: null,
  });

  const duplicate = validateSourceSelectorOutput(
    {
      schemaVersion: SOURCE_SELECTOR_SCHEMA_VERSION,
      selections: [
        {
          rowKey: 'r0',
          labelKey: 'c0',
          valueKey: 'c0',
          unitKey: null,
          referenceIntervalKey: null,
          flagKey: null,
        },
      ],
    },
    [row],
  );
  assert.equal(duplicate.selections.length, 0);
  assert.ok(duplicate.failures.includes('duplicate-cell'));

  const second = {
    ...row,
    rowId: 'second',
    sourceObservationIds: row.sourceObservationIds.map((id) => `second-${id}`),
    observations: row.observations.map((observation) => ({
      ...observation,
      id: `second-${observation.id}`,
    })),
  };
  const addressedSecondRow = validateSourceSelectorOutput(
    {
      schemaVersion: SOURCE_SELECTOR_SCHEMA_VERSION,
      selections: [{ ...JSON.parse(responseFor()).selections[0], rowKey: 'r1' }],
    },
    [row, second],
  );
  assert.equal(addressedSecondRow.selections[0]?.rowId, 'second');
  assert.equal(addressedSecondRow.selections[0]?.sourceObservationIds[0], 'second-en-serum-ldl-c0');

  const missingCell = validateSourceSelectorOutput(
    {
      schemaVersion: SOURCE_SELECTOR_SCHEMA_VERSION,
      selections: [{ ...JSON.parse(responseFor()).selections[0], valueKey: 'c99' }],
    },
    [row],
  );
  assert.equal(missingCell.selections.length, 0);
  assert.ok(missingCell.failures.includes('unknown-cell-key'));

  const duplicateRow = validateSourceSelectorOutput(
    {
      schemaVersion: SOURCE_SELECTOR_SCHEMA_VERSION,
      selections: [
        JSON.parse(responseFor()).selections[0],
        JSON.parse(responseFor()).selections[0],
      ],
    },
    [row, second],
  );
  assert.equal(duplicateRow.selections.length, 0);
  assert.ok(duplicateRow.failures.includes('duplicate-row'));

  const duplicateMixed = validateSourceSelectorOutput(
    {
      schemaVersion: SOURCE_SELECTOR_SCHEMA_VERSION,
      selections: [
        JSON.parse(responseFor()).selections[0],
        { ...JSON.parse(responseFor()).selections[0], valueKey: 'c99' },
      ],
    },
    [row, second],
  );
  assert.equal(duplicateMixed.selections.length, 0);
  assert.ok(duplicateMixed.failures.includes('duplicate-row'));
});

test('deterministic mapping uses exact selected cells and preserves unsupported rows', () => {
  const selection = validateSourceSelectorOutput(JSON.parse(responseFor()), [row]).selections[0]!;
  const mapped = mapSelectedSourceFields(fixture, selection);
  assert.equal(mapped.parseSucceeded, true);
  assert.equal(mapped.canonicalBiomarkerId, 'biomarker.ldl_c');
  assert.equal(mapped.specimenType, 'serum');

  const unsupportedFixture = productionV2Fixtures[1]!;
  const unsupportedRow = unsupportedFixture.rows[0]!;
  const unsupportedSelection = validateSourceSelectorOutput(
    {
      schemaVersion: SOURCE_SELECTOR_SCHEMA_VERSION,
      selections: [
        {
          rowKey: 'r0',
          labelKey: 'c0',
          valueKey: 'c1',
          unitKey: 'c2',
          referenceIntervalKey: 'c3',
          flagKey: null,
        },
      ],
    },
    [unsupportedRow],
  ).selections[0]!;
  const preserved = mapSelectedSourceFields(unsupportedFixture, unsupportedSelection);
  assert.equal(preserved.canonicalBiomarkerId, null);
  assert.equal(preserved.reviewRequired, true);

  const wrongValue = mapSelectedSourceFields(fixture, {
    ...selection,
    sourceFields: { ...selection.sourceFields, value: row.sourceObservationIds[0] },
  });
  assert.equal(wrongValue.parseSucceeded, false);
  assert.equal(wrongValue.canonicalBiomarkerId, null);
});

test('scoring separates supported mapping accuracy from unsupported preservation and review burden', async () => {
  const report = await runSourceSelectorCandidate({
    candidate: 'qwen',
    modelAlias: 'qwen-source-selector-test',
    fixtures: [fixture, productionV2Fixtures[1]!],
    transport: async () => responseFor(),
    capturedAt: () => '2026-08-30T00:00:00.000Z',
  });
  const quality = report.quality;
  assert.equal(quality.supportedExpectedRows, 1);
  assert.equal(quality.supportedCorrectMappings, 1);
  assert.equal(quality.supportedDeterministicMappingAccuracy, 1);
  assert.equal(quality.unsupportedExpectedRows, 1);
  assert.equal(quality.unsupportedRowsPreserved, 1);
  assert.equal(quality.unsupportedExactPreservationAccuracy, 1);
  assert.ok(quality.reviewRows >= 1);
  for (const value of [
    quality.fullFieldRowAccuracy,
    quality.supportedDeterministicMappingAccuracy,
    quality.unsupportedExactPreservationAccuracy,
    quality.reviewBurdenRate,
    ...Object.values(quality.fieldSelectionAccuracy).map((field) => field.accuracy),
  ]) {
    assert.ok(value >= 0 && value <= 1);
  }
});

test('A/B runner records exact candidate identity and model-specific raw turn templates', async () => {
  const requests: Array<{ model: string; prompt: string }> = [];
  const transport = async (request: { model: string; prompt: string }) => {
    requests.push(request);
    return responseFor();
  };
  const report = await runSourceSelectorAB({
    qwen: {
      modelAlias: 'qwen-source-selector-test',
      transport,
      fixtures: [fixture],
      capturedAt: () => '2026-08-30T00:00:00.000Z',
    },
    gemma4: {
      modelAlias: 'gemma-source-selector-test',
      transport,
      fixtures: [fixture],
      capturedAt: () => '2026-08-30T00:00:00.000Z',
    },
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.prompt, /^<\|im_start\|>system/u);
  assert.match(requests[1]!.prompt, /^<bos><\|turn>system/u);
  assert.equal(report.qwen.provenance.modelFilename, 'Qwen3.5-0.8B-Q4_0.gguf');
  assert.equal(report.gemma4.provenance.modelFilename, 'gemma-4-E2B-it-Q4_0.gguf');
  assert.equal(report.qwen.quality.fullFieldRows, 1);
  assert.equal(report.gemma4.quality.supportedCorrectMappings, 1);
  for (const quality of [report.qwen.quality, report.gemma4.quality]) {
    for (const key of [
      'fullFieldRowAccuracy',
      'supportedDeterministicMappingAccuracy',
      'reviewBurdenRate',
    ] as const) {
      assert.ok(quality[key] >= 0 && quality[key] <= 1);
    }
    for (const field of [
      'labelKey',
      'valueKey',
      'unitKey',
      'referenceIntervalKey',
      'flagKey',
    ] as const) {
      assert.ok(quality.fieldSelectionAccuracy[field].correctRows >= 0);
      assert.ok(quality.fieldSelectionAccuracy[field].accuracy >= 0);
      assert.ok(quality.fieldSelectionAccuracy[field].accuracy <= 1);
    }
    assert.ok(quality.unsupportedExactPreservationAccuracy >= 0);
    assert.ok(quality.unsupportedExactPreservationAccuracy <= 1);
  }
  assert.equal(JSON.stringify(report).includes('sourceObservationIds'), false);
  assert.equal(JSON.stringify(report).includes('OCR chunk'), false);
  assert.equal(SOURCE_SELECTOR_CHUNK_VERSION, 'alyte.semantic-source-selector-chunk.v1');
});

test('runner rejects oversized model output before JSON parsing and retries once', async () => {
  let calls = 0;
  const report = await runSourceSelectorCandidate({
    candidate: 'qwen',
    modelAlias: 'qwen-source-selector-test',
    fixtures: [fixture],
    transport: async () => {
      calls += 1;
      return 'x'.repeat(8_193);
    },
    capturedAt: () => '2026-08-30T00:00:00.000Z',
  });
  assert.equal(calls, 2);
  assert.equal(report.retryCount, 1);
  assert.equal(report.quality.failureCounts['oversized-output'], 2);
  assert.equal(report.quality.selectedRows, 0);
  assert.ok(report.quality.reviewBurdenRate >= 0 && report.quality.reviewBurdenRate <= 1);
});

test('prompt budget is conservative, deterministic, and reserves output tokens', () => {
  const unicode = 'λ🙂漢字'.repeat(400);
  assert.ok(sourceSelectorPromptTokenEstimate(unicode) > 0);
  assert.equal(sourceSelectorPromptFitsContext(unicode), false);
  let fitting = '';
  while (sourceSelectorPromptFitsContext(`${fitting}a `)) fitting += 'a ';
  assert.ok(fitting.length > 0);
  assert.equal(sourceSelectorPromptFitsContext(fitting), true);
  assert.equal(sourceSelectorPromptFitsContext(`${fitting}a `), false);
  assert.equal(SOURCE_SELECTOR_LIMITS.outputTokenLimit, 256);
});

test('source-selector output path accepts safe reruns and rejects repository or symlink escapes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-source-selector-'));
  const output = join(directory, 'model-evaluation-aggregate-source-selector.json');
  const report = { reportVersion: 'test', quality: { fullFieldRowAccuracy: 0 } };
  try {
    assert.equal(isSourceSelectorAggregatePath(output), true);
    writeSourceSelectorAggregate(output, report);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).reportVersion, 'test');
    assert.equal(readFileSync(output).length > 0, true);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    writeSourceSelectorAggregate(output, { ...report, rerun: true });
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).rerun, true);

    const target = join(directory, 'target.json');
    symlinkSync(output, target);
    assert.equal(isSourceSelectorAggregatePath(target), false);
    assert.throws(() => writeSourceSelectorAggregate(target, report), /output-path/u);

    const repoParent = join(directory, 'repo-parent');
    symlinkSync(process.cwd(), repoParent);
    const parentEscape = join(repoParent, 'model-evaluation-aggregate-source-selector.json');
    assert.equal(isSourceSelectorAggregatePath(parentEscape), false);
    assert.equal(
      isSourceSelectorAggregatePath(
        join(directory, 'model-evaluation-aggregate-source-selector.txt'),
      ),
      false,
    );
    assert.equal(
      isSourceSelectorAggregatePath(
        join(process.cwd(), 'model-evaluation-aggregate-source-selector.json'),
      ),
      false,
    );
    assert.equal(existsSync(output), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source-selector candidate preflight requires exactly one expected FROM blob line', async () => {
  const originalFetch = globalThis.fetch;
  const digest = candidateEvaluationManifests.qwen.model.sha256;
  const preflight = loopbackCandidatePreflight('qwen', 'qwen-source-selector-test');
  try {
    const respond = (modelfile: string) => {
      globalThis.fetch = async () => new Response(JSON.stringify({ modelfile }), { status: 200 });
      return preflight();
    };
    await assert.doesNotReject(respond(`FROM /ollama/blobs/sha256-${digest}`));
    await assert.rejects(
      respond(`FROM /ollama/blobs/sha256-${digest}\nFROM /ollama/blobs/sha256-${'0'.repeat(64)}`),
      /candidate-identity/u,
    );
    await assert.rejects(
      respond(`FROM /ollama/blobs/sha256-${digest}\nFROM /ollama/blobs/not-a-digest`),
      /candidate-identity/u,
    );
    await assert.rejects(
      respond(`FROM /ollama/blobs/sha256-${digest}\nFROM`),
      /candidate-identity/u,
    );
    await assert.rejects(
      respond(`FROM /ollama/blobs/sha256-${'0'.repeat(64)}`),
      /candidate-identity/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qwen3 preflight binds the exact pinned artifact identity', async () => {
  const originalFetch = globalThis.fetch;
  const manifest = sourceSelectorCandidateManifests.qwen3;
  const preflight = loopbackCandidatePreflight('qwen3', 'qwen3-source-selector-test');
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ modelfile: `FROM /ollama/blobs/sha256-${manifest.model.sha256}` }),
      {
        status: 200,
      },
    );
  try {
    await assert.doesNotReject(preflight());
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ modelfile: `FROM /ollama/blobs/sha256-${'0'.repeat(64)}` }), {
        status: 200,
      });
    await assert.rejects(preflight(), /candidate-identity/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

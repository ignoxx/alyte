import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNuExtractPrompt,
  decodeNuExtractProposals,
  NUEXTRACT_LABORATORY_SCHEMA,
  NUEXTRACT_PROMPT_PREFIX,
} from './nuextract-proposals';

test('builds the official template prefix directly before complete page text', () => {
  const pageText = 'Test | Current Result | Unit\nAlpha | 12,5 | mg/L\n';
  assert.equal(
    buildNuExtractPrompt(pageText),
    `# Template:\n${JSON.stringify(NUEXTRACT_LABORATORY_SCHEMA, null, 4)}\n${pageText}`,
  );
  assert.ok(
    NUEXTRACT_PROMPT_PREFIX.endsWith(`${JSON.stringify(NUEXTRACT_LABORATORY_SCHEMA, null, 4)}\n`),
  );
});

test('decodes verbatim NuExtract fields and maps optional fields to shared proposals', () => {
  const result = decodeNuExtractProposals(
    [
      'startup text',
      JSON.stringify(NUEXTRACT_LABORATORY_SCHEMA),
      JSON.stringify({
        laboratory_results: [
          {
            test_name: 'Alpha',
            current_result: '12,5',
            unit: 'mg/L',
            reference_interval: '10–15',
            flag: 'H',
          },
          {
            test_name: 'Appearance',
            current_result: 'Clear',
            unit: '',
            reference_interval: null,
            flag: null,
          },
        ],
      }),
    ].join('\n'),
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.proposals, [
    {
      label: 'Alpha',
      value: '12,5',
      rawValue: '12,5',
      unit: 'mg/L',
      reference: '10–15',
      flag: 'H',
    },
    {
      label: 'Appearance',
      value: 'Clear',
      rawValue: 'Clear',
      unit: null,
      reference: null,
      flag: null,
    },
  ]);
  assert.equal(result.droppedIncompleteRows, 0);
});

test('rejects a template-only echo so placeholder strings never become proposals', () => {
  const result = decodeNuExtractProposals(JSON.stringify(NUEXTRACT_LABORATORY_SCHEMA));
  assert.deepEqual(result, { proposals: [], valid: false, droppedIncompleteRows: 1 });
});

test('rejects non-string verbatim fields rather than coercing them', () => {
  const result = decodeNuExtractProposals(
    JSON.stringify({
      laboratory_results: [
        {
          test_name: 'Alpha',
          current_result: 12,
          unit: null,
          reference_interval: null,
          flag: null,
        },
      ],
    }),
  );
  assert.deepEqual(result, { proposals: [], valid: false, droppedIncompleteRows: 0 });
});

test('rejects an untouched optional placeholder instead of grounding it as source text', () => {
  const result = decodeNuExtractProposals(
    JSON.stringify({
      laboratory_results: [
        {
          test_name: 'Alpha',
          current_result: '12',
          unit: 'verbatim-string',
          reference_interval: null,
          flag: null,
        },
      ],
    }),
  );
  assert.deepEqual(result, { proposals: [], valid: false, droppedIncompleteRows: 1 });
});

test('skips null required fields while preserving valid sibling rows and counting the omission', () => {
  const result = decodeNuExtractProposals(
    JSON.stringify({
      laboratory_results: [
        {
          test_name: null,
          current_result: null,
          unit: null,
          reference_interval: null,
          flag: null,
        },
        {
          test_name: 'Alpha',
          current_result: '12,5',
          unit: 'mg/L',
          reference_interval: null,
          flag: null,
        },
      ],
    }),
  );
  assert.equal(result.valid, true);
  assert.equal(result.droppedIncompleteRows, 1);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]?.label, 'Alpha');
});

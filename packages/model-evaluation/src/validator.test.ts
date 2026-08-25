import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixtureById, semanticEvaluationFixtures } from './fixtures';
import { countFailures, validateEvaluationOutput } from './validator';

const fixture = fixtureById('qwen-v1-en-mixed')!;

function validOutput() {
  return {
    schemaVersion: 'alyte.semantic-mapper.v1',
    proposals: [
      {
        sourceObservationIds: [
          'en-serum-ldl-label',
          'en-serum-ldl-value',
          'en-serum-ldl-unit',
          'en-serum-ldl-interval',
        ],
        role: 'measurement',
        specimenType: 'serum',
        biomarkerId: 'biomarker.ldl_c',
      },
    ],
  };
}

describe('evaluation validator', () => {
  it('accepts only source IDs and bounded semantic fields', () => {
    const result = validateEvaluationOutput(validOutput(), fixture.observations);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.accepted[0]?.rowId, 'en-serum-ldl');
  });

  it('rejects invented IDs, duplicate row consumption, and authoritative fields', () => {
    const output = validOutput();
    output.proposals.push({
      sourceObservationIds: ['en-serum-ldl-label'],
      role: 'measurement',
      specimenType: 'serum',
      biomarkerId: 'biomarker.ldl_c',
    });
    output.proposals.push({
      sourceObservationIds: ['invented-source'],
      role: 'measurement',
      specimenType: 'serum',
      biomarkerId: 'biomarker.invented',
      value: 42,
    } as never);
    const result = validateEvaluationOutput(output, fixture.observations);
    const failures = countFailures(result.failures);
    assert.equal(failures['duplicate-source-row'], 1);
    assert.equal(failures['authoritative-field'], 1);
    assert.equal(failures['unknown-source-id'], 0);
    assert.equal(failures['unknown-biomarker-id'], 0);
  });

  it('rejects incompatible specimen mappings even when the biomarker ID is known', () => {
    const output = validOutput();
    output.proposals[0] = {
      sourceObservationIds: ['en-serum-ldl-label'],
      role: 'measurement',
      specimenType: 'urine',
      biomarkerId: 'biomarker.ldl_c',
    };
    const result = validateEvaluationOutput(output, fixture.observations);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.failures[0]?.code, 'incompatible-specimen');
  });

  it('reports invented source and biomarker identifiers independently', () => {
    const result = validateEvaluationOutput(
      {
        schemaVersion: 'alyte.semantic-mapper.v1',
        proposals: [
          {
            sourceObservationIds: ['invented-source'],
            role: 'measurement',
            specimenType: 'serum',
            biomarkerId: 'biomarker.ldl_c',
          },
          {
            sourceObservationIds: ['en-serum-ldl-label'],
            role: 'measurement',
            specimenType: 'serum',
            biomarkerId: 'biomarker.invented',
          },
        ],
      },
      fixture.observations,
    );
    const failures = countFailures(result.failures);
    assert.equal(failures['unknown-source-id'], 1);
    assert.equal(failures['unknown-biomarker-id'], 1);
  });

  it('rejects malformed, cyclic, and oversized envelopes without retaining raw output', () => {
    const malformed = validateEvaluationOutput(
      { schemaVersion: 'wrong', proposals: [] },
      fixture.observations,
    );
    assert.equal(malformed.failures[0]?.code, 'malformed-schema');

    const cyclic: { schemaVersion: string; proposals: unknown[]; self?: unknown } = {
      schemaVersion: 'alyte.semantic-mapper.v1',
      proposals: [],
    };
    cyclic.self = cyclic;
    const cycleResult = validateEvaluationOutput(cyclic, fixture.observations);
    assert.equal(cycleResult.failures[0]?.code, 'circular-output');
    assert.equal(cycleResult.outputBytes, null);

    const oversized = {
      schemaVersion: 'alyte.semantic-mapper.v1',
      proposals: Array.from({ length: 24 }, (_, index) => ({
        sourceObservationIds: [`unknown-${index}`],
        role: 'ignore',
        specimenType: 'unknown',
        biomarkerId: null,
        padding: 'x'.repeat(1000),
      })),
    };
    const oversizedResult = validateEvaluationOutput(oversized, fixture.observations);
    assert.equal(oversizedResult.failures[0]?.code, 'oversized-output');
    assert.equal(oversizedResult.accepted.length, 0);
  });

  it('covers all six synthetic languages with mixed specimen contexts', () => {
    assert.deepEqual(
      semanticEvaluationFixtures.map((candidate) => candidate.language),
      ['en', 'de', 'lt', 'pl', 'fr', 'es'],
    );
    assert.ok(
      semanticEvaluationFixtures.some((candidate) =>
        candidate.observations.some((row) => row.specimenType === 'urine'),
      ),
    );
    assert.ok(
      semanticEvaluationFixtures.some((candidate) =>
        candidate.observations.some((row) => row.specimenType === 'plasma'),
      ),
    );
  });
});

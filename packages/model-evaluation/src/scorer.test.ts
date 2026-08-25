import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixtureById, semanticEvaluationFixtures } from './fixtures';
import { aggregateFixtureScores, buildAggregateReport, scoreEvaluationFixture } from './scorer';

const fixture = fixtureById('qwen-v1-en-mixed')!;

describe('evaluation scorer', () => {
  it('separates lenient model recall from accepted end-to-end precision', () => {
    const score = scoreEvaluationFixture(fixture, {
      schemaVersion: 'alyte.semantic-mapper.v1',
      proposals: [
        {
          sourceObservationIds: ['en-serum-ldl-label'],
          role: 'measurement',
          specimenType: 'serum',
          biomarkerId: 'biomarker.ldl_c',
        },
        {
          sourceObservationIds: ['en-urine-glucose-label'],
          role: 'measurement',
          specimenType: 'blood',
          biomarkerId: 'biomarker.glucose',
        },
      ],
    });
    assert.equal(score.modelRecall, 1);
    assert.equal(score.acceptedEndToEndPrecision, 0.5);
    assert.equal(score.exactSourceValueUnitIntervalPreservation, 0);
    assert.equal(score.exactSourceFactsPreserved, 0);
    assert.equal(score.rowsNeedingReview, 1);
  });

  it('aggregates quality and provenance without raw model output', () => {
    const scores = semanticEvaluationFixtures.map((candidate) =>
      scoreEvaluationFixture(candidate, {
        schemaVersion: 'alyte.semantic-mapper.v1',
        proposals: [],
      }),
    );
    const quality = aggregateFixtureScores(scores);
    const report = buildAggregateReport(scores);
    assert.equal(quality.fixtureCount, 6);
    assert.equal(quality.languageCount, 6);
    assert.equal(report.provenance.modelFilename, 'Qwen3.5-0.8B-Q4_0.gguf');
    assert.equal(report.provenance.thinking, false);
    assert.equal('rawModelOutput' in report, false);
    assert.equal('prompt' in report, false);
  });
});

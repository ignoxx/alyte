import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixtureById, semanticEvaluationFixtures } from './fixtures';
import { gemmaEvaluationManifest } from './manifest';
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

  it('aggregates exact source fact preservation independently from mapping correctness', () => {
    const first = scoreEvaluationFixture(fixture, {
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
    });
    const second = scoreEvaluationFixture(fixture, {
      schemaVersion: 'alyte.semantic-mapper.v1',
      proposals: [
        {
          sourceObservationIds: ['en-urine-glucose-label'],
          role: 'specimen-context',
          specimenType: 'urine',
          biomarkerId: null,
        },
      ],
    });
    const quality = aggregateFixtureScores([first, second]);
    assert.equal(first.exactSourceFactsPreserved, 1);
    assert.equal(second.exactSourceFactsPreserved, 0);
    assert.equal(quality.exactSourceFactsPreserved, 1);
    assert.equal(quality.exactSourceValueUnitIntervalPreservation, 0.5);
  });

  it('uses candidate-specific aggregate identity without accepting different output fields', () => {
    const scores = semanticEvaluationFixtures.map((candidate) =>
      scoreEvaluationFixture(
        candidate,
        { schemaVersion: 'alyte.semantic-mapper.v1', proposals: [] },
        gemmaEvaluationManifest,
      ),
    );
    const report = buildAggregateReport(scores, [], gemmaEvaluationManifest);
    assert.equal(report.reportVersion, 'alyte.model-evaluation.aggregate.v1');
    assert.equal(report.provenance.manifestVersion, gemmaEvaluationManifest.manifestVersion);
    assert.equal(report.provenance.modelFilename, 'gemma-4-E2B-it-Q4_0.gguf');
    assert.equal(report.provenance.sourceModelRepository, 'google/gemma-4-E2B-it');
    assert.equal(report.provenance.sourceModelRevision, '3e22461f65e89153144f8adb70e3b8c2cc9845a7');
    assert.equal('rawModelOutput' in report, false);
  });

  it('rejects tampered candidate provenance before aggregate emission', () => {
    const tampered = {
      ...gemmaEvaluationManifest,
      sourceModel: {
        ...gemmaEvaluationManifest.sourceModel,
        revision: '0000000000000000000000000000000000000000',
      },
    };
    assert.throws(
      () => buildAggregateReport([], [], tampered),
      /unsupported_evaluation_candidate_manifest/,
    );
  });
});

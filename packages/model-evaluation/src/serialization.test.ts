import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixtureById } from './fixtures';
import { qwenEvaluationManifest } from './manifest';
import { OCRSerializationError, serializeOCRChunk } from './serialization';

const fixture = fixtureById('qwen-v1-de-mixed')!;

describe('bounded OCR serialization', () => {
  it('is deterministic and excludes row bookkeeping and source facts', () => {
    const forward = serializeOCRChunk(fixture.observations, fixture.language);
    const reversed = serializeOCRChunk([...fixture.observations].reverse(), fixture.language);
    assert.equal(forward, reversed);
    assert.equal(forward.includes('rowId'), false);
    assert.equal(forward.includes('sourceFacts'), false);
    assert.equal(forward.includes('3,8'), true);
  });

  it('rejects oversized observation inputs before native inference', () => {
    const tooMany = Array.from(
      { length: qwenEvaluationManifest.prompt.maxObservations + 1 },
      () => fixture.observations[0]!,
    );
    assert.throws(
      () => serializeOCRChunk(tooMany, 'de'),
      (error: unknown) => {
        assert.ok(error instanceof OCRSerializationError);
        assert.equal(error.code, 'too-many-observations');
        return true;
      },
    );
    const tooLong = [{ ...fixture.observations[0]!, text: 'x'.repeat(241) }];
    assert.throws(() => serializeOCRChunk(tooLong, 'de'), /observation-text-too-long/);
    assert.throws(
      () => serializeOCRChunk(fixture.observations, 'de', ['biomarker.invented']),
      /unknown-catalogue-id/,
    );
  });

  it('rejects a deterministic total serialized input bound', () => {
    const oversized = Array.from({ length: 48 }, (_, index) => ({
      id: `observation-${index}`,
      rowId: `row-${index}`,
      text: 'x'.repeat(240),
      alternatives: ['y'.repeat(120)],
      pageIndex: 0,
      locale: 'en' as const,
      specimenType: 'serum' as const,
    }));
    assert.throws(
      () => serializeOCRChunk(oversized, 'en', ['biomarker.ldl_c']),
      (error: unknown) =>
        error instanceof OCRSerializationError && error.code === 'input-too-large',
    );
  });
});

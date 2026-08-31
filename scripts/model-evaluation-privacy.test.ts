import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error JavaScript helper intentionally has no generated type surface.
import { assertAggregatePrivacy } from './model-evaluation-aggregate-scrub.mjs';

test('recursive aggregate privacy guard rejects nested source and provider payloads without echoing content', () => {
  const cases = [
    ['promptText', 'SYNTHETIC_PROMPT_PAYLOAD'],
    ['serializedInput', 'SYNTHETIC_SERIALIZED_PAYLOAD'],
    ['ocrText', 'SYNTHETIC_OCR_PAYLOAD'],
    ['sourceObservationIds', ['SYNTHETIC_SOURCE_ID']],
    ['rawModelOutput', 'SYNTHETIC_RAW_RESPONSE'],
    ['biomarkerId', 'biomarker.ldl_c'],
    ['specimenType', 'serum'],
    ['role', 'measurement'],
    ['value', '118'],
    ['valueString', '118'],
    ['unit', 'mg/dL'],
    ['referenceInterval', '<115'],
    ['reference', '<115'],
    ['range', '<115'],
    ['flag', 'high'],
    ['text', 'SYNTHETIC_OCR_TEXT'],
    ['response', 'SYNTHETIC_RESPONSE'],
    ['sourceId', 'SYNTHETIC_SOURCE_ID'],
    ['sourceIds', ['SYNTHETIC_SOURCE_ID']],
    ['sourcePath', '/private/health/report-SYNTHETIC'],
    ['payload', 'SYNTHETIC_PAYLOAD'],
    ['path', '/private/health/report-SYNTHETIC'],
    ['status', 'prefix <|turn> SYNTHETIC_CHAT_MARKER'],
  ] as const;
  for (const [key, payload] of cases) {
    assert.throws(
      () => assertAggregatePrivacy({ nested: { deeper: { [key]: payload } } }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /^aggregate /u);
        assert.equal(error.message.includes('SYNTHETIC'), false);
        assert.equal(error.message.includes('/private/health'), false);
        return true;
      },
    );
  }
});

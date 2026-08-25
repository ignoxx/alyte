import fs from 'node:fs';

const FORBIDDEN_FIELD_NAMES = new Set([
  'rawModelOutput',
  'rawPrompt',
  'rawResponse',
  'modelOutput',
  'modelResponse',
  'responseText',
  'prompt',
  'promptText',
  'serializedInput',
  'ocrText',
  'rawOcrText',
  'rawOCRText',
  'observations',
  'sourceFacts',
  'sourceObservationId',
  'sourceObservationIds',
  'sourceObservations',
  'observationIds',
]);

const CHAT_CONTROL_MARKERS = Object.freeze([
  '<|im_start|>',
  '<|im_end|>',
  '<|turn>',
  '<turn|>',
  '<bos>',
  '<think>',
  '</think>',
]);

function pathFor(path, key) {
  return `${path}.${key}`;
}

/**
 * Checks aggregate-shaped data without serializing it. This deliberately walks every nested
 * object and array so an accidentally retained prompt or source observation cannot hide under a
 * future metric field. Error messages contain only field paths, never user/model content.
 */
export function assertAggregatePrivacy(value, path = '$') {
  if (typeof value === 'string') {
    if (CHAT_CONTROL_MARKERS.some((marker) => value.includes(marker))) {
      throw new Error(`aggregate contains chat control marker at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertAggregatePrivacy(child, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = pathFor(path, key);
    if (key === 'sourceFactsPreservedCount') {
      if (!Number.isFinite(child) || typeof child !== 'number') {
        throw new Error(`aggregate metric has invalid shape at ${childPath}`);
      }
      continue;
    }
    if (FORBIDDEN_FIELD_NAMES.has(key)) {
      throw new Error(`aggregate contains forbidden field at ${childPath}`);
    }
    assertAggregatePrivacy(child, childPath);
  }
}

export function assertAggregateMetrics(report) {
  assertAggregatePrivacy(report);
  if (
    report === null ||
    typeof report !== 'object' ||
    Array.isArray(report) ||
    !report.deviceMetrics ||
    typeof report.fixtureCount !== 'number' ||
    typeof report.expectedRowCount !== 'number'
  ) {
    throw new Error('aggregate report is missing required evaluation metrics');
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const aggregatePath = process.argv[2];
  if (typeof aggregatePath !== 'string') {
    throw new Error('aggregate path is required');
  }
  const report = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
  assertAggregateMetrics(report);
}

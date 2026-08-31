import type { LabReportExtractionError } from './report-service';

export type ExtractionFailurePresentation = {
  readonly titleKey: 'labs.extractionProgressNoValuesTitle' | 'labs.extractionProgressFailureTitle';
  readonly messageKey:
    | 'labs.extractionProgressPasswordError'
    | 'labs.extractionProgressSourceError'
    | 'labs.extractionNoMeasurementsError'
    | 'labs.extractionProgressCancelled'
    | 'labs.extractionProgressInterrupted'
    | 'labs.extractionPersistenceError'
    | 'labs.extractionRecognitionError';
};

export function extractionFailurePresentation(
  reason: LabReportExtractionError['reason'],
): ExtractionFailurePresentation {
  const titleKey =
    reason === 'no-reviewable-measurements'
      ? 'labs.extractionProgressNoValuesTitle'
      : 'labs.extractionProgressFailureTitle';

  const messageKey =
    reason === 'wrong-password'
      ? 'labs.extractionProgressPasswordError'
      : reason === 'original-source'
        ? 'labs.extractionProgressSourceError'
        : reason === 'no-reviewable-measurements'
          ? 'labs.extractionNoMeasurementsError'
          : reason === 'cancelled'
            ? 'labs.extractionProgressCancelled'
            : reason === 'interrupted'
              ? 'labs.extractionProgressInterrupted'
              : reason === 'persistence'
                ? 'labs.extractionPersistenceError'
                : 'labs.extractionRecognitionError';

  return { titleKey, messageKey };
}

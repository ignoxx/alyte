import type { LabReportExtractionError } from './report-service';
import type { LabReportExtractionProgress } from './report-service';

export const EXTRACTION_PROGRESS_STAGES = [
  'import',
  'ocr',
  'organize',
  'refine',
  'review',
] as const satisfies readonly LabReportExtractionProgress['stage'][];

export type ExtractionFailurePresentation = {
  readonly titleKey: 'labs.extractionProgressNoValuesTitle' | 'labs.extractionProgressFailureTitle';
  readonly messageKey:
    | 'labs.extractionProgressPasswordError'
    | 'labs.extractionProgressSourceError'
    | 'labs.extractionNoMeasurementsError'
    | 'labs.extractionProgressCancelled'
    | 'labs.extractionProgressInterrupted'
    | 'labs.extractionPersistenceError'
    | 'labs.extractionModelError'
    | 'labs.extractionRecognitionError';
};

export function extractionProgressDetailKey(
  progress: LabReportExtractionProgress | null,
):
  | 'labs.extractionProgressPage'
  | 'labs.extractionProgressOrganizing'
  | 'labs.extractionProgressRefining'
  | 'labs.extractionProgressSaving'
  | null {
  if (progress === null || progress.status !== 'active' || progress.total <= 0) return null;
  if (progress.stage === 'ocr') return 'labs.extractionProgressPage';
  if (progress.stage === 'organize') return 'labs.extractionProgressOrganizing';
  if (progress.stage === 'refine') return 'labs.extractionProgressRefining';
  return progress.stage === 'review' ? 'labs.extractionProgressSaving' : null;
}

export function extractionProgressStageCompleted(
  progress: LabReportExtractionProgress | null,
  stage: LabReportExtractionProgress['stage'],
): boolean {
  if (progress === null) return false;
  if (progress.status === 'complete') return true;

  return (
    EXTRACTION_PROGRESS_STAGES.indexOf(stage) < EXTRACTION_PROGRESS_STAGES.indexOf(progress.stage)
  );
}

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
                : reason === 'model-unavailable'
                  ? 'labs.extractionModelError'
                  : 'labs.extractionRecognitionError';

  return { titleKey, messageKey };
}

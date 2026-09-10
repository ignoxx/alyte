import { t } from '../../localization';
import { extractionReviewRequiresAttention, type ExtractionDraftRow } from '@alyte/domain';

export type ExtractionConfirmationBlockReason = 'no-included-rows' | 'rows-need-resolution';

export type ExtractionConfirmationSummary = {
  /** Rows that will become Lab Records when confirmation succeeds. */
  readonly included: number;
  /** Rows in the active review queue. Explicitly skipped rows are not queued again. */
  readonly needsReview: number;
  /** Included rows that still block confirmation under the domain review rules. */
  readonly remainingBlockers: number;
  readonly canConfirm: boolean;
  readonly blockedReason: ExtractionConfirmationBlockReason | null;
};

/**
 * Keep confirmation presentation honest about the difference between review attention and a
 * confirmation blocker. A skipped row may still be worth showing in the review queue without
 * preventing the other included rows from becoming Lab Records.
 */
export function extractionConfirmationSummary(
  rows: readonly Pick<ExtractionDraftRow, 'decision' | 'reviewReasons'>[],
): ExtractionConfirmationSummary {
  const included = rows.filter((row) => row.decision !== 'skip').length;
  const needsReview = rows.filter(extractionReviewQueueIncludes).length;
  const remainingBlockers = needsReview;
  const canConfirm = included > 0 && remainingBlockers === 0;

  return {
    included,
    needsReview,
    remainingBlockers,
    canConfirm,
    blockedReason: canConfirm
      ? null
      : remainingBlockers > 0
        ? 'rows-need-resolution'
        : 'no-included-rows',
  };
}

export type ExtractionConfirmationPresentation = ExtractionConfirmationSummary & {
  readonly state: ExtractionConfirmationState;
  readonly action: ExtractionConfirmationAction | null;
};

export type ExtractionConfirmationState = 'blocked' | 'ready' | 'busy' | 'failure';

export type ExtractionConfirmationActionKind = 'review' | 'save' | 'retry' | 'leave';

export type ExtractionConfirmationAction = {
  readonly kind: ExtractionConfirmationActionKind;
  /** Short visible copy for the native accessory. */
  readonly label: string;
  /** Complete state and action copy for VoiceOver. */
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
};

/**
 * One queue definition shared by the draft filter, continuous review, and confirmation footer.
 * Skipped rows remain visible in the All filter, but are no longer presented as work to do.
 */
export function extractionReviewQueueIncludes(
  row: Pick<ExtractionDraftRow, 'decision' | 'reviewReasons'>,
): boolean {
  return row.decision !== 'skip' && extractionReviewRequiresAttention(row);
}

function measurementCountLabel(count: number): string {
  return t(
    count === 1
      ? 'labs.extractionConfirmationSaveMeasurement'
      : 'labs.extractionConfirmationSaveMeasurements',
  ).replace('{count}', String(count));
}

function reviewCountLabel(count: number): string {
  return t('labs.extractionConfirmationReviewRemaining').replace('{count}', String(count));
}

function leaveWithoutSavingLabel(): string {
  return t('labs.extractionConfirmationFinishWithoutSaving');
}

function stateSummaryLabel(summary: ExtractionConfirmationSummary): string {
  return t('labs.extractionConfirmationProgress')
    .replace('{included}', String(summary.included))
    .replace('{review}', String(summary.needsReview));
}

/** Resolve the one concise accessory action from the existing confirmation/domain state. */
export function extractionConfirmationPresentation(
  summary: ExtractionConfirmationSummary,
  input: { readonly busy: boolean; readonly failure?: boolean },
): ExtractionConfirmationPresentation {
  const state = input.busy
    ? 'busy'
    : input.failure
      ? 'failure'
      : summary.included === 0
        ? 'blocked'
        : summary.canConfirm
          ? 'ready'
          : 'blocked';

  let action: ExtractionConfirmationAction | null = null;
  if (summary.included === 0) {
    const label = leaveWithoutSavingLabel();
    action = {
      kind: 'leave',
      label,
      accessibilityLabel: `${label}. ${t('labs.extractionConfirmationNoMeasurements')}`,
      disabled: input.busy,
    };
  } else {
    const summaryLabel = stateSummaryLabel(summary);
    if (state === 'busy') {
      action = {
        kind: 'save',
        label: t('labs.extractionConfirmationBusyAction'),
        accessibilityLabel: `${t('labs.extractionConfirmationBusyAction')}. ${summaryLabel}`,
        disabled: true,
      };
    } else if (state === 'failure') {
      action = {
        kind: 'retry',
        label: t('labs.extractionConfirmationRetry'),
        accessibilityLabel: `${t('labs.extractionConfirmationRetry')}. ${t(
          'labs.extractionConfirmationFailure',
        )} ${summaryLabel}`,
        disabled: false,
      };
    } else if (state === 'ready') {
      const label = measurementCountLabel(summary.included);
      action = {
        kind: 'save',
        label,
        accessibilityLabel: `${label}. ${summaryLabel}`,
        disabled: false,
      };
    } else {
      const label = reviewCountLabel(summary.remainingBlockers);
      action = {
        kind: 'review',
        label,
        accessibilityLabel: `${label}. ${summaryLabel}`,
        disabled: false,
      };
    }
  }

  return {
    ...summary,
    state,
    action,
  };
}

export type ExtractionConfirmationProps = {
  readonly busy: boolean;
  readonly failure?: boolean;
  readonly canConfirm: boolean;
  readonly included: number;
  readonly needsReview: number;
  readonly remainingBlockers: number;
  readonly blockedReason: ExtractionConfirmationBlockReason | null;
  readonly onConfirm: () => void;
  readonly onReviewRemaining: () => void;
  readonly onLeaveWithoutSaving: () => void;
};

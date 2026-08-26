import { t } from '../../localization';
import {
  extractionReviewBlocksConfirmation,
  extractionReviewRequiresAttention,
  type ExtractionDraftRow,
} from '@alyte/domain';

export type ExtractionConfirmationBlockReason = 'no-included-rows' | 'rows-need-resolution';

export type ExtractionConfirmationSummary = {
  /** Rows that will become Lab Records when confirmation succeeds. */
  readonly included: number;
  /** Rows that need attention, including rows the person has chosen to skip. */
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
  const needsReview = rows.filter(extractionReviewRequiresAttention).length;
  const remainingBlockers = rows.filter(extractionReviewBlocksConfirmation).length;
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
  readonly statusLabel: string;
  readonly disabled: boolean;
};

export type ExtractionConfirmationState = 'blocked' | 'ready' | 'busy' | 'failure';

export type ExtractionConfirmationLayout = 'inline' | 'stacked';

/** Stack before Dynamic Type can squeeze either visible count out of the accessory. */
export function extractionConfirmationLayout(
  fontScale: number,
  width: number,
): ExtractionConfirmationLayout {
  return fontScale > 1 || width < 360 ? 'stacked' : 'inline';
}

function confirmationStatusLabel(
  state: ExtractionConfirmationState,
  summary: ExtractionConfirmationSummary,
): string {
  switch (state) {
    case 'busy':
      return t('labs.extractionConfirmationBusy');
    case 'failure':
      return t('labs.extractionConfirmationFailure');
    case 'ready':
      return t('labs.extractionConfirmationReady');
    case 'blocked':
      return summary.blockedReason === 'no-included-rows'
        ? t('labs.extractionConfirmationNoIncluded')
        : t('labs.extractionConfirmationBlocked').replace(
            '{count}',
            String(summary.remainingBlockers),
          );
  }
}

/** Resolve stable accessory states without making a spinner the only busy/failure feedback. */
export function extractionConfirmationPresentation(
  summary: ExtractionConfirmationSummary,
  input: { readonly busy: boolean; readonly failure?: boolean },
): ExtractionConfirmationPresentation {
  const state = input.busy
    ? 'busy'
    : input.failure
      ? 'failure'
      : summary.canConfirm
        ? 'ready'
        : 'blocked';
  return {
    ...summary,
    state,
    statusLabel: confirmationStatusLabel(state, summary),
    disabled: input.busy || !summary.canConfirm,
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
};

export function confirmationAccessibilityLabel(
  included: number,
  needsReview: number,
  remainingBlockers = 0,
  blockedReason: ExtractionConfirmationBlockReason | null = null,
): string {
  const blockedReasonText =
    blockedReason === 'no-included-rows'
      ? ` ${t('labs.extractionConfirmationNoIncluded')}`
      : blockedReason === 'rows-need-resolution'
        ? ` ${t('labs.extractionConfirmationBlocked').replace(
            '{count}',
            String(remainingBlockers),
          )}`
        : '';
  return `${t('labs.extractionConfirm')}. ${t('labs.extractionConfirmationProgress')
    .replace('{included}', String(included))
    .replace('{review}', String(needsReview))}.${blockedReasonText}`;
}

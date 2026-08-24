import { t } from '../../localization';

export type ExtractionConfirmationProps = {
  readonly busy: boolean;
  readonly canConfirm: boolean;
  readonly included: number;
  readonly needsReview: number;
  readonly onConfirm: () => void;
};

export function confirmationAccessibilityLabel(included: number, needsReview: number): string {
  return `${t('labs.extractionConfirm')}. ${t('labs.extractionConfirmationProgress')
    .replace('{included}', String(included))
    .replace('{review}', String(needsReview))}`;
}

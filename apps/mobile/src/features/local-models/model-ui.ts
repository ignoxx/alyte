import {
  LOCAL_MODEL_FAILURES,
  hasResumableModelDownload,
  type LocalModelFailure,
  type LocalModelSnapshot,
  type LocalModelState,
} from './model';
import { t } from '../../localization';

export type ModelStatusTone = 'neutral' | 'measured' | 'reviewNeeded';
export type ModelOperation =
  'checking' | 'download' | 'cancel' | 'cancelling' | 'retry' | 'remove' | 'deleting';

/**
 * UI-only labels for the model lifecycle. The native state remains the source of truth; this
 * boundary keeps screen copy from accidentally changing lifecycle or integrity semantics.
 */
export function modelProgressPercent(snapshot: LocalModelSnapshot): number {
  return Math.min(100, Math.max(0, Math.round(snapshot.progress * 100)));
}

export type ModelDownloadAction = 'download' | 'continue' | 'retry' | 'none';

/** Keeps a retained partial distinct from a fresh failure in both model-management screens. */
export function modelDownloadAction(snapshot: LocalModelSnapshot | null): ModelDownloadAction {
  if (snapshot === null) return 'none';
  if (hasResumableModelDownload(snapshot)) return 'continue';
  if (snapshot.state === 'failed') return 'retry';
  if (snapshot.state === 'not-installed') return 'download';
  return 'none';
}

export function modelStatusTone(snapshot: LocalModelSnapshot | null): ModelStatusTone {
  if (snapshot?.state === 'ready' || snapshot?.state === 'loaded') return 'measured';
  if (hasResumableModelDownload(snapshot)) return 'neutral';
  if (snapshot?.state === 'failed') return 'reviewNeeded';
  return 'neutral';
}

/**
 * Keeps lifecycle controls mutually exclusive. A transition state never exposes the action that
 * started it again, which prevents duplicate native requests while the serialized queue settles.
 */
export function modelOperation(state: LocalModelState | null): ModelOperation {
  switch (state) {
    case null:
      return 'checking';
    case 'not-installed':
      return 'download';
    case 'downloading':
    case 'verifying':
      return 'cancel';
    case 'cancelling':
      return 'cancelling';
    case 'failed':
      return 'retry';
    case 'deleting':
      return 'deleting';
    case 'ready':
    case 'loaded':
      return 'remove';
  }
}

export function modelStateLabelKey(state: LocalModelState): string {
  switch (state) {
    case 'not-installed':
      return 'settings.modelStorageNotInstalled';
    case 'downloading':
      return 'settings.modelStorageDownloading';
    case 'verifying':
      return 'settings.modelStorageVerifying';
    case 'ready':
      return 'settings.modelStorageReady';
    case 'loaded':
      return 'settings.modelStorageLoaded';
    case 'failed':
      return 'settings.modelStorageFailed';
    case 'cancelling':
      return 'settings.modelStorageCancelling';
    case 'deleting':
      return 'settings.modelStorageDeleting';
  }
}

/** Read the native error category without relying on provider or platform-specific error text. */
function errorFailureCategory(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as {
    readonly failure?: unknown;
    readonly failureCategory?: unknown;
    readonly userInfo?: { readonly failureCategory?: unknown };
  };
  return candidate.failure ?? candidate.failureCategory ?? candidate.userInfo?.failureCategory;
}

/** Decodes native failures without turning every model error into a missing-module message. */
export function modelFailureFromError(error: unknown): LocalModelFailure {
  const category = errorFailureCategory(error);
  return LOCAL_MODEL_FAILURES.includes(category as LocalModelFailure)
    ? (category as LocalModelFailure)
    : 'unknown';
}

/**
 * Native cancellation intentionally rejects the pending download with a typed `cancelled`
 * category after cancelDownload itself resolves. That expected rejection is a calm outcome, not
 * bridge failure; only a typed cancellation during an active cancel request qualifies here.
 */
export function isExpectedDownloadCancellation(
  error: unknown,
  cancellationRequested: boolean,
): boolean {
  return cancellationRequested && errorFailureCategory(error) === 'cancelled';
}

export function formatModelDownloadSize(bytes: number, locale: string): string {
  const numberFormat = new Intl.NumberFormat(locale);
  const decimalFormat = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return t('model.downloadSizeValue')
    .replace('{bytes}', numberFormat.format(bytes))
    .replace('{bytesUnit}', t('model.bytesUnit'))
    .replace('{gigabytes}', decimalFormat.format(bytes / 1_000_000_000))
    .replace('{gigabytesUnit}', t('model.gigabytesUnit'));
}

export function modelFailureMessageKey(failure: LocalModelFailure | null): string {
  switch (failure) {
    case 'offline':
      return 'onboarding.modelFailureOffline';
    case 'insufficient-space':
      return 'onboarding.modelFailureSpace';
    case 'checksum-mismatch':
    case 'size-mismatch':
      return 'onboarding.modelFailureChecksum';
    case 'incompatible':
      return 'onboarding.modelFailureIncompatible';
    case 'interrupted':
      return 'onboarding.modelFailureInterrupted';
    case 'http-failed':
    case 'upstream-missing':
    case 'redirect-rejected':
    case 'range-rejected':
      return 'onboarding.modelFailureNetwork';
    case 'unavailable':
      return 'onboarding.modelFailureUnavailable';
    case 'cancelled':
      return 'onboarding.modelCancelDisclosure';
    default:
      return 'onboarding.modelFailureGeneric';
  }
}

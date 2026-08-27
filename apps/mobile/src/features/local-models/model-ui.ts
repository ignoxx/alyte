import {
  LOCAL_MODEL_FAILURES,
  canCompleteModelOnboarding,
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
export type ModelFailureRecoveryAction = 'activate' | 'download';
export type ModelSetupPrimaryAction =
  'checking' | 'download' | 'continue' | 'retry' | 'open' | 'cancel' | 'cancelling' | 'none';

/**
 * A verified final pack recovers by activating its runtime. Only an absent, partial, or failed
 * transfer may enter the download path, so a transient load failure cannot spend bandwidth again.
 */
export function modelFailureRecoveryAction(
  snapshot: LocalModelSnapshot | null,
): ModelFailureRecoveryAction {
  return snapshot !== null && canCompleteModelOnboarding(snapshot) ? 'activate' : 'download';
}

/** Keeps a retained partial distinct from a fresh failure in both model-management screens. */
export function modelDownloadAction(snapshot: LocalModelSnapshot | null): ModelDownloadAction {
  if (snapshot === null) return 'none';
  if (hasResumableModelDownload(snapshot)) return 'continue';
  if (snapshot.state === 'failed') return 'retry';
  if (snapshot.state === 'not-installed') return 'download';
  return 'none';
}

/**
 * Chooses the one primary action shown by the required-model setup task. The action is derived
 * from native lifecycle state plus a transient bridge/load failure; the screen never needs to
 * expose a second selection step for the single production pack.
 */
export function modelSetupPrimaryAction(
  snapshot: LocalModelSnapshot | null,
  failure: LocalModelFailure | null = null,
): ModelSetupPrimaryAction {
  if (snapshot === null) return failure === null ? 'checking' : 'retry';
  if (snapshot.state === 'cancelling') return 'cancelling';
  if (snapshot.state === 'downloading' || snapshot.state === 'verifying') return 'cancel';
  if (hasResumableModelDownload(snapshot)) return 'continue';
  // A transient load failure still presents "Try again". The handler can use the separate
  // recovery decision to retry activation without redownloading a verified pack.
  if (failure !== null) return 'retry';
  if (canCompleteModelOnboarding(snapshot)) return 'open';
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
    case 'verification-required':
      return 'onboarding.modelFailureVerificationRequired';
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

/**
 * Setup deliberately has shorter recovery copy than model storage management. Keep this mapping
 * separate so contextual/first-run setup does not rewrite the shared Settings messages.
 */
export function modelSetupFailureMessageKey(failure: LocalModelFailure | null): string {
  switch (failure) {
    case 'offline':
      return 'onboarding.modelSetupFailureOffline';
    case 'insufficient-space':
      return 'onboarding.modelSetupFailureSpace';
    case 'checksum-mismatch':
    case 'size-mismatch':
      return 'onboarding.modelSetupFailureChecksum';
    case 'verification-required':
      return 'onboarding.modelSetupFailureVerificationRequired';
    case 'incompatible':
      return 'onboarding.modelSetupFailureIncompatible';
    case 'interrupted':
      return 'onboarding.modelSetupFailureInterrupted';
    case 'http-failed':
    case 'upstream-missing':
    case 'redirect-rejected':
    case 'range-rejected':
      return 'onboarding.modelSetupFailureNetwork';
    case 'unavailable':
      return 'onboarding.modelSetupFailureUnavailable';
    case 'cancelled':
      return 'onboarding.modelSetupCancelDisclosure';
    default:
      return 'onboarding.modelSetupFailureGeneric';
  }
}

/** A saved partial owns its recovery presentation; it must not share a second failure callout. */
export function modelSetupFailureVisible(
  snapshot: LocalModelSnapshot | null,
  failure: LocalModelFailure | null,
): boolean {
  return !hasResumableModelDownload(snapshot) && (snapshot?.state === 'failed' || failure !== null);
}

import type { LocalModelFailure, LocalModelSnapshot, LocalModelState } from './model';

/**
 * UI-only labels for the model lifecycle. The native state remains the source of truth; this
 * boundary keeps screen copy from accidentally changing lifecycle or integrity semantics.
 */
export function modelProgressPercent(snapshot: LocalModelSnapshot): number {
  return Math.min(100, Math.max(0, Math.round(snapshot.progress * 100)));
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
    case 'deleting':
      return 'settings.modelStorageWorking';
  }
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

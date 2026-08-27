import type { LocalModelManifest } from './manifest';

export const LOCAL_MODEL_STATES = [
  'not-installed',
  'downloading',
  'verifying',
  'ready',
  'loaded',
  'failed',
  'cancelling',
  'deleting',
] as const;
export type LocalModelState = (typeof LOCAL_MODEL_STATES)[number];

export const LOCAL_MODEL_FAILURES = [
  'offline',
  'insufficient-space',
  'upstream-missing',
  'http-failed',
  'redirect-rejected',
  'range-rejected',
  'size-mismatch',
  'checksum-mismatch',
  'incompatible',
  'cancelled',
  'unavailable',
  'runtime-failed',
  'storage-protection',
  'interrupted',
  'verification-required',
  'unknown',
] as const;
export type LocalModelFailure = (typeof LOCAL_MODEL_FAILURES)[number];

export type LocalModelSnapshot = {
  readonly packId: string;
  readonly state: LocalModelState;
  readonly bytesReceived: number;
  readonly expectedBytes: number;
  readonly progress: number;
  readonly failure: LocalModelFailure | null;
  readonly storageBytes: number;
  readonly loaded: boolean;
};

export const notInstalledSnapshot = (manifest: LocalModelManifest): LocalModelSnapshot => ({
  packId: manifest.pack.id,
  state: 'not-installed',
  bytesReceived: 0,
  expectedBytes: manifest.pack.artifact.bytes,
  progress: 0,
  failure: null,
  storageBytes: 0,
  loaded: false,
});

export function normalizeLocalModelSnapshot(
  value: unknown,
  manifest: LocalModelManifest,
): LocalModelSnapshot {
  if (value === null || typeof value !== 'object') return notInstalledSnapshot(manifest);
  const candidate = value as Record<string, unknown>;
  const state = candidate.state;
  if (!LOCAL_MODEL_STATES.includes(state as LocalModelState)) return notInstalledSnapshot(manifest);
  const bytesReceived =
    typeof candidate.bytesReceived === 'number' && Number.isSafeInteger(candidate.bytesReceived)
      ? Math.max(0, candidate.bytesReceived)
      : 0;
  const expectedBytes = manifest.pack.artifact.bytes;
  const progress = Math.min(1, Math.max(0, bytesReceived / expectedBytes));
  const failure = LOCAL_MODEL_FAILURES.includes(candidate.failure as LocalModelFailure)
    ? (candidate.failure as LocalModelFailure)
    : null;
  const integrityFailure =
    (state === 'ready' || state === 'loaded') &&
    (bytesReceived !== expectedBytes || failure !== null);
  return {
    packId: manifest.pack.id,
    state: integrityFailure ? 'failed' : (state as LocalModelState),
    bytesReceived,
    expectedBytes,
    progress,
    failure: integrityFailure ? (failure ?? 'size-mismatch') : failure,
    storageBytes:
      typeof candidate.storageBytes === 'number' && Number.isSafeInteger(candidate.storageBytes)
        ? Math.max(0, candidate.storageBytes)
        : !integrityFailure && (state === 'ready' || state === 'loaded')
          ? expectedBytes
          : 0,
    loaded: !integrityFailure && (state === 'loaded' || candidate.loaded === true),
  };
}

export function canCompleteModelOnboarding(snapshot: LocalModelSnapshot): boolean {
  return (
    (snapshot.state === 'ready' || snapshot.state === 'loaded') &&
    snapshot.failure === null &&
    snapshot.bytesReceived === snapshot.expectedBytes
  );
}

export function canStartAutomatedExtraction(snapshot: LocalModelSnapshot): boolean {
  return canCompleteModelOnboarding(snapshot);
}

export function isModelDownloadActive(snapshot: LocalModelSnapshot): boolean {
  return (
    snapshot.state === 'downloading' ||
    snapshot.state === 'verifying' ||
    snapshot.state === 'cancelling'
  );
}

/**
 * A partial can be continued only from a terminal, non-integrity state. Active transfers keep
 * their cancel action, while a verified-size/checksum failure has already discarded its bytes.
 */
export function hasResumableModelDownload(snapshot: LocalModelSnapshot | null): boolean {
  return (
    snapshot !== null &&
    (snapshot.state === 'not-installed' || snapshot.state === 'failed') &&
    snapshot.bytesReceived > 0 &&
    snapshot.bytesReceived < snapshot.expectedBytes
  );
}

export type LocalModelEvent =
  | { readonly kind: 'download-requested' }
  | { readonly kind: 'progress'; readonly bytesReceived: number }
  | { readonly kind: 'verification-started' }
  | { readonly kind: 'verified' }
  | { readonly kind: 'loaded' }
  | { readonly kind: 'unloaded' }
  | { readonly kind: 'cancel-requested' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'delete-requested' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'failed'; readonly failure: LocalModelFailure };

/** Pure transition guard used by both the UI and native-state focused tests. */
export function applyLocalModelEvent(
  snapshot: LocalModelSnapshot,
  event: LocalModelEvent,
): LocalModelSnapshot {
  const base = { ...snapshot, failure: null };
  switch (event.kind) {
    case 'download-requested':
      return { ...base, state: 'downloading', bytesReceived: 0, progress: 0 };
    case 'progress': {
      const bytesReceived = Math.min(snapshot.expectedBytes, Math.max(0, event.bytesReceived));
      return {
        ...base,
        state: 'downloading',
        bytesReceived,
        progress: bytesReceived / snapshot.expectedBytes,
      };
    }
    case 'verification-started':
      return { ...base, state: 'verifying' };
    case 'verified':
      return {
        ...base,
        state: 'ready',
        bytesReceived: snapshot.expectedBytes,
        progress: 1,
        storageBytes: snapshot.expectedBytes,
      };
    case 'loaded':
      return { ...base, state: 'loaded', loaded: true };
    case 'unloaded':
      return { ...base, state: 'ready', loaded: false };
    case 'cancel-requested':
      return { ...base, state: 'cancelling' };
    case 'cancelled':
      return { ...base, state: 'not-installed', loaded: false };
    case 'delete-requested':
      return { ...base, state: 'deleting' };
    case 'deleted':
      return {
        ...base,
        state: 'not-installed',
        bytesReceived: 0,
        progress: 0,
        storageBytes: 0,
        loaded: false,
      };
    case 'failed':
      return { ...snapshot, state: 'failed', loaded: false, failure: event.failure };
  }
}

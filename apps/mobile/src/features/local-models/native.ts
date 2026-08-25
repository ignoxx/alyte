import { productionLocalModelManifest } from './manifest';
import { normalizeLocalModelSnapshot, type LocalModelSnapshot } from './model';

export type NativeLocalModelsModule = {
  readonly getManifest: () => unknown;
  readonly getState: () => unknown;
  readonly startDownload: (packId: string) => Promise<unknown>;
  readonly cancelDownload: () => Promise<unknown>;
  readonly load: (packId: string) => Promise<unknown>;
  readonly unload: () => unknown;
  readonly deletePack: (packId: string) => Promise<unknown>;
  readonly addListener?: (
    event: 'stateChanged',
    listener: (value: unknown) => void,
  ) => { remove: () => void };
};

export type LocalModelService = {
  readonly manifest: typeof productionLocalModelManifest;
  readonly getState: () => Promise<LocalModelSnapshot>;
  readonly subscribe: (listener: (snapshot: LocalModelSnapshot) => void) => () => void;
  readonly startDownload: () => Promise<LocalModelSnapshot>;
  readonly cancelDownload: () => Promise<LocalModelSnapshot>;
  readonly load: () => Promise<LocalModelSnapshot>;
  readonly unload: () => Promise<LocalModelSnapshot>;
  readonly deletePack: () => Promise<LocalModelSnapshot>;
};

export type LocalModelServiceOptions = {
  readonly native?: NativeLocalModelsModule | null;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function nativeManifestMatches(value: unknown): boolean {
  try {
    return (
      JSON.stringify(canonical(value)) === JSON.stringify(canonical(productionLocalModelManifest))
    );
  } catch {
    return false;
  }
}

export function createLocalModelService(options: LocalModelServiceOptions = {}): LocalModelService {
  let native: NativeLocalModelsModule | null;
  if (options.native !== undefined) {
    native = options.native;
  } else {
    native = resolveNativeModule();
  }
  // Native and JS must agree on the reviewed pack before any operation can proceed. A mismatch
  // becomes the ordinary unavailable gate; it never falls back to a different model contract.
  if (native !== null) {
    try {
      if (!nativeManifestMatches(native.getManifest())) native = null;
    } catch {
      native = null;
    }
  }
  let snapshot = normalizeLocalModelSnapshot(native?.getState(), productionLocalModelManifest);
  const listeners = new Set<(value: LocalModelSnapshot) => void>();
  native?.addListener?.('stateChanged', (value) => {
    snapshot = normalizeLocalModelSnapshot(value, productionLocalModelManifest);
    listeners.forEach((listener) => listener(snapshot));
  });

  function unavailable(): never {
    throw Object.assign(new Error('The local model module is unavailable'), {
      failure: 'unavailable' as const,
    });
  }

  async function stateAfter(work: () => Promise<unknown> | unknown): Promise<LocalModelSnapshot> {
    if (native === null) unavailable();
    const value = await work();
    snapshot = normalizeLocalModelSnapshot(value, productionLocalModelManifest);
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  return {
    manifest: productionLocalModelManifest,
    getState: async () => {
      if (native === null) unavailable();
      snapshot = normalizeLocalModelSnapshot(native.getState(), productionLocalModelManifest);
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    startDownload: () =>
      stateAfter(() => native?.startDownload(productionLocalModelManifest.pack.id)),
    cancelDownload: () => stateAfter(() => native?.cancelDownload()),
    load: () => stateAfter(() => native?.load(productionLocalModelManifest.pack.id)),
    unload: () => stateAfter(() => native?.unload()),
    deletePack: () => stateAfter(() => native?.deletePack(productionLocalModelManifest.pack.id)),
  };
}

/**
 * Synthetic lifecycle bridge for simulator acceptance. It never writes or bundles model bytes
 * and is only selected by an explicit non-production environment flag in service composition.
 */
export function createFakeLocalModelNativeModule(): NativeLocalModelsModule {
  let state: Record<string, unknown> = {
    packId: productionLocalModelManifest.pack.id,
    state: 'not-installed',
    bytesReceived: 0,
    expectedBytes: productionLocalModelManifest.pack.artifact.bytes,
    storageBytes: 0,
    loaded: false,
    failure: null,
  };
  const listeners = new Set<(value: unknown) => void>();
  let cancellationRequested = false;
  const emit = (next: Record<string, unknown>) => {
    state = next;
    listeners.forEach((listener) => listener(state));
    return state;
  };
  const ensurePack = (packId: string) => {
    if (packId !== productionLocalModelManifest.pack.id) {
      throw Object.assign(new Error('Unsupported local model pack'), { failure: 'incompatible' });
    }
  };
  const wait = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  const transferPhaseDelay = 1_200;

  return {
    getManifest: () => productionLocalModelManifest,
    getState: () => state,
    startDownload: async (packId) => {
      ensurePack(packId);
      if (state.state === 'ready' || state.state === 'loaded') return state;
      cancellationRequested = false;
      emit({ ...state, state: 'downloading', failure: null, bytesReceived: 0 });
      await wait(transferPhaseDelay);
      if (cancellationRequested) return state;
      emit({
        ...state,
        state: 'downloading',
        bytesReceived: Math.floor(productionLocalModelManifest.pack.artifact.bytes / 2),
      });
      await wait(transferPhaseDelay);
      if (cancellationRequested) return state;
      emit({ ...state, state: 'verifying' });
      await wait(transferPhaseDelay);
      if (cancellationRequested) return state;
      return emit({
        ...state,
        state: 'ready',
        bytesReceived: productionLocalModelManifest.pack.artifact.bytes,
        storageBytes: productionLocalModelManifest.pack.artifact.bytes,
        failure: null,
      });
    },
    cancelDownload: async () => {
      cancellationRequested = true;
      return emit({
        ...state,
        state: 'not-installed',
        bytesReceived: 0,
        storageBytes: 0,
        loaded: false,
        failure: null,
      });
    },
    load: async (packId) => {
      ensurePack(packId);
      if (state.state !== 'ready' && state.state !== 'loaded') {
        throw Object.assign(new Error('The local model is not ready'), { failure: 'unavailable' });
      }
      return emit({ ...state, state: 'loaded', loaded: true });
    },
    unload: () =>
      emit({ ...state, state: state.state === 'loaded' ? 'ready' : state.state, loaded: false }),
    deletePack: async (packId) => {
      ensurePack(packId);
      return emit({
        ...state,
        state: 'not-installed',
        bytesReceived: 0,
        storageBytes: 0,
        loaded: false,
        failure: null,
      });
    },
    addListener: (_event, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
}

function resolveNativeModule(): NativeLocalModelsModule | null {
  // Keep the native-only import out of the Node test graph. Metro resolves this CommonJS require
  // in the iOS development client, while plain Node receives the unavailable service below.
  if (typeof navigator === 'undefined') return null;
  try {
    const modules = require('expo-modules-core') as {
      requireOptionalNativeModule<T>(name: string): T | null;
    };
    return modules.requireOptionalNativeModule<NativeLocalModelsModule>('AlyteLocalModels');
  } catch {
    return null;
  }
}

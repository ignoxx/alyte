import { productionLocalModelManifest } from './manifest';
import { normalizeLocalModelSnapshot, type LocalModelSnapshot } from './model';
import { SEMANTIC_MAPPER_LIMITS } from './semantic-contract';

export type NativeLocalModelsModule = {
  readonly getManifest: () => unknown;
  readonly getState: () => unknown;
  readonly startDownload: (packId: string) => Promise<unknown>;
  readonly cancelDownload: () => Promise<unknown>;
  readonly load: (packId: string) => Promise<unknown>;
  readonly infer: (
    prompt: string,
    maxOutputTokens: number,
    outputCapacity: number,
  ) => Promise<unknown>;
  readonly inferImage?: (
    prompt: string,
    imageURI: string,
    maxOutputTokens: number,
    outputCapacity: number,
  ) => Promise<unknown>;
  readonly inferImageRaw?: (
    prompt: string,
    imageURI: string,
    maxOutputTokens: number,
    outputCapacity: number,
  ) => Promise<unknown>;
  readonly cancelInference: () => unknown;
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
  /** Returns one bounded, grammar-constrained JSON response; raw output never gets logged. */
  readonly infer: (
    prompt: string,
    limits?: {
      readonly maxOutputTokens: number;
      readonly outputCapacity: number;
    },
  ) => Promise<string>;
  /** Runs one bounded VLM request against an app-sandboxed page/band image URI. */
  readonly inferImage: (
    prompt: string,
    imageURI: string,
    limits: { readonly maxOutputTokens: number; readonly outputCapacity: number },
  ) => Promise<string>;
  /** Runs one bounded free-form OCR request without the structured JSON grammar. */
  readonly inferImageRaw?: (
    prompt: string,
    imageURI: string,
    limits: { readonly maxOutputTokens: number; readonly outputCapacity: number },
  ) => Promise<string>;
  /** Signals the native generation loop without waiting behind its serialized work queue. */
  readonly cancelInference: () => void;
  readonly unload: () => Promise<LocalModelSnapshot>;
  readonly deletePack: () => Promise<LocalModelSnapshot>;
};

export type LocalModelServiceOptions = {
  readonly native?: NativeLocalModelsModule | null;
  /** Test seam and startup recovery for a native module registered after service construction. */
  readonly resolveNative?: () => NativeLocalModelsModule | null;
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
  const listeners = new Set<(value: LocalModelSnapshot) => void>();
  let native: NativeLocalModelsModule | null = null;
  let listenerNative: NativeLocalModelsModule | null = null;
  let snapshot = normalizeLocalModelSnapshot(undefined, productionLocalModelManifest);
  const discoverNative = options.resolveNative ?? resolveNativeModule;

  function acceptNative(candidate: NativeLocalModelsModule | null): NativeLocalModelsModule | null {
    if (candidate === null) return null;
    // Native and JS must agree on the reviewed pack before any operation can proceed. A mismatch
    // becomes the ordinary unavailable gate; it never falls back to a different model contract.
    try {
      if (!nativeManifestMatches(candidate.getManifest())) return null;
    } catch {
      return null;
    }
    native = candidate;
    if (listenerNative !== candidate) {
      candidate.addListener?.('stateChanged', (value) => {
        snapshot = normalizeLocalModelSnapshot(value, productionLocalModelManifest);
        listeners.forEach((listener) => listener(snapshot));
      });
      listenerNative = candidate;
    }
    return candidate;
  }

  function resolveNative(): NativeLocalModelsModule | null {
    if (native !== null) return native;
    if (options.native !== undefined) return null;
    return acceptNative(discoverNative());
  }

  native = acceptNative(options.native !== undefined ? options.native : discoverNative());
  snapshot = normalizeLocalModelSnapshot(native?.getState(), productionLocalModelManifest);

  function unavailable(): never {
    throw Object.assign(new Error('The local model module is unavailable'), {
      failure: 'unavailable' as const,
    });
  }

  function requireNative(): NativeLocalModelsModule {
    const resolved = resolveNative();
    if (resolved === null) unavailable();
    return resolved;
  }

  async function stateAfter(work: () => Promise<unknown> | unknown): Promise<LocalModelSnapshot> {
    const value = await work();
    snapshot = normalizeLocalModelSnapshot(value, productionLocalModelManifest);
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  return {
    manifest: productionLocalModelManifest,
    getState: async () => {
      const resolved = requireNative();
      snapshot = normalizeLocalModelSnapshot(resolved.getState(), productionLocalModelManifest);
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    startDownload: () =>
      stateAfter(() => requireNative().startDownload(productionLocalModelManifest.pack.id)),
    cancelDownload: () => stateAfter(() => requireNative().cancelDownload()),
    load: () => stateAfter(() => requireNative().load(productionLocalModelManifest.pack.id)),
    infer: async (prompt, limits) => {
      const resolved = requireNative();
      if (snapshot.state !== 'loaded' || !snapshot.loaded) {
        throw Object.assign(new Error('The local model is not loaded'), { failure: 'unavailable' });
      }
      const maxOutputTokens = limits?.maxOutputTokens ?? SEMANTIC_MAPPER_LIMITS.outputTokenLimit;
      const outputCapacity = limits?.outputCapacity ?? SEMANTIC_MAPPER_LIMITS.maxOutputBytes;
      if (
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        maxOutputTokens > SEMANTIC_MAPPER_LIMITS.outputTokenLimit ||
        !Number.isSafeInteger(outputCapacity) ||
        outputCapacity < 1 ||
        outputCapacity > SEMANTIC_MAPPER_LIMITS.maxOutputBytes
      ) {
        throw Object.assign(new Error('The local model inference limits are invalid'), {
          failure: 'incompatible',
        });
      }
      const output = await resolved.infer(prompt, maxOutputTokens, outputCapacity);
      if (typeof output !== 'string') {
        throw Object.assign(new Error('The local model returned malformed output'), {
          failure: 'runtime-failed',
        });
      }
      return output;
    },
    inferImage: async (prompt, imageURI, limits) => {
      const resolved = requireNative();
      if (snapshot.state !== 'loaded' || !snapshot.loaded) {
        throw Object.assign(new Error('The local model is not loaded'), { failure: 'unavailable' });
      }
      if (
        !imageURI.startsWith('file://') ||
        !Number.isSafeInteger(limits.maxOutputTokens) ||
        limits.maxOutputTokens < 1 ||
        limits.maxOutputTokens > 2_048 ||
        !Number.isSafeInteger(limits.outputCapacity) ||
        limits.outputCapacity < 1 ||
        limits.outputCapacity > 131_072
      ) {
        throw Object.assign(new Error('The local VLM inference input is invalid'), {
          failure: 'incompatible',
        });
      }
      if (resolved.inferImage === undefined) {
        throw Object.assign(new Error('The local VLM runtime is unavailable'), {
          failure: 'unavailable',
        });
      }
      const output = await resolved.inferImage(
        prompt,
        imageURI,
        limits.maxOutputTokens,
        limits.outputCapacity,
      );
      if (typeof output !== 'string') {
        throw Object.assign(new Error('The local VLM returned malformed output'), {
          failure: 'runtime-failed',
        });
      }
      return output;
    },
    inferImageRaw: async (prompt, imageURI, limits) => {
      const resolved = requireNative();
      if (snapshot.state !== 'loaded' || !snapshot.loaded) {
        throw Object.assign(new Error('The local model is not loaded'), { failure: 'unavailable' });
      }
      if (
        prompt !== 'OCR:' ||
        !imageURI.startsWith('file://') ||
        !Number.isSafeInteger(limits.maxOutputTokens) ||
        limits.maxOutputTokens < 1 ||
        limits.maxOutputTokens > 4_096 ||
        !Number.isSafeInteger(limits.outputCapacity) ||
        limits.outputCapacity < 1 ||
        limits.outputCapacity > 131_072
      ) {
        throw Object.assign(new Error('The local OCR inference input is invalid'), {
          failure: 'incompatible',
        });
      }
      if (resolved.inferImageRaw === undefined) {
        throw Object.assign(new Error('The local OCR runtime is unavailable'), {
          failure: 'unavailable',
        });
      }
      const output = await resolved.inferImageRaw(
        prompt,
        imageURI,
        limits.maxOutputTokens,
        limits.outputCapacity,
      );
      if (typeof output !== 'string') {
        throw Object.assign(new Error('The local OCR runtime returned malformed output'), {
          failure: 'runtime-failed',
        });
      }
      return output;
    },
    cancelInference: () => {
      resolveNative()?.cancelInference();
    },
    unload: () => stateAfter(() => requireNative().unload()),
    deletePack: () =>
      stateAfter(() => requireNative().deletePack(productionLocalModelManifest.pack.id)),
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
    expectedBytes: productionLocalModelManifest.pack.bytes,
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
      emit({ ...state, state: 'downloading', failure: null });
      await wait(transferPhaseDelay);
      if (cancellationRequested) return state;
      emit({
        ...state,
        state: 'downloading',
        bytesReceived: Math.max(
          Number(state.bytesReceived ?? 0),
          Math.floor(productionLocalModelManifest.pack.bytes / 2),
        ),
      });
      await wait(transferPhaseDelay);
      if (cancellationRequested) return state;
      emit({ ...state, state: 'verifying' });
      await wait(transferPhaseDelay);
      if (cancellationRequested) return state;
      return emit({
        ...state,
        state: 'ready',
        bytesReceived: productionLocalModelManifest.pack.bytes,
        storageBytes: productionLocalModelManifest.pack.bytes,
        failure: null,
      });
    },
    cancelDownload: async () => {
      cancellationRequested = true;
      return emit({
        ...state,
        state: 'not-installed',
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
    infer: async (prompt, _maxOutputTokens, _outputCapacity) =>
      JSON.stringify({
        schemaVersion: 'alyte.geometry-variant-selector.v2',
        // The explicit simulator fake represents a valid conservative model: it selects no
        // source variant, but it must still satisfy the exact one- or two-row production grammar
        // so integrated extraction reaches honest review instead of a synthetic contract failure.
        selections: prompt.includes('["r1",') ? { r0: null, r1: null } : { r0: null },
      }),
    inferImage: async (_prompt, _imageURI, _maxOutputTokens, _outputCapacity) =>
      JSON.stringify({ rows: [] }),
    inferImageRaw: async (_prompt, _imageURI, _maxOutputTokens, _outputCapacity) => '',
    cancelInference: () => undefined,
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

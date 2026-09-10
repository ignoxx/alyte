export const HOME_LAYOUT_PREFERENCE = 'app.home.layout';

export const HOME_LAYOUTS = ['masonry', 'list'] as const;
export type HomeLayout = (typeof HOME_LAYOUTS)[number];

export type HomeLayoutPreferenceSource = {
  readonly getLocalPreference: (key: string) => Promise<string | null>;
  readonly setLocalPreference: (key: string, value: string) => Promise<void>;
};

export type HomeLayoutPreferenceError = 'read-failed' | 'write-failed';

export type HomeLayoutPreferenceState = {
  readonly layout: HomeLayout;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: HomeLayoutPreferenceError | null;
};

export const DEFAULT_HOME_LAYOUT: HomeLayout = 'masonry';

export const initialHomeLayoutPreferenceState: HomeLayoutPreferenceState = {
  layout: DEFAULT_HOME_LAYOUT,
  loading: true,
  saving: false,
  error: null,
};

export function isHomeLayout(value: unknown): value is HomeLayout {
  return value === 'masonry' || value === 'list';
}

/**
 * A missing or old preference has a conservative, deterministic presentation default. The
 * persisted value is a display choice and carries no health meaning, so unknown values can be
 * safely treated as the default while the source remains unchanged.
 */
export function decodeHomeLayout(value: string | null | undefined): HomeLayout {
  return isHomeLayout(value) ? value : DEFAULT_HOME_LAYOUT;
}

export async function readHomeLayout(source: HomeLayoutPreferenceSource): Promise<HomeLayout> {
  return decodeHomeLayout(await source.getLocalPreference(HOME_LAYOUT_PREFERENCE));
}

export async function writeHomeLayout(
  source: HomeLayoutPreferenceSource,
  layout: HomeLayout,
): Promise<void> {
  await source.setLocalPreference(HOME_LAYOUT_PREFERENCE, layout);
}

export type HomeLayoutPreferenceController = {
  readonly getSnapshot: () => HomeLayoutPreferenceState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly setLayout: (next: HomeLayout) => Promise<void>;
};

/**
 * Owns the small asynchronous state machine behind the Settings control. It deliberately keeps
 * the chosen value unchanged until storage confirms the write, and coalesces callers while one
 * write is in flight so a late failure cannot publish an optimistic choice.
 */
export function createHomeLayoutPreferenceController(
  source: HomeLayoutPreferenceSource,
): HomeLayoutPreferenceController {
  let state = initialHomeLayoutPreferenceState;
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  let savePromise: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function update(next: HomeLayoutPreferenceState): void {
    state = next;
    notify();
  }

  async function load(): Promise<void> {
    if (loadPromise !== null) return loadPromise;
    if (loaded) return;
    const work = (async () => {
      try {
        const layout = await readHomeLayout(source);
        loaded = true;
        update({ layout, loading: false, saving: state.saving, error: null });
      } catch {
        loaded = true;
        update({ ...state, loading: false, error: 'read-failed' });
      }
    })();
    loadPromise = work;
    update({ ...state, loading: true, error: null });
    void work.then(
      () => {
        if (loadPromise === work) loadPromise = null;
      },
      () => {
        if (loadPromise === work) loadPromise = null;
      },
    );
    return work;
  }

  async function retry(): Promise<void> {
    if (savePromise !== null) return savePromise;
    loaded = false;
    return load();
  }

  async function setLayout(next: HomeLayout): Promise<void> {
    if (!isHomeLayout(next)) return;
    if (savePromise !== null) return savePromise;
    // Do not let a user choice race an unread preference, or turn an unreadable store into a
    // value that looks durably selected. Settings exposes retry for this state.
    if (state.loading || state.error === 'read-failed') return;
    if (next === state.layout) return;

    const work = (async () => {
      try {
        await writeHomeLayout(source, next);
        // Only this successful write changes the shared value. A failed write leaves the prior
        // choice visible and gives Settings an actionable error state.
        update({ ...state, layout: next, saving: false, error: null });
      } catch {
        update({ ...state, saving: false, error: 'write-failed' });
      }
    })();
    savePromise = work;
    update({ ...state, saving: true, error: null });
    void work.then(
      () => {
        if (savePromise === work) savePromise = null;
      },
      () => {
        if (savePromise === work) savePromise = null;
      },
    );
    return work;
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    retry,
    setLayout,
  };
}

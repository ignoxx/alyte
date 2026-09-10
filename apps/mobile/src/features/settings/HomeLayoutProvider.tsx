import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';
import { useAppLock } from '../app-lock/AppLockProvider';
import { useServices } from '../../services';
import {
  createHomeLayoutPreferenceController,
  type HomeLayout,
  type HomeLayoutPreferenceController,
  type HomeLayoutPreferenceState,
} from './home-layout-preference';

export type HomeLayoutContextValue = HomeLayoutPreferenceState & {
  readonly setLayout: (next: HomeLayout) => Promise<void>;
  readonly retry: () => Promise<void>;
};

const HomeLayoutContext = createContext<HomeLayoutContextValue | null>(null);

export function HomeLayoutProvider({ children }: PropsWithChildren) {
  const services = useServices();
  const { state: appLockState } = useAppLock();
  const controller = useMemo<HomeLayoutPreferenceController>(
    () => createHomeLayoutPreferenceController(services.intake),
    [services.intake],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    if (appLockState.phase !== 'unlocked') return;
    // The intake service opens the shared protected database lazily. Waiting for the app-lock
    // gate avoids racing its policy read during cold startup.
    void controller.load();
  }, [appLockState.phase, controller]);

  const value = useMemo<HomeLayoutContextValue>(
    () => ({ ...state, retry: controller.retry, setLayout: controller.setLayout }),
    [controller, state],
  );

  return <HomeLayoutContext.Provider value={value}>{children}</HomeLayoutContext.Provider>;
}

export function useHomeLayout(): HomeLayoutContextValue {
  const value = useContext(HomeLayoutContext);
  if (value === null) throw new Error('Home layout is unavailable outside HomeLayoutProvider');
  return value;
}

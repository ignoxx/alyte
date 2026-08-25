import { createContext, useContext, useSyncExternalStore, type PropsWithChildren } from 'react';
import type { AppLockController } from './controller';
import type { AppLockState } from './policy';

type AppLockContextValue = {
  readonly controller: AppLockController;
  readonly state: AppLockState;
};

const AppLockContext = createContext<AppLockContextValue | null>(null);

export function AppLockProvider({
  controller,
  children,
}: PropsWithChildren<{ readonly controller: AppLockController }>) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return (
    <AppLockContext.Provider value={{ controller, state }}>{children}</AppLockContext.Provider>
  );
}

export function useAppLock(): AppLockContextValue {
  const value = useContext(AppLockContext);
  if (value === null) throw new Error('App lock is unavailable outside AppLockProvider');
  return value;
}

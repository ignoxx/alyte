import { createContext, useContext } from 'react';

export type AppResetController = {
  /** Reconstructs app services and presents onboarding from the welcome page. */
  readonly restartAtOnboarding: () => void;
};

export const AppResetContext = createContext<AppResetController | null>(null);

export function useAppReset(): AppResetController {
  const controller = useContext(AppResetContext);
  if (controller === null) {
    throw new Error('App reset is unavailable outside the application provider');
  }
  return controller;
}

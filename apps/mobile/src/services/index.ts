import { createContext, useContext } from 'react';
import { loadShowcaseSnapshot, type ShowcaseSnapshot } from '@alyte/fixtures';
import type { AlyteRuntime, RuntimeVariant, ServiceClock } from '@alyte/domain';
import { createLabsService, type LabsService } from '../features/labs/service';
import { createLabReportsService, type LabReportsService } from '../features/labs/report-service';
import { openProtectedLabDatabase, type LabRepository } from '../features/labs/persistence';

export interface AlyteServices {
  readonly runtime: AlyteRuntime;
  readonly clock: ServiceClock;
  readonly showcase: ShowcaseSnapshot | null;
  readonly labs: LabsService;
  readonly reports: LabReportsService;
}

export function runtimeVariant(): RuntimeVariant {
  const value = process.env.EXPO_PUBLIC_APP_VARIANT ?? process.env.APP_VARIANT;
  return value === 'preview' || value === 'production' ? value : 'development';
}

export function createServices(variant: RuntimeVariant = runtimeVariant()): AlyteServices {
  const requestedShowcase = process.env.EXPO_PUBLIC_SHOWCASE_MODE === 'true';
  const showcase = loadShowcaseSnapshot(variant, requestedShowcase && variant !== 'production');

  let repositoryPromise: Promise<LabRepository> | null = null;
  const repositoryFactory = () => {
    repositoryPromise ??= openProtectedLabDatabase();
    return repositoryPromise;
  };

  return {
    runtime: {
      variant,
      cloudEnvironment: variant === 'production' ? 'production' : 'none',
    },
    clock: { now: () => new Date() },
    showcase,
    labs: createLabsService({ repositoryFactory }),
    reports: createLabReportsService({ repositoryFactory }),
  };
}

export const ServicesContext = createContext<AlyteServices | null>(null);

export function useServices(): AlyteServices {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error('Alyte services are unavailable outside the application provider');
  }
  return services;
}

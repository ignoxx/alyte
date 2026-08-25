import { createContext, useContext } from 'react';
import { loadShowcaseSnapshot, type ShowcaseSnapshot } from '@alyte/fixtures';
import {
  formatIntakeLocalDate,
  type AlyteRuntime,
  type RuntimeVariant,
  type ServiceClock,
} from '@alyte/domain';
import { createLabsService, type LabsService } from '../features/labs/service';
import { createLabReportsService, type LabReportsService } from '../features/labs/report-service';
import { openProtectedLabDatabase, type LabRepository } from '../features/labs/persistence';
import { createIntakeService, type IntakeService } from '../features/intake/service';
import { openProtectedIntakeDatabase, type IntakeRepository } from '../features/intake/persistence';
import { createProtectedIntakeMediaStore } from '../features/intake/media-store';
import {
  createDefaultLocalExportService,
  type LocalExportService,
} from '../features/export/service';
import {
  createLocalControlsService,
  type LocalControlsService,
} from '../features/local-controls/service';
import {
  createFakeLocalModelNativeModule,
  createLocalModelService,
  type LocalModelService,
} from '../features/local-models/native';
import { createLocalSemanticMapper } from '../features/local-models/semantic-mapper';
import {
  missingShowcaseIntakeInputs,
  seedShowcaseLabRecords,
  showcaseIntakeInputs,
} from './showcase-seed';

export interface AlyteServices {
  readonly runtime: AlyteRuntime;
  readonly clock: ServiceClock;
  readonly showcase: ShowcaseSnapshot | null;
  readonly labs: LabsService;
  readonly reports: LabReportsService;
  readonly intake: IntakeService;
  readonly export: LocalExportService;
  readonly controls: LocalControlsService;
  readonly models: LocalModelService;
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
  let intakeRepositoryPromise: Promise<IntakeRepository> | null = null;
  const intakeRepositoryFactory = () => {
    intakeRepositoryPromise ??= openProtectedIntakeDatabase();
    return intakeRepositoryPromise;
  };

  const clock = { now: () => new Date() };

  const intake = createIntakeService({
    repositoryFactory: intakeRepositoryFactory,
    clock,
    mediaStore: createProtectedIntakeMediaStore(),
  });

  const labs = createLabsService({ repositoryFactory });
  const exportService = createDefaultLocalExportService();
  const controls = createLocalControlsService({
    variant,
    appVersion: '0.1.0',
  });
  const fakeModelState = process.env.EXPO_PUBLIC_LOCAL_MODEL_FAKE === 'true';
  const models =
    fakeModelState && variant !== 'production'
      ? createLocalModelService({ native: createFakeLocalModelNativeModule() })
      : createLocalModelService();
  const semanticMapper = createLocalSemanticMapper({ models });

  if (showcase !== null) {
    void seedShowcaseLabRecords(labs);
    void seedShowcaseIntake(intake, showcase, clock);
  }

  return {
    runtime: {
      variant,
      cloudEnvironment: variant === 'production' ? 'production' : 'none',
    },
    clock,
    showcase,
    labs,
    reports: createLabReportsService({ repositoryFactory, semanticMapper }),
    intake,
    export: exportService,
    controls,
    models,
  };
}

async function seedShowcaseIntake(
  intake: IntakeService,
  showcase: ShowcaseSnapshot,
  clock: ServiceClock,
): Promise<void> {
  try {
    const existingIds = new Set((await intake.listEvents()).map((event) => event.id));
    const localDate = formatIntakeLocalDate(clock.now());
    const missingInputs = missingShowcaseIntakeInputs(
      showcaseIntakeInputs(showcase, localDate),
      existingIds,
    );
    for (const input of missingInputs) {
      try {
        await intake.createEvent(input);
      } catch {
        // A later launch retries this missing fixture without overwriting user edits or records.
      }
    }
  } catch {
    // Showcase seeding is an optional development aid; local mode stays usable if its store is unavailable.
  }
}

export const ServicesContext = createContext<AlyteServices | null>(null);

export function useServices(): AlyteServices {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error('Alyte services are unavailable outside the application provider');
  }
  return services;
}

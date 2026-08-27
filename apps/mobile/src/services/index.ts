import { createContext, useContext } from 'react';
import { loadShowcaseSnapshot, type ShowcaseSnapshot } from '@alyte/fixtures';
import {
  formatIntakeLocalDate,
  type AlyteRuntime,
  type RuntimeVariant,
  type ServiceClock,
} from '@alyte/domain';
import { createLabsService, type LabsService } from '../features/labs/service';
import {
  createDefaultExtractionAliases,
  createLabReportsService,
  type LabReportsService,
} from '../features/labs/report-service';
import { openProtectedLabDatabase, type LabRepository } from '../features/labs/persistence';
import {
  createIntakeService,
  type IntakeMediaStore,
  type IntakeService,
} from '../features/intake/service';
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
import { createSharedDatabaseRepositoryFactories } from './shared-database';
import { createCloudAccountService, type CloudAccountService } from '../features/account/service';
import { CloudApiClient } from '../features/account/cloud-api';
import {
  createCloudCommerceService,
  type CloudCommerceService,
} from '../features/commerce/service';

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
  readonly account: CloudAccountService;
  readonly commerce: CloudCommerceService;
}

export type ServicesCompositionOptions = {
  /** Test seam for the native-backed shared local database open. */
  readonly openLabDatabase?: () => Promise<LabRepository>;
  /** Test seam for the native-backed shared local database open. */
  readonly openIntakeDatabase?: () => Promise<IntakeRepository>;
  /** Test seam for recovery reconciliation without touching device media. */
  readonly intakeMediaStore?: IntakeMediaStore;
  /** Optional test seam for the account boundary; it never shares the local database. */
  readonly account?: CloudAccountService;
  /** Optional test seam for the explicit cloud commerce surface. */
  readonly commerce?: CloudCommerceService;
};

export function runtimeVariant(): RuntimeVariant {
  const value = process.env.EXPO_PUBLIC_APP_VARIANT ?? process.env.APP_VARIANT;
  return value === 'preview' || value === 'production' ? value : 'development';
}

export function createServices(
  variant: RuntimeVariant = runtimeVariant(),
  options: ServicesCompositionOptions = {},
): AlyteServices {
  const requestedShowcase = process.env.EXPO_PUBLIC_SHOWCASE_MODE === 'true';
  const showcase = loadShowcaseSnapshot(variant, requestedShowcase && variant !== 'production');

  const { repositoryFactory, intakeRepositoryFactory } = createSharedDatabaseRepositoryFactories(
    options.openLabDatabase ?? openProtectedLabDatabase,
    options.openIntakeDatabase ?? openProtectedIntakeDatabase,
  );

  const clock = { now: () => new Date() };

  const intake = createIntakeService({
    repositoryFactory: intakeRepositoryFactory,
    clock,
    mediaStore: options.intakeMediaStore ?? createProtectedIntakeMediaStore(),
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
  const semanticMapper = createLocalSemanticMapper({
    models,
    aliases: createDefaultExtractionAliases(),
  });
  // Development and preview intentionally advertise no hosted API. A production URL cannot be
  // reached accidentally from those builds; tests can inject a fake account service or a directly
  // configured client at this boundary.
  const account =
    options.account ??
    createCloudAccountService({
      api:
        variant === 'production'
          ? new CloudApiClient({ requireHttps: true })
          : new CloudApiClient({ baseUrl: null }),
    });
  const commerce =
    options.commerce ??
    createCloudCommerceService({
      account,
    });

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
    account,
    commerce,
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

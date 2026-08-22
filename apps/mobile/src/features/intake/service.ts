import type {
  AnalysisInclusion,
  CreateIntakeEventInput,
  IntakeChange,
  IntakeChangeListener,
  IntakeEvent,
  ServiceClock,
  UpdateIntakeEventInput,
} from '@alyte/domain';
import { openProtectedIntakeDatabase, type IntakeRepository } from './persistence';
import type { IntakeMediaSource } from './media-store';
import { type IntakeCapturePreferences, type IntakeCloudJob, type IntakeCloudMode } from './outbox';

export type IntakeMediaStore = {
  readonly save?: (
    source: IntakeMediaSource,
    captureId: string,
  ) => Promise<{ readonly path: string; readonly byteSize: number | null }>;
  readonly list?: () => Promise<readonly string[]>;
  remove(path: string): Promise<void>;
  verifyRemoved(path: string): Promise<boolean>;
};

export type IntakeService = {
  listEvents(): Promise<readonly IntakeEvent[]>;
  listEventsForDay(localDate: string): Promise<readonly IntakeEvent[]>;
  getEvent(id: string): Promise<IntakeEvent | null>;
  createEvent(input: CreateIntakeEventInput): Promise<IntakeEvent>;
  captureSnap(input: {
    readonly source: IntakeMediaSource;
    readonly event: CreateIntakeEventInput;
    readonly cloudMode?: IntakeCloudMode;
    readonly captureId?: string;
  }): Promise<{ readonly event: IntakeEvent; readonly cloudJob: IntakeCloudJob | null }>;
  updateEvent(id: string, input: UpdateIntakeEventInput): Promise<IntakeEvent>;
  logAgain(id: string, occurredAt?: string): Promise<IntakeEvent>;
  undoLogAgain(id: string): Promise<void>;
  setAnalysisInclusion(id: string, included: boolean): Promise<IntakeEvent>;
  removeIntakeImage(id: string): Promise<IntakeEvent>;
  listCloudJobs(): Promise<readonly IntakeCloudJob[]>;
  getCloudJobForEvent(eventId: string): Promise<IntakeCloudJob | null>;
  cancelCloudAnalysis(eventId: string): Promise<IntakeCloudJob | null>;
  resumeCloudJobs(): Promise<readonly IntakeCloudJob[]>;
  getCapturePreferences(): Promise<IntakeCapturePreferences>;
  setCapturePreferences(
    input: Partial<IntakeCapturePreferences>,
  ): Promise<IntakeCapturePreferences>;
  deleteEvent(id: string): Promise<void>;
  subscribe(listener: IntakeChangeListener): () => void;
};

export type IntakeServiceOptions = {
  readonly repositoryFactory?: () => Promise<IntakeRepository>;
  readonly clock?: ServiceClock;
  readonly mediaStore?: IntakeMediaStore;
};

export function createIntakeService(options: IntakeServiceOptions = {}): IntakeService {
  let repositoryPromise: Promise<IntakeRepository> | null = null;
  let mediaReconciled = false;
  const captureInFlight = new Map<
    string,
    Promise<{ readonly event: IntakeEvent; readonly cloudJob: IntakeCloudJob | null }>
  >();
  const repositoryFactory = options.repositoryFactory ?? (() => openProtectedIntakeDatabase());
  const clock = options.clock ?? { now: () => new Date() };

  async function repository(): Promise<IntakeRepository> {
    repositoryPromise ??= repositoryFactory();
    const repo = await repositoryPromise;
    if (!mediaReconciled && options.mediaStore?.list !== undefined) {
      const [events, paths] = await Promise.all([repo.listEvents(), options.mediaStore.list()]);
      const referenced = new Set(
        events
          .map((event) => event.sourceMediaPath)
          .filter((path): path is string => path !== null),
      );
      for (const path of paths) {
        if (referenced.has(path)) continue;
        await options.mediaStore.remove(path);
        if (!(await options.mediaStore.verifyRemoved(path))) {
          throw new Error('An interrupted Intake Image could not be recovered safely');
        }
      }
      mediaReconciled = true;
    }
    return repo;
  }

  return {
    async listEvents() {
      return (await repository()).listEvents();
    },
    async listEventsForDay(localDate) {
      return (await repository()).listEventsForDay(localDate);
    },
    async getEvent(id) {
      return (await repository()).getEvent(id);
    },
    async createEvent(input) {
      return (await repository()).createEvent(input);
    },
    async captureSnap(input) {
      const captureId =
        input.captureId ?? `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const existingWork = captureInFlight.get(captureId);
      if (existingWork !== undefined) return existingWork;
      const work = (async () => {
        const repo = await repository();
        const existing = await repo.getEvent(input.event.id ?? captureId);
        if (existing !== null) {
          return { event: existing, cloudJob: await repo.getCloudJobForEvent(existing.id) };
        }
        const cloudMode = input.cloudMode ?? (await repo.getCapturePreferences()).cloudMode;
        if (cloudMode === 'consented-cloud') {
          const preferences = await repo.getCapturePreferences();
          if (!preferences.disclosureAcknowledged) {
            throw new Error('Cloud Intake Image disclosure must be acknowledged first');
          }
        }
        const mediaStore = options.mediaStore;
        if (mediaStore?.save === undefined) {
          throw new Error('Intake media storage is unavailable');
        }
        const eventInput = { ...input.event, id: input.event.id ?? captureId };
        const stored = await mediaStore.save(input.source, captureId);
        let result: { readonly event: IntakeEvent; readonly cloudJob: IntakeCloudJob | null };
        try {
          result = await repo.createSnap({
            event: eventInput,
            cloudMode,
            mediaPath: stored.path,
          });
        } catch (error) {
          const duplicate = await repo.getEvent(eventInput.id as string);
          if (duplicate !== null) {
            return { event: duplicate, cloudJob: await repo.getCloudJobForEvent(duplicate.id) };
          }
          await mediaStore.remove(stored.path);
          if (!(await mediaStore.verifyRemoved(stored.path))) {
            throw new Error('The captured Intake Image could not be recovered after save failure', {
              cause: error,
            });
          }
          throw error;
        }
        // A relaunch or duplicate callback may find the event already committed with another
        // protected path. Never retain a second unreferenced image in that case.
        if (result.event.sourceMediaPath !== stored.path) {
          await mediaStore.remove(stored.path);
          if (!(await mediaStore.verifyRemoved(stored.path))) {
            throw new Error('The duplicate Intake Image could not be cleaned up');
          }
        }
        return result;
      })();
      captureInFlight.set(captureId, work);
      try {
        return await work;
      } finally {
        captureInFlight.delete(captureId);
      }
    },
    async updateEvent(id, input) {
      return (await repository()).updateEvent(id, input);
    },
    async logAgain(id, occurredAt) {
      return (await repository()).logAgain(id, occurredAt ?? clock.now().toISOString());
    },
    async undoLogAgain(id) {
      await (await repository()).undoLogAgain(id);
    },
    async setAnalysisInclusion(id, included) {
      const inclusion: AnalysisInclusion = included ? 'included' : 'excluded';
      return (await repository()).setAnalysisInclusion(id, inclusion);
    },
    async removeIntakeImage(id) {
      const repo = await repository();
      const event = await repo.getEvent(id);
      if (event === null) throw new Error('Intake Event was not found');
      if (event.sourceMediaPath !== null) {
        const mediaStore = options.mediaStore;
        if (mediaStore === undefined) throw new Error('Intake media storage is unavailable');
        await mediaStore.remove(event.sourceMediaPath);
        if (!(await mediaStore.verifyRemoved(event.sourceMediaPath))) {
          throw new Error('The Intake Image could not be verified as removed');
        }
      }
      return repo.clearIntakeImage(id);
    },
    async listCloudJobs() {
      return (await repository()).listCloudJobs();
    },
    async getCloudJobForEvent(eventId) {
      return (await repository()).getCloudJobForEvent(eventId);
    },
    async cancelCloudAnalysis(eventId) {
      const repo = await repository();
      const job = await repo.getCloudJobForEvent(eventId);
      return job === null ? null : repo.cancelCloudJob(job.id);
    },
    async resumeCloudJobs() {
      return (await repository()).resumeCloudJobs();
    },
    async getCapturePreferences() {
      return (await repository()).getCapturePreferences();
    },
    async setCapturePreferences(input) {
      return (await repository()).setCapturePreferences(input);
    },
    async deleteEvent(id) {
      const repo = await repository();
      const event = await repo.getEvent(id);
      if (event === null) return;
      if (event.sourceMediaPath !== null) {
        const mediaStore = options.mediaStore;
        if (mediaStore === undefined) throw new Error('Intake media storage is unavailable');
        await mediaStore.remove(event.sourceMediaPath);
        if (!(await mediaStore.verifyRemoved(event.sourceMediaPath))) {
          throw new Error('The Intake Image could not be verified as removed');
        }
      }
      await repo.deleteEvent(id);
    },
    subscribe(listener: IntakeChangeListener): () => void {
      let active = true;
      let unsubscribe: (() => void) | null = null;
      void repository().then((next) => {
        if (active) {
          unsubscribe = next.subscribe(listener);
        }
      });
      return () => {
        active = false;
        unsubscribe?.();
      };
    },
  };
}

export type { IntakeChange };

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
import type { ProtectedCopy } from '../labs/file-service';
import { type IntakeCapturePreferences, type IntakeCloudJob, type IntakeCloudMode } from './outbox';

export type IntakeMediaStore = {
  readonly destination?: (source: IntakeMediaSource, captureId: string) => Promise<string>;
  readonly save?: (source: IntakeMediaSource, captureId: string) => Promise<ProtectedCopy>;
  readonly inspect?: (path: string) => Promise<ProtectedCopy | null>;
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
  getLocalPreference(key: string): Promise<string | null>;
  setLocalPreference(key: string, value: string): Promise<void>;
  deleteEvent(id: string): Promise<void>;
  subscribe(listener: IntakeChangeListener): () => void;
};

export type IntakeServiceOptions = {
  readonly repositoryFactory?: () => Promise<IntakeRepository>;
  readonly clock?: ServiceClock;
  readonly mediaStore?: IntakeMediaStore;
  /** Handoff seam for the future cloud transport; it must not perform provider I/O here. */
  readonly cloudHandoff?: (job: IntakeCloudJob) => Promise<'accepted' | 'deferred'>;
};

export function createIntakeService(options: IntakeServiceOptions = {}): IntakeService {
  let repositoryPromise: Promise<IntakeRepository> | null = null;
  let recoveryReconciled = false;
  const captureInFlight = new Map<
    string,
    Promise<{ readonly event: IntakeEvent; readonly cloudJob: IntakeCloudJob | null }>
  >();
  const repositoryFactory = options.repositoryFactory ?? (() => openProtectedIntakeDatabase());
  const clock = options.clock ?? { now: () => new Date() };

  async function repository(): Promise<IntakeRepository> {
    repositoryPromise ??= repositoryFactory();
    const repo = await repositoryPromise;
    if (!recoveryReconciled) {
      const recoveries = await repo.listSnapRecoveries();
      for (const recovery of recoveries) {
        if (recovery.state === 'failed') continue;
        const mediaStore = options.mediaStore;
        if (mediaStore?.inspect === undefined) {
          await repo.markSnapRecoveryFailed(recovery.captureId, 'interrupted-media-unavailable');
          continue;
        }
        const media = await mediaStore.inspect(recovery.mediaPath);
        if (media === null) {
          await repo.markSnapRecoveryFailed(recovery.captureId, 'interrupted-media-missing');
          continue;
        }
        if (recovery.state === 'capturing') {
          if (media.protection === undefined) {
            await repo.markSnapRecoveryFailed(recovery.captureId, 'interrupted-media-unverified');
            continue;
          }
          await repo.stageSnapRecovery({
            captureId: recovery.captureId,
            mediaHash: media.sourceHash,
            mediaSize: media.byteSize,
            mediaProtection: media.protection,
          });
        }
        if (recovery.state === 'capturing' || recovery.state === 'staged') {
          await repo.commitSnapRecovery(recovery.captureId);
        }
        await repo.finalizeSnapRecovery(recovery.captureId);
      }
      recoveryReconciled = true;
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
        if (mediaStore?.save === undefined || mediaStore.destination === undefined) {
          throw new Error('Intake media storage is unavailable');
        }
        const eventInput = { ...input.event, id: input.event.id ?? captureId };
        const mediaPath = await mediaStore.destination(input.source, captureId);
        const intent = await repo.beginSnapRecovery({
          captureId,
          mediaPath,
          event: eventInput,
          cloudMode,
        });
        if (intent.state === 'committed') {
          const existing = await repo.getEvent(eventInput.id as string);
          if (existing === null) throw new Error('Committed Snap recovery has no Intake Event');
          return { event: existing, cloudJob: await repo.getCloudJobForEvent(existing.id) };
        }
        if (
          intent.state === 'staged' &&
          intent.mediaHash !== null &&
          intent.mediaProtection !== null
        ) {
          const recovered = await repo.commitSnapRecovery(captureId);
          await repo.finalizeSnapRecovery(captureId);
          return recovered;
        }
        let stored: ProtectedCopy;
        let result: { readonly event: IntakeEvent; readonly cloudJob: IntakeCloudJob | null };
        try {
          stored = await mediaStore.save(input.source, captureId);
          if (stored.protection === undefined) {
            throw new Error('Captured Intake Image protection could not be verified');
          }
          await repo.stageSnapRecovery({
            captureId,
            mediaHash: stored.sourceHash,
            mediaSize: stored.byteSize,
            mediaProtection: stored.protection,
          });
          result = await repo.commitSnapRecovery(captureId);
        } catch (error) {
          const referenced = await repo.getEvent(eventInput.id as string);
          if (referenced?.sourceMediaPath !== mediaPath) {
            try {
              await mediaStore.remove(mediaPath);
              if (!(await mediaStore.verifyRemoved(mediaPath))) {
                throw new Error('The failed Intake Image could not be cleaned up');
              }
            } catch (cleanupError) {
              await repo.markSnapRecoveryFailed(captureId, 'capture-cleanup-failed');
              throw new Error('The failed Intake Image could not be cleaned up', {
                cause: cleanupError,
              });
            }
          }
          await repo.markSnapRecoveryFailed(captureId, 'capture-failed');
          throw error;
        }
        await repo.finalizeSnapRecovery(captureId);
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
      const repo = await repository();
      const jobs = await repo.resumeCloudJobs();
      if (options.cloudHandoff !== undefined) {
        for (const job of jobs) {
          const outcome = await options.cloudHandoff(job);
          if (outcome === 'accepted') await repo.markCloudJobHandedOff(job.id);
        }
      }
      return repo.listCloudJobs();
    },
    async getCapturePreferences() {
      return (await repository()).getCapturePreferences();
    },
    async setCapturePreferences(input) {
      return (await repository()).setCapturePreferences(input);
    },
    async getLocalPreference(key) {
      return (await repository()).getLocalPreference(key);
    },
    async setLocalPreference(key, value) {
      await (await repository()).setLocalPreference(key, value);
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

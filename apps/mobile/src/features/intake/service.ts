import type {
  AnalysisInclusion,
  CreateIntakeEventInput,
  IntakeChange,
  IntakeChangeListener,
  IntakeEvent,
  ServiceClock,
  UpdateIntakeEventInput,
} from '@alyte/domain';
import { openProtectedLabDatabase, type LabRepository } from '../labs/persistence';

export type IntakeMediaStore = {
  remove(path: string): Promise<void>;
};

export type IntakeService = {
  listEvents(): Promise<readonly IntakeEvent[]>;
  listEventsForDay(localDate: string): Promise<readonly IntakeEvent[]>;
  getEvent(id: string): Promise<IntakeEvent | null>;
  createEvent(input: CreateIntakeEventInput): Promise<IntakeEvent>;
  updateEvent(id: string, input: UpdateIntakeEventInput): Promise<IntakeEvent>;
  logAgain(id: string, occurredAt?: string): Promise<IntakeEvent>;
  undoLogAgain(id: string): Promise<void>;
  setAnalysisInclusion(id: string, included: boolean): Promise<IntakeEvent>;
  deleteEvent(id: string): Promise<void>;
  subscribe(listener: IntakeChangeListener): () => void;
};

export type IntakeServiceOptions = {
  readonly repositoryFactory?: () => Promise<LabRepository>;
  readonly clock?: ServiceClock;
  readonly mediaStore?: IntakeMediaStore;
};

export function createIntakeService(options: IntakeServiceOptions = {}): IntakeService {
  let repositoryPromise: Promise<LabRepository> | null = null;
  const repositoryFactory = options.repositoryFactory ?? (() => openProtectedLabDatabase());
  const clock = options.clock ?? { now: () => new Date() };

  async function repository(): Promise<LabRepository> {
    repositoryPromise ??= repositoryFactory();
    return repositoryPromise;
  }

  return {
    async listEvents() {
      return (await repository()).listIntakeEvents();
    },
    async listEventsForDay(localDate) {
      return (await repository()).listIntakeEventsForDay(localDate);
    },
    async getEvent(id) {
      return (await repository()).getIntakeEvent(id);
    },
    async createEvent(input) {
      return (await repository()).createIntakeEvent(input);
    },
    async updateEvent(id, input) {
      return (await repository()).updateIntakeEvent(id, input);
    },
    async logAgain(id, occurredAt) {
      return (await repository()).logAgainEvent(id, occurredAt ?? clock.now().toISOString());
    },
    async undoLogAgain(id) {
      await (await repository()).undoLogAgain(id);
    },
    async setAnalysisInclusion(id, included) {
      const inclusion: AnalysisInclusion = included ? 'included' : 'excluded';
      return (await repository()).setAnalysisInclusion(id, inclusion);
    },
    async deleteEvent(id) {
      const result = await (await repository()).deleteIntakeEvent(id);
      if (result.deleted && result.sourceMediaPath !== null && options.mediaStore !== undefined) {
        await options.mediaStore.remove(result.sourceMediaPath);
      }
    },
    subscribe(listener: IntakeChangeListener): () => void {
      let active = true;
      let unsubscribe: (() => void) | null = null;
      void repository().then((next) => {
        if (active) {
          unsubscribe = next.subscribeToIntakeChanges(listener);
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

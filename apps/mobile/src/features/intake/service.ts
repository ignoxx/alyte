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

export type IntakeMediaStore = {
  remove(path: string): Promise<void>;
  verifyRemoved(path: string): Promise<boolean>;
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
  removeIntakeImage(id: string): Promise<IntakeEvent>;
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
  const repositoryFactory = options.repositoryFactory ?? (() => openProtectedIntakeDatabase());
  const clock = options.clock ?? { now: () => new Date() };

  async function repository(): Promise<IntakeRepository> {
    repositoryPromise ??= repositoryFactory();
    return repositoryPromise;
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

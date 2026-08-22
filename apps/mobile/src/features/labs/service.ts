import type {
  CorrectMeasurementInput,
  CreateLabRecordInput,
  LabRecord,
  Measurement,
  UpdateLabRecordInput,
} from '@alyte/domain';
import { openProtectedLabDatabase, type LabRepository } from './persistence';

export type LabsService = {
  listRecords(): Promise<readonly LabRecord[]>;
  getRecord(id: string): Promise<LabRecord | null>;
  createRecord(input: CreateLabRecordInput): Promise<LabRecord>;
  updateRecord(id: string, input: UpdateLabRecordInput): Promise<LabRecord>;
  correctMeasurement(id: string, input: CorrectMeasurementInput): Promise<Measurement>;
  deleteRecord(id: string): Promise<void>;
};

export type LabsServiceOptions = {
  readonly repositoryFactory?: () => Promise<LabRepository>;
};

export function createLabsService(options: LabsServiceOptions = {}): LabsService {
  let repositoryPromise: Promise<LabRepository> | null = null;
  const repositoryFactory = options.repositoryFactory ?? (() => openProtectedLabDatabase());

  async function repository(): Promise<LabRepository> {
    repositoryPromise ??= repositoryFactory();
    return repositoryPromise;
  }

  return {
    async listRecords() {
      return (await repository()).listRecords();
    },
    async getRecord(id) {
      return (await repository()).getRecord(id);
    },
    async createRecord(input) {
      return (await repository()).createRecord(input);
    },
    async updateRecord(id, input) {
      return (await repository()).updateRecord(id, input);
    },
    async correctMeasurement(id, input) {
      return (await repository()).correctMeasurement(id, input);
    },
    async deleteRecord(id) {
      return (await repository()).deleteRecord(id);
    },
  };
}

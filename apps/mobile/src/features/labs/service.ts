import type {
  ComparableBiomarkerConstraint,
  CorrectMeasurementInput,
  CreateLabRecordInput,
  LabRecord,
  LabRecordDetail,
  Measurement,
  UpdateLabRecordInput,
} from '@alyte/domain';
import { buildLabRecordDetail } from '@alyte/domain';
import { comparableBiomarkers } from '@alyte/catalogue';
import { openProtectedLabDatabase, type LabRepository } from './persistence';
import { createLabReportsService } from './report-service';

export type LabDeletionScope =
  | { readonly kind: 'measurement-only'; readonly measurementId: string }
  | { readonly kind: 'record-only'; readonly recordId: string }
  | { readonly kind: 'source-only'; readonly recordId: string }
  | { readonly kind: 'record-plus-source'; readonly recordId: string };

export type LabDeletionPlan = {
  readonly scope: LabDeletionScope['kind'];
  readonly recordId: string;
  readonly reportId: string | null;
  readonly measurementIdsDeleted: readonly string[];
  readonly linkedRecordIdsAffectedBySourceDeletion: readonly string[];
  readonly recordRemains: boolean;
  readonly sourceRemains: boolean;
};

export type LabsService = {
  listRecords(): Promise<readonly LabRecord[]>;
  getRecord(id: string): Promise<LabRecord | null>;
  getRecordDetail(id: string): Promise<LabRecordDetail | null>;
  createRecord(input: CreateLabRecordInput): Promise<LabRecord>;
  updateRecord(id: string, input: UpdateLabRecordInput): Promise<LabRecord>;
  correctMeasurement(id: string, input: CorrectMeasurementInput): Promise<Measurement>;
  planDeletion(scope: LabDeletionScope): Promise<LabDeletionPlan>;
  executeDeletion(scope: LabDeletionScope): Promise<void>;
  reconcilePendingDeletions(): Promise<void>;
  deleteRecord(id: string): Promise<void>;
};

export type LabsServiceOptions = {
  readonly repositoryFactory?: () => Promise<LabRepository>;
  readonly comparableCatalogue?: readonly ComparableBiomarkerConstraint[];
  readonly deleteSource?: (reportId: string) => Promise<void>;
};

export function createLabsService(options: LabsServiceOptions = {}): LabsService {
  let repositoryPromise: Promise<LabRepository> | null = null;
  let reconciliationPromise: Promise<void> | null = null;
  const repositoryFactory = options.repositoryFactory ?? (() => openProtectedLabDatabase());
  const comparableCatalogue = options.comparableCatalogue ?? comparableBiomarkers;
  const deleteSource = options.deleteSource ?? createLabReportsService().deleteReport;

  async function rawRepository(): Promise<LabRepository> {
    repositoryPromise ??= repositoryFactory();
    return repositoryPromise;
  }

  async function reconcile(repo: LabRepository, preserveAvailability: boolean): Promise<void> {
    for (const operation of await repo.listPendingCombinedDeletions()) {
      try {
        if (operation.state === 'requested') {
          await deleteSource(operation.reportId);
          await repo.markCombinedDeletionSourceComplete(operation.recordId, operation.reportId);
        }
        await repo.deleteRecord(operation.recordId);
        await repo.completeCombinedDeletion(operation.recordId, operation.reportId);
      } catch (error) {
        if (!preserveAvailability) throw error;
      }
    }
  }

  async function repository(): Promise<LabRepository> {
    const repo = await rawRepository();
    reconciliationPromise ??= reconcile(repo, true);
    await reconciliationPromise;
    return repo;
  }

  async function planDeletion(scope: LabDeletionScope): Promise<LabDeletionPlan> {
    const repo = await repository();
    const recordId =
      scope.kind === 'measurement-only'
        ? (await repo.listRecords()).find((record) =>
            record.measurements.some((measurement) => measurement.id === scope.measurementId),
          )?.id
        : scope.recordId;
    if (recordId === undefined) throw new Error('Measurement was not found');
    const record = await repo.getRecord(recordId);
    if (record === null) throw new Error('Lab Record was not found');
    const report = record.labReportId === null ? null : await repo.getReport(record.labReportId);
    if ((scope.kind === 'source-only' || scope.kind === 'record-plus-source') && report === null)
      throw new Error('Lab Record has no source to delete');
    return {
      scope: scope.kind,
      recordId,
      reportId: report?.id ?? null,
      measurementIdsDeleted:
        scope.kind === 'measurement-only'
          ? [scope.measurementId]
          : scope.kind === 'record-only' || scope.kind === 'record-plus-source'
            ? record.measurements.map((measurement) => measurement.id)
            : [],
      linkedRecordIdsAffectedBySourceDeletion:
        scope.kind === 'source-only' || scope.kind === 'record-plus-source'
          ? (report?.labRecordIds ?? []).filter(
              (id) => scope.kind === 'source-only' || id !== recordId,
            )
          : [],
      recordRemains: scope.kind === 'measurement-only' || scope.kind === 'source-only',
      sourceRemains: scope.kind === 'measurement-only' || scope.kind === 'record-only',
    };
  }

  async function executeDeletion(scope: LabDeletionScope): Promise<void> {
    const plan = await planDeletion(scope);
    const repo = await repository();
    if (scope.kind === 'measurement-only') return repo.deleteMeasurement(scope.measurementId);
    if (scope.kind === 'source-only') return deleteSource(plan.reportId!);
    if (scope.kind === 'record-plus-source') {
      await repo.requestCombinedDeletion(plan.recordId, plan.reportId!);
      await deleteSource(plan.reportId!);
      await repo.markCombinedDeletionSourceComplete(plan.recordId, plan.reportId!);
    }
    await repo.deleteRecord(plan.recordId);
    if (scope.kind === 'record-plus-source')
      await repo.completeCombinedDeletion(plan.recordId, plan.reportId!);
  }

  async function reconcilePendingDeletions(): Promise<void> {
    const repo = await rawRepository();
    await reconcile(repo, false);
  }

  return {
    async listRecords() {
      return (await repository()).listRecords();
    },
    async getRecord(id) {
      return (await repository()).getRecord(id);
    },
    async getRecordDetail(id) {
      const repo = await repository();
      const record = await repo.getRecord(id);
      if (record === null) return null;
      if (record.labReportId === null)
        return buildLabRecordDetail(record, { kind: 'manual' }, comparableCatalogue);
      const report = await repo.getReport(record.labReportId);
      const source =
        report?.deletionState === 'requested'
          ? { kind: 'deletion-pending' as const, reportId: record.labReportId }
          : report?.deletionState === 'failed'
            ? { kind: 'deletion-failed' as const, reportId: record.labReportId }
            : report !== null && report.importState !== 'deleted' && report.originalPath !== null
              ? { kind: 'retained' as const, reportId: record.labReportId }
              : { kind: 'deleted' as const, reportId: record.labReportId };
      return buildLabRecordDetail(record, source, comparableCatalogue);
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
    planDeletion,
    executeDeletion,
    reconcilePendingDeletions,
    async deleteRecord(id) {
      return (await repository()).deleteRecord(id);
    },
  };
}

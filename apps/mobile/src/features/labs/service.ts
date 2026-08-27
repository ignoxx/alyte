import type {
  ComparableBiomarkerConstraint,
  CorrectMeasurementInput,
  CreateLabRecordInput,
  LabRecord,
  LabRecordDetail,
  Measurement,
  UpdateLabRecordInput,
} from '@alyte/domain';
import { buildLabRecordDetail, resolveUserMeasurementBiomarker } from '@alyte/domain';
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
  executeDeletion(scope: LabDeletionScope, expectedPlan?: LabDeletionPlan): Promise<void>;
  retryPendingDeletion(recordId: string): Promise<void>;
  reconcilePendingDeletions(): Promise<void>;
  deleteRecord(id: string): Promise<void>;
};

export type LabsServiceOptions = {
  readonly repositoryFactory?: () => Promise<LabRepository>;
  readonly comparableCatalogue?: readonly ComparableBiomarkerConstraint[];
  readonly deleteSource?: (reportId: string) => Promise<void>;
};

function mapUserMeasurement(
  measurement: CreateLabRecordInput['measurements'][number],
  recordSpecimen: CreateLabRecordInput['specimenType'],
  comparableCatalogue: readonly ComparableBiomarkerConstraint[],
) {
  if (measurement.biomarkerId !== undefined || measurement.provenance === 'extracted') {
    return measurement;
  }
  const resolution = resolveUserMeasurementBiomarker(
    {
      label: measurement.label,
      value: measurement.value,
      unit: measurement.unit ?? null,
      specimenType: measurement.specimenType ?? recordSpecimen ?? 'unknown',
      ...(measurement.original === undefined ? {} : { originalLabel: measurement.original.label }),
      ...(measurement.reviewState === undefined ? {} : { reviewState: measurement.reviewState }),
      ...(measurement.source === undefined ? {} : { source: measurement.source }),
    },
    comparableCatalogue,
  );
  return {
    ...measurement,
    biomarkerId: resolution.kind === 'mapped' ? resolution.biomarkerId : null,
  };
}

export function createLabsService(options: LabsServiceOptions = {}): LabsService {
  let repositoryPromise: Promise<LabRepository> | null = null;
  let reconciliationPromise: Promise<void> | null = null;
  const repositoryFactory = options.repositoryFactory ?? (() => openProtectedLabDatabase());
  const comparableCatalogue = options.comparableCatalogue ?? comparableBiomarkers;
  const deleteSource = options.deleteSource ?? createLabReportsService().deleteReport;

  async function rawRepository(): Promise<LabRepository> {
    repositoryPromise ??= repositoryFactory();
    const pending = repositoryPromise;
    try {
      return await pending;
    } catch (error) {
      if (repositoryPromise === pending) repositoryPromise = null;
      throw error;
    }
  }

  async function reconcile(repo: LabRepository, preserveAvailability: boolean): Promise<void> {
    for (const operation of await repo.listPendingCombinedDeletions()) {
      try {
        if (operation.state === 'requested') {
          await deleteSource(operation.reportId);
          await repo.markCombinedDeletionSourceComplete(operation.recordId, operation.reportId);
        }
        await repo.finalizeCombinedDeletion(operation.recordId, operation.reportId);
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
        ? ((await repo.findMeasurementRecordId(scope.measurementId)) ?? undefined)
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

  async function executeDeletion(
    scope: LabDeletionScope,
    expectedPlan?: LabDeletionPlan,
  ): Promise<void> {
    const plan = await planDeletion(scope);
    if (expectedPlan !== undefined && JSON.stringify(plan) !== JSON.stringify(expectedPlan)) {
      throw new Error('Lab deletion plan changed');
    }
    const repo = await repository();
    if (scope.kind === 'measurement-only') return repo.deleteMeasurement(scope.measurementId);
    if (scope.kind === 'source-only') return deleteSource(plan.reportId!);
    if (scope.kind === 'record-plus-source') {
      await repo.requestCombinedDeletion(plan.recordId, plan.reportId!);
      await deleteSource(plan.reportId!);
      await repo.markCombinedDeletionSourceComplete(plan.recordId, plan.reportId!);
    }
    if (scope.kind === 'record-plus-source')
      await repo.finalizeCombinedDeletion(plan.recordId, plan.reportId!);
    else await repo.deleteRecord(plan.recordId);
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
      const mappedInput = {
        ...input,
        measurements: input.measurements.map((measurement) =>
          mapUserMeasurement(measurement, input.specimenType, comparableCatalogue),
        ),
      };
      return (await repository()).createRecord(mappedInput);
    },
    async updateRecord(id, input) {
      return (await repository()).updateRecord(id, input);
    },
    async correctMeasurement(id, input) {
      const repo = await repository();
      if (input.biomarkerId !== undefined) return repo.correctMeasurement(id, input);
      const recordId = await repo.findMeasurementRecordId(id);
      if (recordId === null) return repo.correctMeasurement(id, input);
      const record = await repo.getRecord(recordId);
      const existing = record?.measurements.find((measurement) => measurement.id === id);
      if (existing === undefined) return repo.correctMeasurement(id, input);
      const resolution = resolveUserMeasurementBiomarker(
        {
          label: input.label ?? existing.current.label,
          originalLabel: existing.original.label,
          value: input.value ?? existing.current.value,
          unit: input.unit === undefined ? existing.current.unit : input.unit,
          specimenType: input.specimenType ?? existing.specimenType,
          reviewState: input.reviewState ?? existing.reviewState,
          source: input.source === undefined ? existing.source : input.source,
        },
        comparableCatalogue,
      );
      return repo.correctMeasurement(id, {
        ...input,
        biomarkerId: resolution.kind === 'mapped' ? resolution.biomarkerId : null,
      });
    },
    planDeletion,
    executeDeletion,
    reconcilePendingDeletions,
    async retryPendingDeletion(recordId) {
      const repo = await rawRepository();
      const combined = (await repo.listPendingCombinedDeletions()).find(
        (operation) => operation.recordId === recordId,
      );
      if (combined !== undefined) {
        await reconcile(repo, false);
        return;
      }
      const record = await repo.getRecord(recordId);
      if (record?.labReportId === null || record === null)
        throw new Error('Lab Record has no pending source deletion');
      const report = await repo.getReport(record.labReportId);
      if (report?.deletionState !== 'requested' && report?.deletionState !== 'failed')
        throw new Error('Lab Record has no pending source deletion');
      await deleteSource(report.id);
    },
    async deleteRecord(id) {
      return executeDeletion({ kind: 'record-only', recordId: id });
    },
  };
}
